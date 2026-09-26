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

export function createLocalDeployer(): ApplicationDeployer {
  return {
    async deploy(request, signal) {
      if (signal?.aborted) return { status: 'cancelled', provider: 'local' };
      return {
        status: 'ready',
        provider: 'local',
        externalId: request.buildId,
        url: undefined,
        message: 'Local deployment adapter validated the build workspace.',
        metadata: { workspaceRoot: request.workspaceRoot, environment: request.environment }
      };
    }
  };
}
