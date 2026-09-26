import { describe, expect, it, vi } from 'vitest';
import { createDockerImageBuilder, type ContainerCommandExecutor } from './application-image-builder';

function fakeExecutor(outputs: Array<{ exitCode: number; stdout: string; stderr: string }>): ContainerCommandExecutor {
  return { exec: vi.fn(async () => outputs.shift() ?? { exitCode: 1, stdout: '', stderr: 'missing output' }) };
}

describe('docker image builder', () => {
  it('builds a workspace with fixed docker arguments and returns the image id', async () => {
    const executor = fakeExecutor([
      { exitCode: 0, stdout: 'built', stderr: '' },
      { exitCode: 0, stdout: 'sha256:' + 'a'.repeat(64) + '\n', stderr: '' }
    ]);
    const builder = createDockerImageBuilder({ executor });

    const image = await builder.build({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'workspace', workspaceRoot: '/tmp/app' },
      workspaceRoot: '/tmp/app',
      imageName: 'nexaforge/app',
      imageTag: 'build-1'
    });

    expect(image).toEqual({
      reference: 'nexaforge/app:build-1',
      digest: 'sha256:' + 'a'.repeat(64),
      registry: undefined
    });
    expect(executor.exec).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['build', '--file', 'Dockerfile', '--tag', 'nexaforge/app:build-1', '.'],
      '/tmp/app',
      undefined
    );
    expect(executor.exec).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['image', 'inspect', '--format={{.Id}}', 'nexaforge/app:build-1'],
      '/tmp/app',
      undefined
    );
  });

  it('fails when docker is unavailable', async () => {
    const executor: ContainerCommandExecutor = {
      exec: vi.fn(async () => { throw new Error('spawn docker ENOENT'); })
    };
    await expect(createDockerImageBuilder({ executor }).build({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'workspace', workspaceRoot: '/tmp/app' },
      imageName: 'nexaforge/app',
      imageTag: 'build-1'
    })).rejects.toThrow('DOCKER_UNAVAILABLE');
  });

  it('rejects non-workspace sources and unsafe image names', async () => {
    const executor = fakeExecutor([]);
    const builder = createDockerImageBuilder({ executor });
    await expect(builder.build({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'git', repository: 'org/app', revision: 'main' },
      imageName: 'nexaforge/app',
      imageTag: 'build-1'
    })).rejects.toThrow('DOCKER_IMAGE_BUILDER_REQUIRES_WORKSPACE');

    await expect(builder.build({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'workspace', workspaceRoot: '/tmp/app' },
      imageName: 'nexaforge/app;rm',
      imageTag: 'build-1'
    })).rejects.toThrow('INVALID_IMAGE_NAME');
  });

  it('fails closed on a failed docker build', async () => {
    const executor = fakeExecutor([
      { exitCode: 1, stdout: '', stderr: 'Dockerfile syntax error' }
    ]);
    await expect(createDockerImageBuilder({ executor }).build({
      projectId: 'project',
      buildId: 'build',
      source: { type: 'workspace', workspaceRoot: '/tmp/app' },
      imageName: 'nexaforge/app',
      imageTag: 'build-1'
    })).rejects.toThrow('IMAGE_BUILD_FAILED:Dockerfile syntax error');
  });
});
