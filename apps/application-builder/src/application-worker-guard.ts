export function assertApplicationWorkerIsolation(): void {
  if (process.env.NEXAFORGE_APPLICATION_WORKER_ENABLED !== 'true') return;
  if (process.env.NEXAFORGE_APPLICATION_SANDBOX !== 'container') {
    throw new Error('APPLICATION_WORKER_ISOLATION_REQUIRED');
  }
}
