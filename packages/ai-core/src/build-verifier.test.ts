import { describe, expect, it, vi, afterEach } from 'vitest';
import { createBuildVerifier } from './build-verifier';
import type { WorkspaceExecutor, WorkspaceProcess } from './workspace-tools';

const processFor = (result: Promise<{ exitCode: number; stdout: string; stderr: string }>): WorkspaceProcess => ({
  result,
  kill: vi.fn()
});

const executor = (process: WorkspaceProcess): WorkspaceExecutor => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exec: vi.fn(),
  startProcess: vi.fn(async command => {
    expect(command.command).toBe('npm');
    expect(command.args).toEqual(['run', 'start']);
    expect(command.env?.PORT).toBe('43123');
    return process;
  })
});

afterEach(() => vi.restoreAllMocks());

describe('build verifier runtime validation', () => {
  it('requires an HTTP response before declaring runtime validation successful', async () => {
    const process = processFor(new Promise(() => undefined));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    const verification = await createBuildVerifier({
      workspace: executor(process),
      packageManager: 'npm',
      runtimePort: 43123,
      runtimeStartupTimeoutMs: 100,
      runtimePollIntervalMs: 5
    }).validateRuntime();

    expect(verification.ok).toBe(true);
    expect(verification.stage).toBe('runtime');
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails when the start process exits before the endpoint is ready', async () => {
    const process = processFor(Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: 'startup failed'
    }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const verification = await createBuildVerifier({
      workspace: executor(process),
      packageManager: 'npm',
      runtimePort: 43123,
      runtimeStartupTimeoutMs: 100,
      runtimePollIntervalMs: 5
    }).validateRuntime();

    expect(verification.ok).toBe(false);
    expect(verification.exitCode).toBe(1);
    expect(verification.diagnostics.join('\\n')).toContain('startup failed');
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not treat a startup timeout as success', async () => {
    const process = processFor(new Promise(() => undefined));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const verification = await createBuildVerifier({
      workspace: executor(process),
      packageManager: 'npm',
      runtimePort: 43123,
      runtimeStartupTimeoutMs: 25,
      runtimePollIntervalMs: 5
    }).validateRuntime();

    expect(verification.ok).toBe(false);
    expect(verification.diagnostics.join('\\n')).toContain('runtime health check timed out');
  });
});
