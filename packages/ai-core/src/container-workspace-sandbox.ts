import type { CommandPolicy, WorkspaceExecutor, WorkspacePathPolicy, WorkspaceProcess } from './workspace-tools';

export interface ContainerSandboxOptions {
  root: string;
  image?: string;
  memoryMb?: number;
  cpus?: number;
  network?: 'none' | 'bridge';
}

const MAX_OUTPUT = 200_000;

function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function dockerCommand(options: ContainerSandboxOptions, command: CommandPolicy): CommandPolicy {
  const image = options.image ?? 'node:22-bookworm-slim';
  const memory = Math.max(128, Math.min(options.memoryMb ?? 1024, 8192));
  const cpus = Math.max(0.25, Math.min(options.cpus ?? 1, 4));
  const network = options.network ?? 'none';
  return {
    command: 'docker',
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
    env: command.env,
    args: [
      'run', '--rm', '-i',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=256',
      '--memory=' + memory + 'm',
      '--cpus=' + cpus,
      '--network=' + network,
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec',
      '--tmpfs=/home/node:rw,nosuid,nodev',
      '--mount', 'type=bind,src=' + options.root + ',dst=/workspace,rw',
      '--workdir=/workspace',
      '-e', 'HOME=/home/node',
      '-e', 'NODE_ENV=production',
      '-e', 'CI=1',
      ...Object.entries(command.env ?? {}).flatMap(([k,v]) => ['-e', k + '=' + v]),
      image,
      ...command.args.length ? ['sh', '-lc', quote(command.command) + ' ' + command.args.map(quote).join(' ')] : ['sh', '-lc', quote(command.command)]
    ]
  };
}

export function createContainerWorkspaceSandbox(options: ContainerSandboxOptions): WorkspaceExecutor & { policy: WorkspacePathPolicy; resolve(path: string): string; validateCommand(command: CommandPolicy): void } {
  const root = options.root;
  const base = {
    policy: { root, allowRead: true, allowWrite: true, allowDelete: true, allowExec: true },
    resolve(path: string) {
      if (!path || path.startsWith('/') || path.includes('..')) throw new Error('WORKSPACE_PATH_INVALID');
      return root + '/' + path;
    },
    validateCommand(command: CommandPolicy) {
      if (!command.command || /[;&|$()<>\\n\\r]/.test(command.command)) throw new Error('WORKSPACE_COMMAND_NOT_ALLOWED');
      for (const arg of command.args) if (/[;|$()<>\\n\\r]/.test(arg)) throw new Error('WORKSPACE_COMMAND_ARGUMENT_BLOCKED');
    }
  };
  return {
    ...base,
    async readFile(path, signal) {
      if (signal?.aborted) throw new Error('WORKSPACE_OPERATION_ABORTED');
      const { readFile } = await import('node:fs/promises');
      return readFile(base.resolve(path), 'utf8');
    },
    async writeFile(path, data, signal) {
      if (signal?.aborted) throw new Error('WORKSPACE_OPERATION_ABORTED');
      const { mkdir, writeFile } = await import('node:fs/promises');
      const target = base.resolve(path);
      await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      await writeFile(target, data, 'utf8');
    },
    async deleteFile(path, signal) {
      if (signal?.aborted) throw new Error('WORKSPACE_OPERATION_ABORTED');
      const { rm } = await import('node:fs/promises');
      await rm(base.resolve(path));
    },
    async exec(command, signal) {
      base.validateCommand(command);
      const { execFile } = await import('node:child_process');
      const child = execFile('docker', dockerCommand(options, command).args, { cwd: root, env: { PATH: process.env.PATH ?? '' } });
      return new Promise((resolve, reject) => {
        let stdout = '', stderr = '';
        child.stdout?.on('data', d => { stdout=(stdout+String(d)).slice(0,MAX_OUTPUT); });
        child.stderr?.on('data', d => { stderr=(stderr+String(d)).slice(0,MAX_OUTPUT); });
        const timer=setTimeout(()=>child.kill('SIGKILL'), command.timeoutMs);
        child.on('error', reject);
        child.on('close', code => { clearTimeout(timer); resolve({exitCode:code??1,stdout,stderr}); });
        signal?.addEventListener('abort',()=>{child.kill('SIGTERM');reject(new Error('WORKSPACE_OPERATION_ABORTED'));},{once:true});
      });
    },
    async startProcess(command, signal) {
      base.validateCommand(command);
      const { spawn } = await import('node:child_process');
      const child = spawn('docker', dockerCommand(options, command).args, { cwd: root, env: { PATH: process.env.PATH ?? '' }, stdio:['ignore','pipe','pipe'] });
      let stdout='',stderr='',settled=false;
      let resolveResult!: (value:{exitCode:number;signal?:string;stdout:string;stderr:string})=>void;
      const result=new Promise<{exitCode:number;signal?:string;stdout:string;stderr:string}>((resolve)=>{resolveResult=resolve;});
      const finish=(value:{exitCode:number;signal?:string;stdout:string;stderr:string})=>{if(!settled){settled=true;resolveResult(value);}};
      child.stdout?.on('data',d=>{stdout=(stdout+String(d)).slice(0,MAX_OUTPUT);});
      child.stderr?.on('data',d=>{stderr=(stderr+String(d)).slice(0,MAX_OUTPUT);});
      child.on('error',()=>finish({exitCode:1,stdout,stderr}));
      child.on('close',(code,sig)=>finish({exitCode:code??1,signal:sig??undefined,stdout,stderr}));
      signal?.addEventListener('abort',()=>{child.kill('SIGTERM');finish({exitCode:143,signal:'SIGTERM',stdout,stderr});},{once:true});
      return { result, kill(sig='SIGTERM'){if(!child.killed) child.kill(sig);} };
    }
  };
}
