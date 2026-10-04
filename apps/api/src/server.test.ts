import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { app } from './server.js';

process.env.MOCK_MODEL = 'true';

describe('NexaForge API Endpoints', () => {
  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns health status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health'
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('nexaforge-api');
  });

  it('POST /api/v1/workspaces/default gets or creates a default workspace', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/default',
      headers: { 'content-type': 'application/json' },
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.workspace).toBeDefined();
    expect(body.workspace.id).toBeDefined();
  });

  it('POST /api/v1/tasks creates a new task and GET /api/v1/tasks/:id reads it', async () => {
    const wsRes = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/default',
      headers: { 'content-type': 'application/json' },
      payload: {}
    });
    const workspaceId = wsRes.json().workspace.id;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        prompt: 'Test prompt for automated suite',
        mode: 'auto',
        workspaceId,
        maxIterations: 5
      }
    });

    expect(createRes.statusCode).toBe(202);
    const task = createRes.json();
    expect(task.id).toBeDefined();
    expect(task.status).toBe('queued');
    expect(task.prompt).toBe('Test prompt for automated suite');

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}`
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = getRes.json();
    expect(fetched.task.id).toBe(task.id);
    expect(fetched.events.length).toBeGreaterThan(0);
  });

  it('POST /api/v1/tasks/:id/cancel cancels an existing task', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        prompt: 'Task to be cancelled',
        mode: 'auto'
      }
    });
    const task = createRes.json();

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/cancel`
    });
    expect(cancelRes.statusCode).toBe(200);
    const cancelled = cancelRes.json();
    expect(cancelled.status).toBe('cancelled');
  });
});
