import { describe, expect, it } from 'vitest';
import { validateApplicationWorkerEnvironment } from './application-worker.js';

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
});
