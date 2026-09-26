import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { ApplicationImage, ApplicationImageBuildRequest, ApplicationImageBuilder } from './application-artifact';
import { validateApplicationDeploymentSource } from './application-artifact';

export interface ContainerCommandExecutor {
  exec(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

const SAFE_IMAGE_NAME = /^[A-Za-z0-9._/-]{1,200}$/;
const SAFE_IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MAX_OUTPUT = 200_000;

function createDefaultExecutor(): ContainerCommandExecutor {
  return {
    exec(command, args, cwd, signal) {
      return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
          cwd: resolve(cwd),
          shell: false,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '/tmp',
            DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? ''
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (value: { exitCode: number; stdout: string; stderr: string }) => {
          if (!settled) {
            settled = true;
            resolvePromise(value);
          }
        };
        const fail = (error: Error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        };

        const onAbort = () => {
          child.kill('SIGTERM');
          fail(new Error('IMAGE_BUILD_CANCELLED'));
        };

        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(0, MAX_OUTPUT); });
        child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, MAX_OUTPUT); });
        child.on('error', error => {
          signal?.removeEventListener('abort', onAbort);
          fail(error);
        });
        child.on('close', code => {
          signal?.removeEventListener('abort', onAbort);
          finish({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    }
  };
}

export interface DockerImageBuilderOptions {
  executor?: ContainerCommandExecutor;
  dockerExecutable?: string;
}

export function createDockerImageBuilder(options: DockerImageBuilderOptions = {}): ApplicationImageBuilder {
  const executor = options.executor ?? createDefaultExecutor();
  const dockerExecutable = options.dockerExecutable ?? 'docker';

  return {
    async build(request: ApplicationImageBuildRequest, signal?: AbortSignal): Promise<ApplicationImage> {
      validateApplicationDeploymentSource(request.source);
      if (request.source.type !== 'workspace') {
        throw new Error('DOCKER_IMAGE_BUILDER_REQUIRES_WORKSPACE');
      }
      if (signal?.aborted) throw new Error('IMAGE_BUILD_CANCELLED');
      if (!SAFE_IMAGE_NAME.test(request.imageName)) throw new Error('INVALID_IMAGE_NAME');
      if (!SAFE_IMAGE_TAG.test(request.imageTag)) throw new Error('INVALID_IMAGE_TAG');

      const workspaceRoot = resolve(request.workspaceRoot ?? request.source.workspaceRoot);
      const reference = request.registry
        ? `${request.registry.replace(/\\/$/, '')}/${request.imageName}:${request.imageTag}`
        : `${request.imageName}:${request.imageTag}`;

      if (!SAFE_IMAGE_NAME.test(reference.replace(/:[A-Za-z0-9_.-]+$/, ''))) {
        throw new Error('INVALID_IMAGE_REFERENCE');
      }

      let buildOutput: Awaited<ReturnType<ContainerCommandExecutor['exec']>>;
      try {
        buildOutput = await executor.exec(
          dockerExecutable,
          ['build', '--file', 'Dockerfile', '--tag', reference, '.'],
          workspaceRoot,
          signal
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'IMAGE_BUILD_CANCELLED') throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('ENOENT')) throw new Error('DOCKER_UNAVAILABLE');
        throw new Error(`IMAGE_BUILD_EXECUTION_FAILED:${message}`);
      }

      if (buildOutput.exitCode !== 0) {
        throw new Error(`IMAGE_BUILD_FAILED:${buildOutput.stderr.trim() || buildOutput.stdout.trim() || 'docker build failed'}`);
      }

      let inspectOutput: Awaited<ReturnType<ContainerCommandExecutor['exec']>>;
      try {
        inspectOutput = await executor.exec(
          dockerExecutable,
          ['image', 'inspect', '--format={{.Id}}', reference],
          workspaceRoot,
          signal
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'IMAGE_BUILD_CANCELLED') throw error;
        throw new Error(`IMAGE_INSPECT_FAILED:${error instanceof Error ? error.message : String(error)}`);
      }

      if (inspectOutput.exitCode !== 0) {
        throw new Error(`IMAGE_INSPECT_FAILED:${inspectOutput.stderr.trim() || 'unable to inspect built image'}`);
      }

      const imageId = inspectOutput.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
        throw new Error('IMAGE_ID_INVALID');
      }

      return { reference, digest: imageId, registry: request.registry };
    }
  };
}
