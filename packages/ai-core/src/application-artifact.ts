export type ApplicationDeploymentSource =
  | { type: 'workspace'; workspaceRoot: string }
  | { type: 'git'; repository: string; revision: string; subdirectory?: string }
  | { type: 'image'; reference: string; digest?: string; registry?: string };

export interface ApplicationArtifactFile {
  path: string;
  kind: 'source' | 'config' | 'asset' | 'manifest';
  contentHash: string;
  sizeBytes: number;
}

export interface ApplicationArtifact {
  projectId: string;
  buildId: string;
  source: ApplicationDeploymentSource;
  files: ApplicationArtifactFile[];
  manifest: Record<string, unknown>;
  contentHash: string;
  createdAt: string;
}

export interface ApplicationArtifactPublisher {
  publish(artifact: ApplicationArtifact, signal?: AbortSignal): Promise<ApplicationDeploymentSource>;
}

/**
 * Development adapter: preserves the explicit source contract without claiming
 * that a workspace has been uploaded to a remote transport.
 */
export function createLocalArtifactPublisher(): ApplicationArtifactPublisher {
  return {
    async publish(artifact, signal) {
      validateApplicationDeploymentSource(artifact.source);
      if (signal?.aborted) throw new Error('ARTIFACT_PUBLISH_CANCELLED');
      if (artifact.source.type !== 'workspace') {
        throw new Error('LOCAL_ARTIFACT_PUBLISHER_REQUIRES_WORKSPACE');
      }
      return artifact.source;
    }
  };
}

export interface ApplicationImageBuildRequest {
  projectId: string;
  buildId: string;
  source: ApplicationDeploymentSource;
  workspaceRoot?: string;
  imageName: string;
  imageTag: string;
  port?: number;
}

export interface ApplicationImage {
  reference: string;
  digest?: string;
  registry?: string;
}

export interface ApplicationImageBuilder {
  build(request: ApplicationImageBuildRequest, signal?: AbortSignal): Promise<ApplicationImage>;
}

export function createUnsupportedImageBuilder(): ApplicationImageBuilder {
  return {
    async build(_request, signal) {
      if (signal?.aborted) throw new Error('IMAGE_BUILD_CANCELLED');
      throw new Error('IMAGE_BUILD_UNSUPPORTED: no container builder is configured');
    }
  };
}

const SAFE_GIT_REVISION = /^[A-Za-z0-9._/-]{1,200}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9._:@/-]{1,500}$/;

export function validateApplicationDeploymentSource(source: ApplicationDeploymentSource): void {
  if (!source || typeof source !== 'object' || !('type' in source)) {
    throw new Error('INVALID_DEPLOYMENT_SOURCE');
  }

  if (source.type === 'workspace') {
    if (!source.workspaceRoot || source.workspaceRoot.includes('\\0')) {
      throw new Error('INVALID_DEPLOYMENT_SOURCE');
    }
    return;
  }

  if (source.type === 'git') {
    if (!source.repository || !SAFE_REFERENCE.test(source.repository) || !source.revision || !SAFE_GIT_REVISION.test(source.revision)) {
      throw new Error('INVALID_DEPLOYMENT_SOURCE');
    }
    if (source.subdirectory !== undefined && (!source.subdirectory || source.subdirectory.startsWith('/') || source.subdirectory.split('/').includes('..'))) {
      throw new Error('INVALID_DEPLOYMENT_SOURCE');
    }
    return;
  }

  if (source.type === 'image') {
    if (!source.reference || !SAFE_REFERENCE.test(source.reference)) {
      throw new Error('INVALID_DEPLOYMENT_SOURCE');
    }
    if (source.digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(source.digest)) {
      throw new Error('INVALID_DEPLOYMENT_SOURCE');
    }
    return;
  }

  throw new Error('INVALID_DEPLOYMENT_SOURCE');
}

export function parseDeploymentSource(value: unknown): ApplicationDeploymentSource {
  if (!value || typeof value !== 'object') throw new Error('INVALID_DEPLOYMENT_SOURCE');
  const source = value as ApplicationDeploymentSource;
  validateApplicationDeploymentSource(source);
  return source;
}

export interface ApplicationArtifactManifest {
  projectId: string;
  buildId: string;
  source: ApplicationDeploymentSource;
  files: ApplicationArtifactFile[];
  totalBytes: number;
  contentHash: string;
  createdAt: string;
}

export function hashArtifactFiles(files: ApplicationArtifactFile[]): string {
  return files.map(file => file.path + ':' + file.contentHash).sort().join('|');
}

export function createWorkspaceArtifactManifest(
  projectId: string,
  buildId: string,
  source: Extract<ApplicationDeploymentSource, { type: 'workspace' }>,
  files: ApplicationArtifactFile[],
  createdAt = new Date().toISOString()
): ApplicationArtifactManifest {
  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (files.length === 0) throw new Error('EMPTY_APPLICATION_ARTIFACT');
  if (files.some(file => !file.path || file.path.startsWith('/') || file.path.split('/').includes('..'))) {
    throw new Error('INVALID_APPLICATION_ARTIFACT');
  }
  const contentHash = files
    .map(file => file.path + ':' + file.contentHash)
    .sort()
    .join('|');
  return { projectId, buildId, source, files, totalBytes, contentHash, createdAt };
}
