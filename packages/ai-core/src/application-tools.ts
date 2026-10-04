import type { Tool } from './index.js';
import type { BuildVerifier } from './build-verifier.js';
import type { WorkspaceExecutor } from './workspace-tools.js';

export interface ApplicationToolset { tools: Tool[]; names: string[]; }
export interface ApplicationToolDependencies {
  workspace: WorkspaceExecutor;
  verifier: BuildVerifier;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  cwd?: string;
  phase?: 'coding' | 'repair';
}

const commandFor = (manager: ApplicationToolDependencies['packageManager'], script: string) => {
  const m = manager ?? 'pnpm';
  if (m === 'npm') return { command: 'npm', args: ['run', script] };
  if (m === 'yarn') return { command: 'yarn', args: [script] };
  if (m === 'bun') return { command: 'bun', args: ['run', script] };
  return { command: 'pnpm', args: ['run', script] };
};

export function createApplicationTools(deps: ApplicationToolDependencies): ApplicationToolset {
  const cwd = deps.cwd ?? '.';
  const toolPhase = deps.phase ?? 'coding';

  const tools: Tool[] = [
    { name:'filesystem.read', description:'Read a file inside the project workspace', risk:'low', async execute(input, context) {
      const value=input as {path?:string}; if(!value.path) throw new Error('FILESYSTEM_PATH_REQUIRED');
      return deps.workspace.readFile(value.path, context.signal);
    }},
    { name:'filesystem.write', description:'Create or replace a file inside the project workspace', risk:'high', async execute(input, context) {
      const value=input as {path?:string;content?:string}; if(!value.path || typeof value.content!=='string') throw new Error('FILESYSTEM_WRITE_INPUT_INVALID');
      await deps.workspace.writeFile(value.path,value.content,context.signal); return {ok:true,path:value.path};
    }},
    { name:'filesystem.delete', description:'Delete a file inside the project workspace', risk:'high', async execute(input, context) {
      const value=input as {path?:string}; if(!value.path) throw new Error('FILESYSTEM_PATH_REQUIRED');
      await deps.workspace.deleteFile(value.path,context.signal); return {ok:true,path:value.path};
    }},
    { name:'shell.exec', description:'Execute an allowlisted command inside the project sandbox', risk:'high', async execute(input, context) {
      const value=input as {command?:string;args?:string[];cwd?:string;timeoutMs?:number}; if(!value.command) throw new Error('SHELL_COMMAND_REQUIRED');
      const execFn = deps.workspace.execForPhase ? (cmd: any, sig?: AbortSignal) => deps.workspace.execForPhase!(toolPhase, cmd, sig) : (cmd: any, sig?: AbortSignal) => deps.workspace.exec(cmd, sig);
      return execFn({command:value.command,args:value.args??[],cwd:value.cwd??cwd,timeoutMs:value.timeoutMs??30000},context.signal);
    }},
    { name:'package.install', description:'Install project dependencies using the configured package manager', risk:'high', async execute(_input, context) {
      const manager=deps.packageManager??'pnpm'; const args=manager==='npm'?['install']:manager==='yarn'?['install']:manager==='bun'?['install']:['install','--no-frozen-lockfile'];
      const execFn = deps.workspace.execForPhase ? (cmd: any, sig?: AbortSignal) => deps.workspace.execForPhase!('install', cmd, sig) : (cmd: any, sig?: AbortSignal) => deps.workspace.exec(cmd, sig);
      return execFn({command:manager,args,cwd,timeoutMs:120000},context.signal);
    }},
    { name:'git.init', description:'Initialize git metadata for the generated project', risk:'medium', async execute(_input, context) {
      const execFn = deps.workspace.execForPhase ? (cmd: any, sig?: AbortSignal) => deps.workspace.execForPhase!(toolPhase, cmd, sig) : (cmd: any, sig?: AbortSignal) => deps.workspace.exec(cmd, sig);
      return execFn({command:'git',args:['init'],cwd,timeoutMs:30000},context.signal);
    }},
    { name:'git.commit', description:'Create a source-control checkpoint for generated changes', risk:'medium', async execute(input, context) {
      const value=input as {message?:string}; const message=value.message?.trim()||'chore: checkpoint generated application';
      if(/[\n\r]/.test(message)) throw new Error('GIT_COMMIT_MESSAGE_INVALID');
      const execFn = deps.workspace.execForPhase ? (cmd: any, sig?: AbortSignal) => deps.workspace.execForPhase!(toolPhase, cmd, sig) : (cmd: any, sig?: AbortSignal) => deps.workspace.exec(cmd, sig);
      await execFn({command:'git',args:['add','.'],cwd,timeoutMs:30000},context.signal);
      return execFn({command:'git',args:['commit','-m',message],cwd,timeoutMs:30000},context.signal);
    }},
    { name:'test.run', description:'Run the project test suite and return diagnostics', risk:'medium', async execute(_input, context){return deps.verifier.test(context.signal);} },
    { name:'build.run', description:'Build the generated application and return diagnostics', risk:'medium', async execute(_input, context){return deps.verifier.build(context.signal);} },
    { name:'runtime.validate', description:'Validate that the generated application can execute its start command', risk:'medium', async execute(input, context) {
      const value=input as {command?:string;args?:string[];timeoutMs?:number}; const start=commandFor(deps.packageManager,'start');
      const execFn = deps.workspace.execForPhase ? (cmd: any, sig?: AbortSignal) => deps.workspace.execForPhase!('runtime', cmd, sig) : (cmd: any, sig?: AbortSignal) => deps.workspace.exec(cmd, sig);
      return execFn({command:value.command??start.command,args:value.args??start.args,cwd,timeoutMs:value.timeoutMs??10000},context.signal);
    }}
  ];
  return {tools,names:tools.map(tool=>tool.name)};
}
