import type { WorkspaceExecutor, WorkspaceProcess } from './workspace-tools';
import { validateApplicationInBrowser } from './browser-validator';

export interface VerificationResult {
  ok: boolean;
  stage: 'install' | 'test' | 'build' | 'runtime' | 'browser';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  diagnostics: string[];
}

export interface BuildVerifier {
  install(signal?: AbortSignal): Promise<VerificationResult>;
  test(signal?: AbortSignal): Promise<VerificationResult>;
  build(signal?: AbortSignal): Promise<VerificationResult>;
  validateRuntime(signal?: AbortSignal): Promise<VerificationResult>;
  validateBrowser(signal?: AbortSignal): Promise<VerificationResult>;
}

export interface BuildVerifierOptions {
  workspace: WorkspaceExecutor;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  cwd?: string;
  testScript?: string;
  buildScript?: string;
  installArgs?: string[];
  runtimePort?: number;
  runtimePath?: string;
  runtimeStartupTimeoutMs?: number;
  runtimePollIntervalMs?: number;
  browserNavigationTimeoutMs?: number;
  browserExecutablePath?: string;
}

const commandFor = (manager: 'npm' | 'pnpm' | 'yarn' | 'bun', script: string) =>
  manager === 'npm' ? { command: 'npm', args: ['run', script] } :
  manager === 'yarn' ? { command: 'yarn', args: [script] } :
  manager === 'bun' ? { command: 'bun', args: ['run', script] } :
  { command: 'pnpm', args: ['run', script] };

const result = (stage: VerificationResult['stage'], exitCode: number, stdout: string, stderr: string): VerificationResult => ({
  ok: exitCode === 0,
  stage,
  exitCode,
  stdout,
  stderr,
  diagnostics: [stderr.trim(), stdout.trim()].filter(Boolean).slice(0, 10)
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitForRuntime(
  process: WorkspaceProcess,
  url: string,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal
): Promise<VerificationResult> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'runtime endpoint not ready';

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      process.kill('SIGTERM');
      throw new Error('WORKSPACE_OPERATION_ABORTED');
    }

    const earlyExit = await Promise.race([
      process.result,
      sleep(pollMs).then(() => undefined)
    ]);

    if (earlyExit) {
      return {
        ok: false,
        stage: 'runtime',
        exitCode: earlyExit.exitCode,
        stdout: earlyExit.stdout,
        stderr: earlyExit.stderr,
        diagnostics: [
          'start process exited before runtime became ready',
          ...[earlyExit.stderr.trim(), earlyExit.stdout.trim()].filter(Boolean)
        ].slice(0, 10)
      };
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(pollMs, 1000)) });
      if (response.status >= 200 && response.status < 500) {
        return {
          ok: true,
          stage: 'runtime',
          diagnostics: ['runtime endpoint ready: ' + response.status + ' ' + url]
        };
      }
      lastError = 'runtime endpoint returned HTTP ' + response.status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: false,
    stage: 'runtime',
    diagnostics: ['runtime health check timed out after ' + timeoutMs + 'ms', lastError]
  };
}

export function createBuildVerifier(options: BuildVerifierOptions): BuildVerifier {
  const manager = options.packageManager ?? 'pnpm';
  const cwd = options.cwd ?? '.';

  const run = async (
    stage: VerificationResult['stage'],
    command: string,
    args: string[],
    signal?: AbortSignal
  ) => {
    const output = await options.workspace.exec({ command, args, cwd, timeoutMs: 120000 }, signal);
    return result(stage, output.exitCode, output.stdout, output.stderr);
  };

  return {
    install(signal) {
      return run('install', manager, options.installArgs ?? (manager === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install']), signal);
    },
    test(signal) {
      const c = commandFor(manager, 'test');
      return run('test', c.command, c.args, signal);
    },
    build(signal) {
      const c = commandFor(manager, 'build');
      return run('build', c.command, c.args, signal);
    },
    async validateBrowser(signal) {
      const c = commandFor(manager, 'start');
      const result = await validateApplicationInBrowser({
        workspace: options.workspace,
        command: c,
        cwd,
        port: options.runtimePort ?? 3000,
        path: options.runtimePath ?? '/',
        startupTimeoutMs: options.runtimeStartupTimeoutMs ?? 10000,
        navigationTimeoutMs: options.browserNavigationTimeoutMs ?? 10000,
        executablePath: options.browserExecutablePath
      }, signal);
      return {
        ok: result.ok,
        stage: 'browser',
        diagnostics: result.diagnostics,
        stdout: result.title,
      };
    }
    async validateRuntime(signal) {
      const starter = options.workspace.startProcess;
      if (!starter) {
        return { ok: false, stage: 'runtime', diagnostics: ['workspace executor does not support long-running processes'] };
      }

      const port = options.runtimePort ?? 3000;
      const startupTimeoutMs = options.runtimeStartupTimeoutMs ?? 10000;
      const pollIntervalMs = options.runtimePollIntervalMs ?? 250;

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, stage: 'runtime', diagnostics: ['invalid runtime port: ' + port] };
      }

      const c = commandFor(manager, 'start');
      let process: WorkspaceProcess | undefined;

      try {
        process = await starter({
          command: c.command,
          args: c.args,
          cwd,
          timeoutMs: startupTimeoutMs,
          env: { PORT: String(port) }
        }, signal);

        return await waitForRuntime(
          process,
          'http://127.0.0.1:' + port + (options.runtimePath ?? '/'),
          startupTimeoutMs,
          pollIntervalMs,
          signal
        );
      } finally {
        process?.kill('SIGTERM');
        void process?.result.catch(() => undefined);
      }
    }
  };
}

export function firstFailure(results: VerificationResult[]): VerificationResult | undefined {
  return results.find(result => !result.ok);
}
