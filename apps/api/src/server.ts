import Fastify from 'fastify';
import { z } from 'zod';
import { createTaskRepository, type TaskRepository, type TaskRecord } from '@nexaforge/db';
import type { AgentMode } from '@nexaforge/shared';

const app = Fastify({ logger: true });
const memoryTasks = new Map<string, TaskRecord>();
const memoryEvents = new Map<string, Array<{ type: string; payload: unknown; createdAt: string }>>();
const repository: TaskRepository | null = createTaskRepository();

const taskSchema = z.object({
  prompt: z.string().min(1).max(20000),
  mode: z.string().default('auto'),
  workspaceId: z.string().uuid().optional(),
  maxIterations: z.number().int().min(1).max(50).optional(),
  budgetCents: z.number().int().min(0).optional()
});

async function recordEvent(taskId: string, type: string, payload: unknown) {
  const event = { type, payload, createdAt: new Date().toISOString() };
  const events = memoryEvents.get(taskId) ?? [];
  events.push(event);
  memoryEvents.set(taskId, events);
}

app.get('/health', async () => ({ ok: true, service: 'nexaforge-api', persistence: repository ? 'postgres' : 'memory' }));

app.post('/api/v1/tasks', async (request, reply) => {
  const parsed = taskSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  if (repository && !parsed.data.workspaceId) return reply.code(400).send({ error: 'WORKSPACE_REQUIRED' });

  try {
    const task = repository
      ? await repository.create({ prompt: parsed.data.prompt, mode: parsed.data.mode, workspaceId: parsed.data.workspaceId! })
      : (() => {
          const id = crypto.randomUUID();
          const created: TaskRecord = { id, prompt: parsed.data.prompt, mode: parsed.data.mode as AgentMode, status: 'queued', workspaceId: parsed.data.workspaceId ?? 'local-dev', createdAt: new Date().toISOString() };
          memoryTasks.set(id, created);
          return created;
        })();

    await recordEvent(task.id, 'task.queued', { mode: task.mode });
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
    return { task, events: memoryEvents.get(id) ?? [] };
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'TASK_READ_FAILED' });
  }
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
    await recordEvent(id, 'task.cancelled', {});
    return task;
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'TASK_CANCEL_FAILED' });
  }
});

app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' }).catch(error => { app.log.error(error); process.exit(1); });
