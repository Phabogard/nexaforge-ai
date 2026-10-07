import { describe, expect, it } from 'vitest';
import { validateApplicationWorkerEnvironment } from './application-worker.js';
import { assertDockerDaemonAvailable } from './application-worker-guard.js';

describe('ApplicationBuildWorker isolation policy', () => {
  it('fails closed when production worker is enabled without container isolation', () => {
    expect(validateApplicationWorkerEnvironment({
      nodeEnv: 'production',
      enabled: 'true',
      sandbox: 'disabled',
      isolated: 'false'
    })).toBe('APPLICATION_WORKER_ISOLATION_REQUIRED');
  });

  it('fails closed when image build is requested without container sandbox', () => {
    expect(validateApplicationWorkerEnvironment({
      nodeEnv: 'development',
      enabled: 'true',
      sandbox: 'disabled',
      isolated: 'false',
      imageBuild: 'true'
    })).toBe('APPLICATION_SANDBOX_CONTAINER_REQUIRED');
  });

  it('allows an explicitly isolated container worker', () => {
    expect(validateApplicationWorkerEnvironment({
      nodeEnv: 'production',
      enabled: 'true',
      sandbox: 'container',
      isolated: 'true',
      imageBuild: 'true',
      imagePush: 'true'
    })).toBeNull();
  });

  it('allows the default disabled production configuration', () => {
    expect(validateApplicationWorkerEnvironment({
      nodeEnv: 'production',
      enabled: 'false',
      sandbox: 'disabled',
      isolated: 'false'
    })).toBeNull();
  });

  it('accepts a reachable Docker daemon', async () => {
    await expect(
      assertDockerDaemonAvailable(async (command, args) => {
        expect(command).toBe('docker');
        expect(args).toEqual(['version', '--format', '{{.Server.Version}}']);
      })
    ).resolves.toBeUndefined();
  });

  it('fails closed when Docker daemon is unavailable', async () => {
    await expect(
      assertDockerDaemonAvailable(async () => {
        throw new Error('daemon unavailable');
      })
    ).rejects.toThrow('APPLICATION_DOCKER_DAEMON_REQUIRED');
  });
});
