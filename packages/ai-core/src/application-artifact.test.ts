import { describe, expect, it } from 'vitest';
import {
  createLocalArtifactPublisher,
  createUnsupportedImageBuilder,
  createWorkspaceArtifactManifest,
  parseDeploymentSource,
  validateApplicationDeploymentSource
} from './application-artifact';

describe('application deployment sources', () => {
  it('accepts workspace, git and image sources', () => {
    expect(() => validateApplicationDeploymentSource({ type: 'workspace', workspaceRoot: '/tmp/app' })).not.toThrow();
    expect(() => validateApplicationDeploymentSource({ type: 'git', repository: 'org/app', revision: 'main' })).not.toThrow();
    expect(() => validateApplicationDeploymentSource({ type: 'image', reference: 'registry.example/app:latest' })).not.toThrow();
  });

  it('rejects unsafe git and image references', () => {
    expect(() => parseDeploymentSource({ type: 'git', repository: 'org/app', revision: '../main' })).toThrow('INVALID_DEPLOYMENT_SOURCE');
    expect(() => parseDeploymentSource({ type: 'image', reference: 'registry/app:tag', digest: 'sha256:bad' })).toThrow('INVALID_DEPLOYMENT_SOURCE');
  });

  it('creates a deterministic artifact manifest', () => {
    const source = { type: 'workspace' as const, workspaceRoot: '/tmp/app' };
    const manifest = createWorkspaceArtifactManifest('project', 'build', source, [
      { path: 'package.json', kind: 'config', contentHash: 'a', sizeBytes: 10 },
      { path: 'src/index.ts', kind: 'source', contentHash: 'b', sizeBytes: 20 }
    ]);
    expect(manifest.totalBytes).toBe(30);
    expect(manifest.contentHash).toBe('package.json:a|src/index.ts:b');
  });

  it('does not claim unsupported transports work', async () => {
    await expect(createUnsupportedImageBuilder().build({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'workspace', workspaceRoot: '/tmp/app' },
      imageName: 'app',
      imageTag: 'build',
    })).rejects.toThrow('IMAGE_BUILD_UNSUPPORTED');

    await expect(createLocalArtifactPublisher().publish({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'git', repository: 'org/app', revision: 'main' },
      files: [],
      manifest: {},
      contentHash: 'hash',
      createdAt: new Date().toISOString()
    })).rejects.toThrow('LOCAL_ARTIFACT_PUBLISHER_REQUIRES_WORKSPACE');
  });
});
