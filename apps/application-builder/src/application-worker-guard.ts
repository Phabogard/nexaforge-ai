import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function assertApplicationWorkerIsolation(): void {
  if (process.env.NEXAFORGE_APPLICATION_WORKER_ENABLED !== 'true') return;
  if (process.env.NEXAFORGE_APPLICATION_SANDBOX !== 'container') {
    throw new Error('APPLICATION_WORKER_ISOLATION_REQUIRED');
  }
}

export async function assertDockerDaemonAvailable(
  run: (command: string, args: string[]) => Promise<unknown> = (command, args) =>
    execFileAsync(command, args, { timeout: 10_000 })
): Promise<void> {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}']);
  } catch {
    throw new Error('APPLICATION_DOCKER_DAEMON_REQUIRED');
  }
}
