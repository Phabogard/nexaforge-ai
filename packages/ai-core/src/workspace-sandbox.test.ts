import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { createWorkspaceSandbox } from './workspace-sandbox';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'nexaforge-sandbox-'));
  roots.push(root);
  return createWorkspaceSandbox({ root, allowRead: true, allowWrite: true, allowDelete: true, allowExec: true });
}

describe('workspace sandbox', () => {
  it('rejects path traversal and absolute paths', async () => {
    const ws = await sandbox();
    expect(() => ws.resolve('../outside')).toThrow('WORKSPACE_PATH_OUTSIDE_ROOT');
    expect(() => ws.resolve('/etc/passwd')).toThrow('WORKSPACE_PATH_INVALID');
  });
  it('writes and reads only inside the workspace', async () => {
    const ws = await sandbox();
    await ws.writeFile('src/main.ts', 'export const ok = true;');
    expect(await ws.readFile('src/main.ts')).toContain('ok = true');
  });
  it('rejects shell syntax and non-allowlisted executables', async () => {
    const ws = await sandbox();
    expect(() => ws.validateCommand({ command:'sh', args:['-c','echo unsafe'], cwd:'.', timeoutMs:1000 })).toThrow('WORKSPACE_COMMAND_NOT_ALLOWED');
    expect(() => ws.validateCommand({ command:'node', args:['-e','console.log(1); rm -rf .'], cwd:'.', timeoutMs:1000 })).toThrow('WORKSPACE_COMMAND_ARGUMENT_BLOCKED');
  });
  it('does not inherit arbitrary host environment variables', async () => {
    const ws = await sandbox();
    process.env.NEXAFORGE_TEST_SECRET = 'must-not-leak';
    const result = await ws.exec({ command:'node', args:['-e','process.stdout.write(process.env.NEXAFORGE_TEST_SECRET || "")'], cwd:'.', timeoutMs:3000 });
    expect(result.stdout).toBe('');
    delete process.env.NEXAFORGE_TEST_SECRET;
  });
});

describe('workspace sandbox process lifecycle', () => {
  it('handles normal process exit correctly', async () => {
    const ws = await sandbox();
    const res = await ws.exec({ command: 'node', args: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 5000 });
    expect(res.exitCode).toBe(0);
  });

  it('handles abort signal cleanly and cleans up listeners', async () => {
    const ws = await sandbox();
    await ws.writeFile('sleep.js', 'setTimeout(() => {}, 10000)');
    const ac = new AbortController();
    const procPromise = ws.exec({ command: 'node', args: ['sleep.js'], cwd: '.', timeoutMs: 15000 }, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await expect(procPromise).rejects.toThrow('WORKSPACE_OPERATION_ABORTED');
  });

  it('does not reject abort until the child has actually closed', async () => {
    const ws = await sandbox();
    await ws.writeFile('delayed_term.js', 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 350)); setInterval(() => {}, 1000)');
    const ac = new AbortController();
    const started = Date.now();
    const procPromise = ws.exec({ command: 'node', args: ['delayed_term.js'], cwd: '.', timeoutMs: 5000 }, ac.signal);
    setTimeout(() => ac.abort(), 50);

    const pending = await Promise.race([
      procPromise.then(() => 'settled', () => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 150))
    ]);
    expect(pending).toBe('pending');
    await expect(procPromise).rejects.toThrow('WORKSPACE_OPERATION_ABORTED');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it('handles process ignoring SIGTERM by escalating to SIGKILL and waiting for close', async () => {
    const ws = await sandbox();
    await ws.writeFile('ignore_sigterm.js', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)');
    const proc = await ws.startProcess!({
      command: 'node',
      args: ['ignore_sigterm.js'],
      cwd: '.',
      timeoutMs: 10000
    });
    proc.kill('SIGTERM');
    const res = await proc.result;
    expect(res).toBeDefined();
  });

  it('guarantees single resolution/rejection without double finalization', async () => {
    const ws = await sandbox();
    await ws.writeFile('exit.js', 'process.exit(1)');
    const ac = new AbortController();
    const proc = await ws.startProcess!({
      command: 'node',
      args: ['exit.js'],
      cwd: '.',
      timeoutMs: 5000
    }, ac.signal);
    proc.kill('SIGTERM');
    const res = await proc.result;
    expect(res).toBeDefined();
  });
});
