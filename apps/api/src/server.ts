import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTaskRepository, type TaskRepository, type TaskRecord, type TaskEventRecord } from '@nexaforge/db';
import type { AgentMode } from '@nexaforge/shared';
import { configuredWorker, type TaskWorker } from './task-worker.js';

export const app = Fastify({ logger: true });
const isProduction = process.env.NODE_ENV === 'production';

const memoryTasks = new Map<string, TaskRecord>();
const memoryEvents = new Map<string, TaskEventRecord[]>();

export const repository: TaskRepository | null = createTaskRepository();

if (isProduction && !repository) {
  app.log.error('DATABASE_URL is required in production mode. Memory fallback is strictly disabled.');
  process.exit(1);
}

export const worker: TaskWorker | null = repository ? configuredWorker(repository) : null;

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
const DEFAULT_DEV_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

async function recordEvent(taskId: string, type: string, payload: unknown) {
  if (repository) return repository.addEvent(taskId, type, payload);
  const event: TaskEventRecord = { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
  const events = memoryEvents.get(taskId) ?? [];
  events.push(event);
  memoryEvents.set(taskId, events);
  return event;
}

const allowedOrigin = process.env.WEB_APP_URL ? process.env.WEB_APP_URL.replace(/\/$/, '') : true;
app.register(cors, { origin: allowedOrigin, credentials: true });

app.get('/health', async (request, reply) => {
  let dbOk = false;
  if (repository) {
    dbOk = await repository.ping();
  }
  if (isProduction && (!repository || !dbOk)) {
    return reply.code(503).send({
      ok: false,
      service: 'nexaforge-api',
      persistence: repository ? 'postgres_unhealthy' : 'missing',
      worker: worker ? 'running' : 'disabled'
    });
  }
  return {
    ok: dbOk || (!repository && !isProduction),
    service: 'nexaforge-api',
    persistence: repository ? (dbOk ? 'postgres' : 'postgres_unhealthy') : 'memory',
    worker: worker ? 'running' : 'disabled'
  };
});

const handleDefaultWorkspace = async (request: any, reply: any) => {
  try {
    if (repository) {
      const workspace = await repository.getOrCreateDefaultWorkspace();
      return reply.code(200).send({ workspace });
    }
    const workspace = { id: DEFAULT_DEV_WORKSPACE_ID, name: 'NexaForge Local Workspace', ownerId: 'local-owner', createdAt: new Date().toISOString() };
    return reply.code(200).send({ workspace });
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'WORKSPACE_GET_OR_CREATE_FAILED' });
  }
};

app.get('/api/v1/workspaces/default', handleDefaultWorkspace);
app.post('/api/v1/workspaces/default', handleDefaultWorkspace);

app.post('/api/v1/dev/bootstrap', async (request, reply) => {
  if (isProduction) return reply.code(404).send({ error: 'NOT_FOUND' });
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

app.post('/api/v1/tasks', async (request, reply) => {
  const parsed = taskSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });

  let workspaceId: string = parsed.data.workspaceId ?? '';
  if (!workspaceId) {
    if (repository) {
      const defaultWs = await repository.getOrCreateDefaultWorkspace();
      workspaceId = defaultWs.id;
    } else {
      workspaceId = DEFAULT_DEV_WORKSPACE_ID;
    }
  } else if (repository && !(await repository.workspaceExists(workspaceId))) {
    return reply.code(404).send({ error: 'WORKSPACE_NOT_FOUND' });
  }

  try {
    const task = repository
      ? await repository.create({ prompt: parsed.data.prompt, mode: parsed.data.mode, workspaceId, maxIterations: parsed.data.maxIterations, budgetCents: parsed.data.budgetCents })
      : (() => {
          const id = randomUUID();
          const created: TaskRecord = {
            id, prompt: parsed.data.prompt, mode: parsed.data.mode as AgentMode, status: 'queued',
            workspaceId, maxIterations: parsed.data.maxIterations,
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
  const reqOrigin = request.headers.origin || '*';
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': reqOrigin,
    'Access-Control-Allow-Credentials': 'true'
  });

  let closed = false;
  const seenEventIds = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    request.raw.off('close', cleanup);
    if (!response.destroyed) response.end();
  };

  request.raw.on('close', cleanup);

  const send = (event: string, data: unknown, evtId?: string) => {
    if (closed || response.destroyed) return;
    if (evtId) response.write(`id: ${evtId}\n`);
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
        if (seenEventIds.has(event.id)) continue;
        seenEventIds.add(event.id);
        send(event.type, event.payload, event.id);
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
  await app.close();
};

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

if (process.env.NODE_ENV !== 'test') {
  app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' }).then(async () => {
    if (repository) {
      const pingOk = await repository.ping();
      if (pingOk) {
        app.log.info('Connected to PostgreSQL/Neon database successfully.');
      } else {
        app.log.error('Failed to ping PostgreSQL/Neon database on startup.');
        if (isProduction) process.exit(1);
      }
    } else {
      app.log.warn('Running with in-memory store (DEVELOPMENT ONLY).');
    }
    worker?.start();
  }).catch(error => { app.log.error(error); process.exit(1); });
}
