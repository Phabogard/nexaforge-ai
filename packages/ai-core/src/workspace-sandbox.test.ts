import { mkdtemp, rm } from 'node:fs/promises';
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
