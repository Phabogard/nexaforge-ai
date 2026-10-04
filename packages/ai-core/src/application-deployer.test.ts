import { describe, expect, it, vi } from 'vitest';
import { createRenderImageDeployer } from './application-deployer';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('Render image deployer', () => {
  it('creates an image-backed service, waits for live, then health-checks it', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const http = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/services?')) {
        return response([]);
      }
      if (url.endsWith('/services')) {
        return response({
          service: { id: 'srv-1', serviceDetails: { url: 'https://app.example.com' } },
          deployId: 'dep-1'
        });
      }
      if (url.endsWith('/services/srv-1/deploys/dep-1')) {
        return response({ status: 'live' });
      }
      if (url === 'https://app.example.com/') return response({ ok: true });
      throw new Error('unexpected request');
    });

    const result = await createRenderImageDeployer({
      apiKey: 'rnd_test',
      ownerId: 'own_test',
      timeoutMs: 100,
      http
    }).deploy({
      projectId: 'project-12345678',
      buildId: 'build-1',
      source: {
        type: 'image',
        reference: 'registry.example.com/nexaforge/app:build-1',
        digest: 'sha256:' + 'a'.repeat(64)
      },
      environment: 'production',
      name: 'My App'
    });

    expect(result.status).toBe('ready');
    expect(result.externalId).toBe('srv-1:dep-1');
    expect(result.url).toBe('https://app.example.com');

    expect(calls[0].url).toContain('/services?');
    expect(calls[1].url).toBe('https://api.render.com/v1/services');
    const payload = JSON.parse(String(calls[1].init?.body));
    expect(payload.type).toBe('web_service');
    expect(payload.image.imagePath).toBe('registry.example.com/nexaforge/app:build-1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(payload.autoDeploy).toBe('no');
    expect(payload.ownerId).toBe('own_test');
    expect(payload.serviceDetails).toEqual({
      buildPlan: 'free',
      region: 'oregon',
      healthCheckPath: '/'
    });
    expect(calls.at(-1)?.url).toBe('https://app.example.com/');
  });


  it('reuses an existing deterministic service after worker recovery', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const http = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/services?')) {
        return response([{ service: { id: 'srv-existing', name: 'app-project-deploy', imagePath: 'registry/app:build' } }]);
      }
      if (url.endsWith('/services/srv-existing/deploys')) {
        return response({ id: 'dep-retry' }, 201);
      }
      if (url.endsWith('/services/srv-existing/deploys/dep-retry')) {
        return response({ status: 'live' });
      }
      if (url === 'https://app.example.com/') return response({ ok: true });
      throw new Error('unexpected request');
    });

    const result = await createRenderImageDeployer({
      apiKey: 'rnd_test',
      ownerId: 'own_test',
      timeoutMs: 100,
      http
    }).deploy({
      projectId: 'project',
      buildId: 'build',
      deploymentId: 'deploy-123',
      source: { type: 'image', reference: 'registry/app:build' },
      environment: 'production',
      name: 'app'
    });

    expect(result.status).toBe('ready');
    expect(result.externalId).toBe('srv-existing:dep-retry');
    expect(calls.some(call => call.url.endsWith('/services'))).toBe(false);
    expect(calls[1].url).toBe('https://api.render.com/v1/services/srv-existing/deploys');
  });

  it('fails closed when Render reports a terminal deploy failure', async () => {
    const http = vi.fn(async (url: string) => {
      if (url.endsWith('/services')) return response({ service: { id: 'srv-1' }, deployId: 'dep-1' });
      return response({ status: 'build_failed' });
    });

    const result = await createRenderImageDeployer({
      apiKey: 'rnd_test',
      ownerId: 'own_test',
      timeoutMs: 100,
      http
    }).deploy({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'image', reference: 'registry.example.com/app:build' },
      environment: 'production',
      name: 'app'
    });

    expect(result.status).toBe('failed');
    expect(result.message).toBe('RENDER_DEPLOY_BUILD_FAILED');
  });

  it('requires credentials and an image source', async () => {
    await expect(createRenderImageDeployer({ ownerId: 'own' }).deploy({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'image', reference: 'registry/app:build' },
      environment: 'production',
      name: 'app'
    })).rejects.toThrow('RENDER_API_KEY_NOT_CONFIGURED');

    await expect(createRenderImageDeployer({
      apiKey: 'key',
      ownerId: 'own',
      http: vi.fn()
    }).deploy({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'workspace', workspaceRoot: '/tmp/app' },
      environment: 'production',
      name: 'app'
    })).rejects.toThrow('RENDER_REQUIRES_IMAGE_SOURCE');
  });

  it('cancels the Render deploy when aborted', async () => {
    const controller = new AbortController();
    let cancelCalled = false;
    const http = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/services')) return response({ service: { id: 'srv-1' }, deployId: 'dep-1' });
      if (url.endsWith('/cancel')) {
        cancelCalled = init?.method === 'POST';
        return response({});
      }
      controller.abort();
      return response({ status: 'deploying' });
    });

    const result = await createRenderImageDeployer({
      apiKey: 'key',
      ownerId: 'own',
      timeoutMs: 100,
      http
    }).deploy({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'image', reference: 'registry/app:build' },
      environment: 'production',
      name: 'app'
    }, controller.signal);

    expect(result.status).toBe('cancelled');
    expect(cancelCalled).toBe(true);
  });
});
