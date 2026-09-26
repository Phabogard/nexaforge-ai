import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTaskRepository, createApplicationRepository, type TaskRepository, type TaskRecord, type TaskEventRecord } from '@nexaforge/db';
import type { AgentMode } from '@nexaforge/shared';
import { configuredWorker, type TaskWorker } from './task-worker';
import { ApplicationBuildWorker } from './application-worker';
import { ApplicationDeploymentWorker } from './deployment-worker';

const app = Fastify({ logger: true });
const memoryTasks = new Map<string, TaskRecord>();
const memoryEvents = new Map<string, TaskEventRecord[]>();
const repository: TaskRepository | null = createTaskRepository();
const worker: TaskWorker | null = repository ? configuredWorker(repository) : null;
const applicationRepository = createApplicationRepository();
const applicationWorker = applicationRepository ? new ApplicationBuildWorker(applicationRepository) : null;
const deploymentWorker = applicationRepository ? new ApplicationDeploymentWorker(applicationRepository) : null;

const taskSchema = z.object({
  prompt: z.string().min(1).max(20000),
  mode: z.string().default('auto'),
  workspaceId: z.string().uuid().optional(),
  maxIterations: z.number().int().min(1).max(50).default(12),
  budgetCents: z.number().int().min(0).optional()
});

const bootstrapSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120).optional(),
  workspaceName: z.string().min(1).max(120).optional()
});

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

async function recordEvent(taskId: string, type: string, payload: unknown) {
  if (repository) return repository.addEvent(taskId, type, payload);
  const event: TaskEventRecord = { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
  const events = memoryEvents.get(taskId) ?? [];
  events.push(event);
  memoryEvents.set(taskId, events);
  return event;
}

app.register(cors, { origin: process.env.WEB_APP_URL ?? 'http://localhost:3000' });
app.get('/health', async () => ({ ok: true, service: 'nexaforge-api', persistence: repository ? 'postgres' : 'memory', worker: worker ? 'running' : 'disabled' }));

app.post('/api/v1/dev/bootstrap', async (request, reply) => {
  if (process.env.NODE_ENV === 'production') return reply.code(404).send({ error: 'NOT_FOUND' });
  if (!repository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const parsed = bootstrapSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  try {
    const workspace = await repository.createWorkspace(parsed.data);
    return reply.code(201).send({ workspace });
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'BOOTSTRAP_FAILED' });
  }
});

const applicationCreateSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
});
const applicationBuildSchema = z.object({
  prompt: z.string().min(1).max(20000),
  maxIterations: z.number().int().min(1).max(50).default(12),
  maxRepairAttempts: z.number().int().min(0).max(10).default(3),
});

app.post('/api/v1/applications', async (request, reply) => {
  if (!applicationRepository || !repository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const parsed=applicationCreateSchema.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST',details:parsed.error.flatten()});
  if(!(await repository.workspaceExists(parsed.data.workspaceId))) return reply.code(404).send({error:'WORKSPACE_NOT_FOUND'});
  try{return reply.code(201).send(await applicationRepository.createProject(parsed.data));}
  catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_CREATE_FAILED'});}
});

app.post('/api/v1/applications/:id/builds', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const {id}=request.params as {id:string};
  const parsed=applicationBuildSchema.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST',details:parsed.error.flatten()});
  if(!(await applicationRepository.getProject(id)))return reply.code(404).send({error:'APPLICATION_NOT_FOUND'});
  try{return reply.code(202).send(await applicationRepository.createBuild({projectId:id,request:parsed.data}));}
  catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_BUILD_CREATE_FAILED'});}
});

app.post('/api/v1/applications/:id/deployments', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const { id } = request.params as { id: string };
  const project = await applicationRepository.getProject(id);
  if (!project) return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });

  const body = z.object({
    buildId: z.string().uuid(),
    provider: z.enum(['local','render']).default('local'),
    environment: z.string().min(1).max(64).default('production'),
    port: z.number().int().min(1).max(65535).optional(),
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('workspace'), workspaceRoot: z.string().min(1).max(500) }),
      z.object({ type: z.literal('git'), repository: z.string().min(1).max(500), revision: z.string().min(1).max(200), subdirectory: z.string().min(1).max(240).optional() }),
      z.object({ type: z.literal('image'), reference: z.string().min(1).max(500), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), registry: z.string().max(300).optional() })
    ]).optional()
  }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: 'INVALID_REQUEST', details: body.error.flatten() });

  const build = await applicationRepository.getBuild(body.data.buildId);
  if (!build || build.projectId !== id) return reply.code(404).send({ error: 'APPLICATION_BUILD_NOT_FOUND' });
  if (build.status !== 'completed' || build.phase !== 'completed') {
    return reply.code(409).send({ error: 'BUILD_NOT_DEPLOYABLE', status: build.status, phase: build.phase });
  }

  const deployment = await applicationRepository.createDeployment({
    projectId: project.id,
    buildId: build.id,
    provider: body.data.provider,
    environment: body.data.environment,
    metadata: { requestedPort: body.data.port ?? null, source: body.data.source ?? (build.result && typeof build.result === 'object' && 'deploymentSource' in build.result ? (build.result as {deploymentSource?: unknown}).deploymentSource ?? null : null) }
  });
  await applicationRepository.addBuildEvent({
    buildId: build.id,
    eventType: 'deployment.queued',
    phase: 'deploying',
    payload: { deploymentId: deployment.id, provider: body.data.provider, environment: body.data.environment }
  });

  return reply.code(202).send(deployment);
});

app.get('/api/v1/applications/:id/deployments', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const { id } = request.params as { id: string };
  if (!(await applicationRepository.getProject(id))) return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
  return { deployments: await applicationRepository.listDeployments(id) };
});

app.get('/api/v1/application-deployments/:id', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const { id } = request.params as { id: string };
  const deployment = await applicationRepository.getDeployment(id);
  if (!deployment) return reply.code(404).send({ error: 'DEPLOYMENT_NOT_FOUND' });
  return deployment;
});

app.post('/api/v1/application-deployments/:id/cancel', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const { id } = request.params as { id: string };
  const deployment = await applicationRepository.getDeployment(id);
  if (!deployment) return reply.code(404).send({ error: 'DEPLOYMENT_NOT_FOUND' });
  if (['ready', 'failed', 'cancelled'].includes(deployment.status)) return reply.code(409).send({ error: 'DEPLOYMENT_TERMINAL', status: deployment.status });
  deploymentWorker?.cancel(id);
  const updated = await applicationRepository.updateDeployment(id, { status: 'cancelled', metadata: { reason: 'user_request' } });
  if (deployment.buildId) {
    await applicationRepository.addBuildEvent({
      buildId: deployment.buildId,
      eventType: 'deployment.cancelled',
      phase: 'cancelled',
      payload: { deploymentId: id, reason: 'user_request' }
    });
  }
  return updated;
});

app.get('/api/v1/applications/:id', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const {id}=request.params as {id:string};
  const project=await applicationRepository.getProject(id);
  if(!project)return reply.code(404).send({error:'APPLICATION_NOT_FOUND'});
  return project;
});

app.get('/api/v1/application-builds/:id', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const {id}=request.params as {id:string};
  const build=await applicationRepository.getBuild(id);
  if(!build)return reply.code(404).send({error:'APPLICATION_BUILD_NOT_FOUND'});
  return build;
});


app.get('/api/v1/application-builds/:id/events', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const { id } = request.params as { id: string };
  if (!(await applicationRepository.getBuild(id))) return reply.code(404).send({ error: 'APPLICATION_BUILD_NOT_FOUND' });
  return { events: await applicationRepository.listBuildEvents(id) };
});

app.get('/api/v1/application-builds/:id/stream', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const { id } = request.params as { id: string };
  const initial = await applicationRepository.getBuild(id);
  if (!initial) return reply.code(404).send({ error: 'APPLICATION_BUILD_NOT_FOUND' });

  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let cursor = 0;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    request.raw.off('close', cleanup);
    if (!response.destroyed) response.end();
  };
  request.raw.on('close', cleanup);

  const send = (event: string, data: unknown, id?: string) => {
    if (closed || response.destroyed) return;
    if (id) response.write(`id: ${id}\n`);
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('build.snapshot', initial, initial.id);

  const tick = async () => {
    if (closed) return;
    try {
      const build = await applicationRepository.getBuild(id);
      if (!build) {
        send('error', { error: 'APPLICATION_BUILD_NOT_FOUND' });
        cleanup();
        return;
      }
      const events = await applicationRepository.listBuildEvents(id);
      for (const event of events.slice(cursor)) {
        send(event.eventType, event.payload, event.id);
      }
      cursor = events.length;
      send('build.snapshot', build, build.id);
      if (terminalStatuses.has(build.status) || build.phase === 'waiting_approval') {
        send('done', { status: build.status, phase: build.phase, buildId: build.id });
        cleanup();
        return;
      }
    } catch (error) {
      send('error', { error: error instanceof Error ? error.message : 'STREAM_FAILED' });
    }
    if (!closed) timer = setTimeout(() => { void tick(); }, 500);
  };
  void tick();
});

app.post('/api/v1/application-builds/:id/cancel', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const { id } = request.params as { id: string };
  const build = await applicationRepository.getBuild(id);
  if (!build) return reply.code(404).send({ error: 'APPLICATION_BUILD_NOT_FOUND' });
  applicationWorker?.cancel(id);
  const updated = await applicationRepository.updateBuild(id, { status: 'cancelled', phase: 'cancelled', errorCode: 'CANCELLED_BY_USER' });
  await applicationRepository.addBuildEvent({ buildId: id, eventType: 'build.cancelled', phase: 'cancelled', payload: { reason: 'user_request' } });
  return updated;
});

app.post('/api/v1/application-builds/:id/approve', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const { id } = request.params as { id: string };
  const build = await applicationRepository.getBuild(id);
  if (!build) return reply.code(404).send({ error: 'APPLICATION_BUILD_NOT_FOUND' });
  const approval = await applicationRepository.decideApproval(id, 'execution', 'approved');
  if (!approval) return reply.code(409).send({ error: 'APPROVAL_NOT_FOUND' });
  const updated = await applicationRepository.updateBuild(id, { status: 'queued', phase: 'queued' });
  await applicationRepository.addBuildEvent({ buildId: id, eventType: 'approval.granted', phase: 'queued', payload: { stepKey: 'execution' } });
  return { build: updated, approval };
});

app.post('/api/v1/application-builds/:id/reject', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const { id } = request.params as { id: string };
  const build = await applicationRepository.getBuild(id);
  if (!build) return reply.code(404).send({ error: 'APPLICATION_BUILD_NOT_FOUND' });
  const approval = await applicationRepository.decideApproval(id, 'execution', 'rejected');
  if (!approval) return reply.code(409).send({ error: 'APPROVAL_NOT_FOUND' });
  const updated = await applicationRepository.updateBuild(id, { status: 'failed', phase: 'failed', errorCode: 'APPROVAL_REJECTED' });
  await applicationRepository.addBuildEvent({ buildId: id, eventType: 'approval.rejected', phase: 'failed', payload: { stepKey: 'execution' } });
  return { build: updated, approval };
});

app.post('/api/v1/tasks', async (request, reply) => {
  const parsed = taskSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  if (repository && !parsed.data.workspaceId) return reply.code(400).send({ error: 'WORKSPACE_REQUIRED' });
  if (repository && parsed.data.workspaceId && !(await repository.workspaceExists(parsed.data.workspaceId))) {
    return reply.code(404).send({ error: 'WORKSPACE_NOT_FOUND' });
  }

  try {
    const task = repository
      ? await repository.create({ prompt: parsed.data.prompt, mode: parsed.data.mode, workspaceId: parsed.data.workspaceId!, maxIterations: parsed.data.maxIterations, budgetCents: parsed.data.budgetCents })
      : (() => {
          const id = randomUUID();
          const created: TaskRecord = {
            id, prompt: parsed.data.prompt, mode: parsed.data.mode as AgentMode, status: 'queued',
            workspaceId: parsed.data.workspaceId ?? 'local-dev', maxIterations: parsed.data.maxIterations,
            budgetCents: parsed.data.budgetCents ?? null, result: undefined, errorCode: null, iterationCount: 0,
            createdAt: new Date().toISOString(), completedAt: null
          };
          memoryTasks.set(id, created);
          return created;
        })();

    await recordEvent(task.id, 'task.queued', { mode: task.mode, maxIterations: task.maxIterations, budgetCents: task.budgetCents ?? null });
    return reply.code(202).send(task);
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'TASK_CREATE_FAILED' });
  }
});

app.get('/api/v1/tasks/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const task = repository ? await repository.get(id) : memoryTasks.get(id) ?? null;
    if (!task) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
    const events = repository ? await repository.listEvents(id) : memoryEvents.get(id) ?? [];
    return { task, events };
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'TASK_READ_FAILED' });
  }
});

app.get('/api/v1/tasks/:id/events', async (request, reply) => {
  const { id } = request.params as { id: string };
  const task = repository ? await repository.get(id) : memoryTasks.get(id) ?? null;
  if (!task) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
  return { events: repository ? await repository.listEvents(id) : memoryEvents.get(id) ?? [] };
});

app.get('/api/v1/tasks/:id/stream', async (request, reply) => {
  const { id } = request.params as { id: string };
  const initialTask = repository ? await repository.get(id) : memoryTasks.get(id) ?? null;
  if (!initialTask) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });

  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let closed = false;
  let lastEventId = '';
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    request.raw.off('close', cleanup);
    if (!response.destroyed) response.end();
  };

  request.raw.on('close', cleanup);

  const send = (event: string, data: unknown, id?: string) => {
    if (closed || response.destroyed) return;
    if (id) response.write(`id: ${id}\n`);
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('task.snapshot', initialTask, initialTask.id);

  const tick = async () => {
    if (closed) return;
    try {
      const task = repository ? await repository.get(id) : memoryTasks.get(id) ?? null;
      if (!task) {
        send('error', { error: 'TASK_NOT_FOUND' });
        cleanup();
        return;
      }

      const events = repository ? await repository.listEvents(id) : memoryEvents.get(id) ?? [];
      for (const event of events) {
        if (lastEventId && event.id === lastEventId) continue;
        if (lastEventId) {
          const previousIndex = events.findIndex(item => item.id === lastEventId);
          const currentIndex = events.findIndex(item => item.id === event.id);
          if (previousIndex >= 0 && currentIndex <= previousIndex) continue;
        }
        send(event.type, event.payload, event.id);
        lastEventId = event.id;
      }

      send('task.snapshot', task, task.id);
      if (terminalStatuses.has(task.status)) {
        send('done', { status: task.status, taskId: task.id });
        cleanup();
        return;
      }
    } catch (error) {
      send('error', { error: error instanceof Error ? error.message : 'STREAM_FAILED' });
    }

    if (!closed) timer = setTimeout(() => { void tick(); }, 500);
  };

  void tick();
});

app.post('/api/v1/tasks/:id/cancel', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const task = repository
      ? await repository.updateStatus(id, 'cancelled')
      : (() => {
          const existing = memoryTasks.get(id);
          if (!existing) return null;
          const cancelled = { ...existing, status: 'cancelled', completedAt: new Date().toISOString() };
          memoryTasks.set(id, cancelled);
          return cancelled;
        })();
    if (!task) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
    worker?.cancel(id);
    await recordEvent(id, 'task.cancelled', {});
    return task;
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'TASK_CANCEL_FAILED' });
  }
});

const shutdown = async () => {
  worker?.stop();
  applicationWorker?.stop();
  deploymentWorker?.stop();
  await app.close();
};

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' }).then(() => {
  worker?.start();
  applicationWorker?.start();
}).catch(error => { app.log.error(error); process.exit(1); });
