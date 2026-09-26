import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CommandPolicy, WorkspaceExecutor, WorkspacePathPolicy, WorkspaceSandbox, WorkspaceProcess } from './workspace-tools';

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

function processRunner(command: CommandPolicy, cwd: string, signal?: AbortSignal): WorkspaceProcess {
  const child = spawn(command.command, command.args, {
    cwd,
    shell: false,
    env: { PATH: process.env.PATH ?? '', HOME: cwd, NODE_ENV: 'production', CI: '1', ...(command.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '', settled = false;
  let resolveResult!: (result: { exitCode: number; signal?: string; stdout: string; stderr: string }) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<{ exitCode: number; signal?: string; stdout: string; stderr: string }>((resolvePromise, reject) => {
    resolveResult = resolvePromise;
    rejectResult = reject;
  });
  const finish = (value: { exitCode: number; signal?: string; stdout: string; stderr: string }) => { if (!settled) { settled = true; resolveResult(value); } };
  const fail = (error: Error) => { if (!settled) { settled = true; rejectResult(error); } };
  const onAbort = () => { child.kill('SIGTERM'); fail(new Error('WORKSPACE_OPERATION_ABORTED')); };
  signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(0, MAX_OUTPUT); });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, MAX_OUTPUT); });
  child.on('error', error => { signal?.removeEventListener('abort', onAbort); fail(error); });
  child.on('close', (code, closeSignal) => {
    signal?.removeEventListener('abort', onAbort);
    finish({ exitCode: code ?? 1, signal: closeSignal ?? undefined, stdout, stderr });
  });
  return {
    result,
    kill(signalName = 'SIGTERM') { if (!child.killed) child.kill(signalName); }
  };
}

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
      for (const arg of command.args) if (BLOCKED_ARGS.has(arg) || /[;&|$()<>\\n\\r]/.test(arg)) throw new Error('WORKSPACE_COMMAND_ARGUMENT_BLOCKED');
      if (command.env) for (const [key, value] of Object.entries(command.env)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\\0\\n\\r]/.test(value)) throw new Error('WORKSPACE_ENV_INVALID');
      }
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
      const child = processRunner(command, ensureInside(root, command.cwd), signal);
      const timer = setTimeout(() => child.kill('SIGKILL'), command.timeoutMs);
      try {
        const output = await child.result;
        clearTimeout(timer);
        return { exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr };
      } catch (error) {
        clearTimeout(timer);
        throw error;
      }
    },
    async startProcess(command, signal) {
      assertSignal(signal); this.validateCommand(command);
      return processRunner(command, ensureInside(root, command.cwd), signal);
    }
  };
}
