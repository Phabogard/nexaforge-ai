import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApplicationRepository } from '@nexaforge/db';
import { createLocalDeployer, createRenderImageDeployer, parseDeploymentSource } from '@nexaforge/ai-core';

export class ApplicationDeploymentWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private readonly enabled = process.env.NEXAFORGE_DEPLOYMENT_WORKER_ENABLED === 'true';
  private readonly cancelled = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly workerId = `deployment-worker-${process.pid}-${randomUUID()}`;
  private readonly leaseSeconds = 60;
  private readonly concurrency = Math.max(1, Number(process.env.NEXAFORGE_DEPLOYMENT_WORKER_CONCURRENCY ?? '2') || 2);
  private active = 0;

  constructor(private readonly repository: ApplicationRepository, private readonly pollMs = 1000) {
    if (this.enabled) this.schedule();
  }

  cancel(deploymentId: string) {
    this.cancelled.add(deploymentId);
    this.controllers.get(deploymentId)?.abort();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule() {
    if (this.stopped || !this.enabled) return;
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
  }

  private async tick() {
    if (this.stopped || !this.enabled) return;
    if (this.running) return this.schedule();
    this.running = true;
    try {
      while (!this.stopped && this.active < this.concurrency) {
        const deployment = await this.repository.claimNextDeployment(this.workerId, this.leaseSeconds);
        if (!deployment) break;
        this.active++;
        void this.process(deployment).finally(() => { this.active--; });
      }
    } catch (error) {
      console.error('[nexaforge-deployment-worker]', error);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async process(deployment: Awaited<ReturnType<ApplicationRepository['claimNextDeployment']>> extends infer T ? Exclude<T, null> : never) {
    const controller = new AbortController();
    this.controllers.set(deployment.id, controller);
    const heartbeat = setInterval(() => { void this.repository.renewDeploymentLease(deployment.id, this.workerId, this.leaseSeconds).catch(() => {}); }, 20000);
    const buildId = deployment.buildId;
    try {
      const project = await this.repository.getProject(deployment.projectId);
      if (!project) {
        await this.repository.updateDeployment(deployment.id, { status: 'failed', metadata: { error: 'APPLICATION_NOT_FOUND' } });
        return;
      }

      const metadata = (deployment.metadata ?? {}) as Record<string, unknown>;
      let source;
      try {
        source = metadata.source
          ? parseDeploymentSource(metadata.source)
          : { type: 'workspace' as const, workspaceRoot: join(process.env.APPLICATION_WORKSPACE_ROOT ?? '/tmp/nexaforge-projects', deployment.projectId) };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'INVALID_DEPLOYMENT_SOURCE';
        await this.repository.updateDeployment(deployment.id, { status: 'failed', metadata: { error: message } });
        return;
      }

      if (this.cancelled.has(deployment.id)) {
        await this.repository.updateDeployment(deployment.id, { status: 'cancelled', metadata: { reason: 'cancelled_before_start' } });
        return;
      }

      const provider = deployment.provider === 'local' ? createLocalDeployer() : deployment.provider === 'render' ? createRenderImageDeployer() : null;
      if (!provider) throw new Error('UNSUPPORTED_DEPLOYMENT_PROVIDER');

      const result = await provider.deploy({
        projectId: deployment.projectId,
        buildId: buildId ?? deployment.id,
        deploymentId: deployment.id,
        source,
        environment: deployment.environment,
        name: project.name,
        port: typeof metadata.requestedPort === 'number' ? metadata.requestedPort : undefined
      }, controller.signal);

      const latest = await this.repository.getDeployment(deployment.id);
      if (!latest || latest.status === 'cancelled') return;

      await this.repository.updateDeployment(deployment.id, {
        status: result.status,
        externalId: result.externalId,
        url: result.url,
        metadata: { ...metadata, ...(result.metadata ?? {}), message: result.message }
      });

      if (buildId) {
        await this.repository.addBuildEvent({
          buildId,
          eventType: result.status === 'ready' ? 'deployment.ready' : 'deployment.failed',
          phase: result.status === 'ready' ? 'completed' : 'failed',
          payload: { deploymentId: deployment.id, provider: result.provider, message: result.message }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'DEPLOYMENT_FAILED';
      await this.repository.updateDeployment(deployment.id, { status: 'failed', metadata: { ...((deployment.metadata ?? {}) as Record<string, unknown>), error: message } });
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(deployment.id);
      this.cancelled.delete(deployment.id);
    }
  }
}
