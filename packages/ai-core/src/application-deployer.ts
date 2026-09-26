export type DeploymentStatus = 'queued' | 'deploying' | 'ready' | 'failed' | 'cancelled';

export interface ApplicationDeploymentRequest {
  projectId: string;
  buildId: string;
  workspaceRoot: string;
  environment: string;
  name: string;
  port?: number;
}

export interface ApplicationDeploymentResult {
  status: DeploymentStatus;
  provider: string;
  externalId?: string;
  url?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ApplicationDeployer {
  deploy(request: ApplicationDeploymentRequest, signal?: AbortSignal): Promise<ApplicationDeploymentResult>;
  cancel?(externalId: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Development-only adapter. It deliberately does not claim that an application
 * is running: the workspace has not been published to an application host.
 */
export function createLocalDeployer(): ApplicationDeployer {
  return {
    async deploy(request, signal) {
      if (signal?.aborted) return { status: 'cancelled', provider: 'local' };
      return {
        status: 'failed',
        provider: 'local',
        externalId: request.buildId,
        message: 'LOCAL_DEPLOYMENT_UNSUPPORTED: no application server is attached to the local workspace.',
        metadata: { workspaceRoot: request.workspaceRoot, environment: request.environment }
      };
    }
  };
}
