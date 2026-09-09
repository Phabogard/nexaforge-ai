import Fastify from 'fastify';
import { z } from 'zod';
import type { AgentMode } from '@nexaforge/shared';

const app = Fastify({ logger: true });
const tasks = new Map<string, { id: string; prompt: string; mode: AgentMode; status: string; createdAt: string }>();

const taskSchema = z.object({
  prompt: z.string().min(1).max(20000),
  mode: z.string().default('auto'),
  workspaceId: z.string().optional()
});

app.get('/health', async () => ({ ok: true, service: 'nexaforge-api' }));

app.post('/api/v1/tasks', async (request, reply) => {
  const parsed = taskSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });

  const id = crypto.randomUUID();
  const task = { id, prompt: parsed.data.prompt, mode: parsed.data.mode as AgentMode, status: 'queued', createdAt: new Date().toISOString() };
  tasks.set(id, task);
  return reply.code(202).send(task);
});

app.get('/api/v1/tasks/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const task = tasks.get(id);
  if (!task) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
  return task;
});

app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' }).catch(error => { app.log.error(error); process.exit(1); });
