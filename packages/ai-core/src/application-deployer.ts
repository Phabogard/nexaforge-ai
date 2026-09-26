import type { ApplicationDeploymentSource } from './application-artifact';

export type DeploymentStatus = 'queued' | 'deploying' | 'ready' | 'failed' | 'cancelled';

export interface ApplicationDeploymentRequest {
  projectId: string;
  buildId: string;
  source: ApplicationDeploymentSource;
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
        status: 'failed',
        provider: 'local',
        externalId: request.buildId,
        message: 'LOCAL_DEPLOYMENT_UNSUPPORTED',
        metadata: { sourceType: request.source.type, environment: request.environment }
      };
    }
  };
}
