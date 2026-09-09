import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTaskRepository, type TaskRepository, type TaskRecord, type TaskEventRecord } from '@nexaforge/db';
import type { AgentMode } from '@nexaforge/shared';
import { configuredWorker, type TaskWorker } from './task-worker';
import { can, extractBearer, signToken, verifyToken, type AuthUser, type Role } from './auth';

const app = Fastify({ logger: true });
const memoryTasks = new Map<string, TaskRecord>();
const memoryEvents = new Map<string, TaskEventRecord[]>();
const repository: TaskRepository | null = createTaskRepository();
const worker: TaskWorker | null = repository ? configuredWorker(repository) : null;
const taskSchema = z.object({ prompt: z.string().min(1).max(20000), mode: z.string().default('auto'), workspaceId: z.string().uuid().optional(), maxIterations: z.number().int().min(1).max(50).default(12), budgetCents: z.number().int().min(0).optional() });
const bootstrapSchema = z.object({ email: z.string().email(), displayName: z.string().min(1).max(120).optional(), workspaceName: z.string().min(1).max(120).optional() });
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

declare module 'fastify' { interface FastifyRequest { authUser?: AuthUser } }

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractBearer(request.headers.authorization);
  if (!token) { await reply.code(401).send({ error: 'AUTH_REQUIRED' }); return; }
  try { request.authUser = verifyToken(token); } catch (error) { await reply.code(401).send({ error: error instanceof Error ? error.message : 'INVALID_TOKEN' }); }
}

async function requireWorkspaceRole(request: FastifyRequest, reply: FastifyReply, workspaceId: string, minimum: Role): Promise<boolean> {
  const user = request.authUser;
  if (!user) { await reply.code(401).send({ error: 'AUTH_REQUIRED' }); return false; }
  if (user.role === 'owner' && !repository) return true;
  if (!repository) { await reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' }); return false; }
  const membership = await repository.getMembership(workspaceId, user.id);
  if (!membership || !can(membership.role as Role, minimum)) { await reply.code(403).send({ error: 'FORBIDDEN' }); return false; }
  return true;
}

async function recordEvent(taskId: string, type: string, payload: unknown) { if (repository) return repository.addEvent(taskId, type, payload); const event: TaskEventRecord = { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() }; const events = memoryEvents.get(taskId) ?? []; events.push(event); memoryEvents.set(taskId, events); return event; }

app.register(cors, { origin: process.env.WEB_APP_URL ?? 'http://localhost:3000' });
app.get('/health', async () => ({ ok: true, service: 'nexaforge-api', persistence: repository ? 'postgres' : 'memory', worker: worker ? 'running' : 'disabled' }));

app.post('/api/v1/auth/dev-login', async (request, reply) => {
  if (process.env.NODE_ENV === 'production') return reply.code(404).send({ error: 'NOT_FOUND' });
  if (!repository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const parsed = bootstrapSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  try {
    const workspace = await repository.createWorkspace(parsed.data);
    const user = await repository.getUser(workspace.ownerId);
    if (!user) return reply.code(500).send({ error: 'USER_NOT_FOUND' });
    const token = signToken({ id: user.id, email: user.email, role: user.role as Role });
    return reply.code(200).send({ token, user, workspace });
  } catch (error) { request.log.error(error); return reply.code(500).send({ error: 'LOGIN_FAILED' }); }
});

app.post('/api/v1/dev/bootstrap', async (request, reply) => {
  if (process.env.NODE_ENV === 'production') return reply.code(404).send({ error: 'NOT_FOUND' });
  if (!repository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' });
  const parsed = bootstrapSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  try { const workspace = await repository.createWorkspace(parsed.data); return reply.code(201).send({ workspace }); } catch (error) { request.log.error(error); return reply.code(500).send({ error: 'BOOTSTRAP_FAILED' }); }
});

app.get('/api/v1/me', { preHandler: authenticate }, async request => ({ user: request.authUser }));

app.post('/api/v1/tasks', { preHandler: authenticate }, async (request, reply) => {
  const parsed = taskSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  if (!parsed.data.workspaceId) return reply.code(400).send({ error: 'WORKSPACE_REQUIRED' });
  if (!(await requireWorkspaceRole(request, reply, parsed.data.workspaceId, 'member'))) return;
  try {
    const task = repository ? await repository.create({ prompt: parsed.data.prompt, mode: parsed.data.mode, workspaceId: parsed.data.workspaceId, maxIterations: parsed.data.maxIterations, budgetCents: parsed.data.budgetCents }) : (() => { const id = randomUUID(); const created: TaskRecord = { id, prompt: parsed.data.prompt, mode: parsed.data.mode as AgentMode, status: 'queued', workspaceId: parsed.data.workspaceId!, maxIterations: parsed.data.maxIterations, budgetCents: parsed.data.budgetCents ?? null, result: undefined, errorCode: null, iterationCount: 0, createdAt: new Date().toISOString(), completedAt: null }; memoryTasks.set(id, created); return created; })();
    await recordEvent(task.id, 'task.queued', { mode: task.mode, maxIterations: task.maxIterations, budgetCents: task.budgetCents ?? null });
    return reply.code(202).send(task);
  } catch (error) { request.log.error(error); return reply.code(500).send({ error: 'TASK_CREATE_FAILED' }); }
});

app.get('/api/v1/tasks/:id', { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  try { const task = repository ? await repository.get(id) : memoryTasks.get(id) ?? null; if (!task) return reply.code(404).send({ error: 'TASK_NOT_FOUND' }); if (!(await requireWorkspaceRole(request, reply, task.workspaceId, 'viewer'))) return; const events = repository ? await repository.listEvents(id) : memoryEvents.get(id) ?? []; const approvals = repository ? await repository.listApprovals(id) : []; return { task, events, approvals }; } catch (error) { request.log.error(error); return reply.code(500).send({ error: 'TASK_READ_FAILED' }); }
});

app.get('/api/v1/tasks/:id/events', { preHandler: authenticate }, async (request, reply) => { const { id } = request.params as { id: string }; const task = repository ? await repository.get(id) : memoryTasks.get(id) ?? null; if (!task) return reply.code(404).send({ error: 'TASK_NOT_FOUND' }); if (!(await requireWorkspaceRole(request, reply, task.workspaceId, 'viewer'))) return; return { events: repository ? await repository.listEvents(id) : memoryEvents.get(id) ?? [] }; });

app.get('/api/v1/tasks/:id/stream', { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string }; const initialTask = repository ? await repository.get(id) : memoryTasks.get(id) ?? null; if (!initialTask) return reply.code(404).send({ error: 'TASK_NOT_FOUND' }); if (!(await requireWorkspaceRole(request, reply, initialTask.workspaceId, 'viewer'))) return;
  reply.hijack(); const response = reply.raw; response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no-cache' }); let closed = false; let lastEventId = ''; let timer: NodeJS.Timeout | undefined;
  const cleanup = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); request.raw.off('close', cleanup); if (!response.destroyed) response.end(); }; request.raw.on('close', cleanup);
  const send = (event: string, data: unknown, eventId?: string) => { if (closed || response.destroyed) return; if (eventId) response.write(`id: ${eventId}\n`); response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  send('task.snapshot', initialTask, initialTask.id);
  const tick = async () => { if (closed) return; try { const task = repository ? await repository.get(id) : memoryTasks.get(id) ?? null; if (!task) { send('error', { error: 'TASK_NOT_FOUND' }); cleanup(); return; } const events = repository ? await repository.listEvents(id) : memoryEvents.get(id) ?? []; let afterLast = !lastEventId; for (const event of events) { if (event.id === lastEventId) { afterLast = true; continue; } if (!afterLast) continue; send(event.type, event.payload, event.id); lastEventId = event.id; } send('task.snapshot', task, task.id); if (terminalStatuses.has(task.status)) { send('done', { status: task.status, taskId: task.id }); cleanup(); return; } } catch (error) { send('error', { error: error instanceof Error ? error.message : 'STREAM_FAILED' }); } if (!closed) timer = setTimeout(() => { void tick(); }, 500); }; void tick();
});

app.get('/api/v1/tasks/:id/approvals', { preHandler: authenticate }, async (request, reply) => { const { id } = request.params as { id: string }; if (!repository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' }); const task = await repository.get(id); if (!task) return reply.code(404).send({ error: 'TASK_NOT_FOUND' }); if (!(await requireWorkspaceRole(request, reply, task.workspaceId, 'viewer'))) return; return { approvals: await repository.listApprovals(id) }; });

app.post('/api/v1/approvals/:id/decision', { preHandler: authenticate }, async (request, reply) => { if (!repository) return reply.code(503).send({ error: 'DATABASE_NOT_CONFIGURED' }); const { id } = request.params as { id: string }; const parsed = z.object({ status: z.enum(['approved', 'rejected']) }).safeParse(request.body); if (!parsed.success || !request.authUser) return reply.code(400).send({ error: 'INVALID_REQUEST' }); const approvalRows = await repository.listApprovals((await repository.getUser(request.authUser.id)) ? id : id); void approvalRows; const approval = await repository.decideApproval(id, request.authUser.id, parsed.data.status); if (!approval) return reply.code(409).send({ error: 'APPROVAL_NOT_PENDING' }); const task = await repository.get(approval.taskId); if (task) await repository.addEvent(task.id, 'approval.decided', { approvalId: approval.id, status: approval.status, decidedBy: request.authUser.id }); return approval; });

app.post('/api/v1/tasks/:id/cancel', { preHandler: authenticate }, async (request, reply) => { const { id } = request.params as { id: string }; try { const existing = repository ? await repository.get(id) : memoryTasks.get(id) ?? null; if (!existing) return reply.code(404).send({ error: 'TASK_NOT_FOUND' }); if (!(await requireWorkspaceRole(request, reply, existing.workspaceId, 'member'))) return; const task = repository ? await repository.updateStatus(id, 'cancelled') : (() => { const cancelled = { ...existing, status: 'cancelled', completedAt: new Date().toISOString() }; memoryTasks.set(id, cancelled); return cancelled; })(); worker?.cancel(id); await recordEvent(id, 'task.cancelled', {}); return task; } catch (error) { request.log.error(error); return reply.code(500).send({ error: 'TASK_CANCEL_FAILED' }); } });

const shutdown = async () => { worker?.stop(); await app.close(); }; process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); }); process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' }).then(() => { worker?.start(); }).catch(error => { app.log.error(error); process.exit(1); });
