import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CommandPolicy, WorkspaceExecutor, WorkspacePathPolicy, WorkspaceSandbox } from './workspace-tools';

const MAX_OUTPUT = 200_000;
const SAFE_EXECUTABLES = new Set(['bun','bunx','git','node','npm','npx','pnpm','pnpm.cmd','python','python3','pip','pip3','tsc','tsx','vitest','vite','next','eslint','prettier']);
const BLOCKED_ARGS = new Set(['--delete','--hard','--mirror','--force-with-lease']);

function ensureInside(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('WORKSPACE_PATH_OUTSIDE_ROOT');
  return resolvedTarget;
}
function assertSignal(signal?: AbortSignal) { if (signal?.aborted) throw new Error('WORKSPACE_OPERATION_ABORTED'); }

export function createWorkspaceSandbox(policy: WorkspacePathPolicy): WorkspaceSandbox & WorkspaceExecutor {
  const root = resolve(policy.root);
  return {
    policy,
    resolve(relativePath) {
      if (!relativePath || isAbsolute(relativePath)) throw new Error('WORKSPACE_PATH_INVALID');
      return ensureInside(root, relativePath);
    },
    validateCommand(command: CommandPolicy) {
      if (!policy.allowExec) throw new Error('WORKSPACE_EXEC_DENIED');
      if (!command.command || !SAFE_EXECUTABLES.has(command.command)) throw new Error('WORKSPACE_COMMAND_NOT_ALLOWED');
      ensureInside(root, command.cwd);
      if (command.timeoutMs < 1 || command.timeoutMs > 120000) throw new Error('WORKSPACE_COMMAND_TIMEOUT_INVALID');
      for (const arg of command.args) if (BLOCKED_ARGS.has(arg) || /[;&|`$()<>\n\r]/.test(arg)) throw new Error('WORKSPACE_COMMAND_ARGUMENT_BLOCKED');
    },
    async readFile(path, signal) {
      if (!policy.allowRead) throw new Error('WORKSPACE_READ_DENIED');
      assertSignal(signal); return readFile(ensureInside(root, path), 'utf8');
    },
    async writeFile(path, content, signal) {
      if (!policy.allowWrite) throw new Error('WORKSPACE_WRITE_DENIED');
      assertSignal(signal); const target = ensureInside(root, path);
      await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content, 'utf8');
    },
    async deleteFile(path, signal) {
      if (!policy.allowDelete) throw new Error('WORKSPACE_DELETE_DENIED');
      assertSignal(signal); await rm(ensureInside(root, path), { recursive: false, force: false });
    },
    async exec(command, signal) {
      assertSignal(signal); this.validateCommand(command);
      const cwd = ensureInside(root, command.cwd);
      return new Promise((resolvePromise, reject) => {
        const child = spawn(command.command, command.args, { cwd, shell: false, env: { PATH: process.env.PATH ?? '', HOME: cwd, NODE_ENV: 'production', CI: '1' }, stdio: ['ignore','pipe','pipe'] });
        let stdout = '', stderr = '', settled = false;
        const finish = (value: { exitCode: number; stdout: string; stderr: string }) => { if (!settled) { settled = true; resolvePromise(value); } };
        const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
        const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('WORKSPACE_COMMAND_TIMEOUT')); }, command.timeoutMs);
        const onAbort = () => { child.kill('SIGTERM'); fail(new Error('WORKSPACE_OPERATION_ABORTED')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(0, MAX_OUTPUT); });
        child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, MAX_OUTPUT); });
        child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fail(error); });
        child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); finish({ exitCode: code ?? 1, stdout, stderr }); });
      });
    }
  };
}