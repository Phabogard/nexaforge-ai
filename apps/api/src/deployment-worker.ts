import { join } from 'node:path';
import type { ApplicationRepository } from '@nexaforge/db';
import { createLocalDeployer, parseDeploymentSource } from '@nexaforge/ai-core';

export class ApplicationDeploymentWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private readonly cancelled = new Set<string>();

  constructor(private readonly repository: ApplicationRepository, private readonly pollMs = 1000) {
    this.schedule();
  }

  cancel(deploymentId: string) {
    this.cancelled.add(deploymentId);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
  }

  private async tick() {
    if (this.stopped) return;
    if (this.running) return this.schedule();
    this.running = true;
    try {
      const deployment = await this.repository.claimNextDeployment();
      if (deployment) await this.process(deployment);
    } catch {
      // Keep the worker alive.
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async process(deployment: Awaited<ReturnType<ApplicationRepository['claimNextDeployment']>> extends infer T ? Exclude<T, null> : never) {
    const buildId = deployment.buildId;
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

    try {
      const provider = deployment.provider === 'local' ? createLocalDeployer() : null;
      if (!provider) throw new Error('UNSUPPORTED_DEPLOYMENT_PROVIDER');

      const result = await provider.deploy({
        projectId: deployment.projectId,
        buildId: buildId ?? deployment.id,
        source,
        environment: deployment.environment,
        name: project.name,
        port: typeof metadata.requestedPort === 'number' ? metadata.requestedPort : undefined
      });

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
      await this.repository.updateDeployment(deployment.id, { status: 'failed', metadata: { ...metadata, error: message } });
    } finally {
      this.cancelled.delete(deployment.id);
    }
  }
}
