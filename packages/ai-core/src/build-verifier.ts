import type { WorkspaceExecutor } from './workspace-tools';

export interface VerificationResult { ok:boolean; stage:'install'|'test'|'build'|'runtime'; exitCode?:number; stdout?:string; stderr?:string; diagnostics:string[]; }
export interface BuildVerifier { install(signal?:AbortSignal):Promise<VerificationResult>; test(signal?:AbortSignal):Promise<VerificationResult>; build(signal?:AbortSignal):Promise<VerificationResult>; validateRuntime(signal?:AbortSignal):Promise<VerificationResult>; }
export interface BuildVerifierOptions { workspace:WorkspaceExecutor; packageManager?:'npm'|'pnpm'|'yarn'|'bun'; cwd?:string; testScript?:string; buildScript?:string; installArgs?:string[]; }
const commandFor=(manager:'npm'|'pnpm'|'yarn'|'bun',script:string)=>manager==='npm'?{command:'npm',args:['run',script]}:manager==='yarn'?{command:'yarn',args:[script]}:manager==='bun'?{command:'bun',args:['run',script]}:{command:'pnpm',args:['run',script]};
const result=(stage:VerificationResult['stage'],exitCode:number,stdout:string,stderr:string):VerificationResult=>({ok:exitCode===0,stage,exitCode,stdout,stderr,diagnostics:[stderr.trim(),stdout.trim()].filter(Boolean).slice(0,10)});
export function createBuildVerifier(options:BuildVerifierOptions):BuildVerifier {
  const manager=options.packageManager??'pnpm', cwd=options.cwd??'.';
  const run=async(stage:VerificationResult['stage'],command:string,args:string[],signal?:AbortSignal)=>{
    const output=await options.workspace.exec({command,args,cwd,timeoutMs:120000},signal); return result(stage,output.exitCode,output.stdout,output.stderr);
  };
  return {
    install(signal){return run('install',manager,options.installArgs??(manager==='pnpm'?['install','--no-frozen-lockfile']:['install']),signal);},
    test(signal){const c=commandFor(manager,options.testScript??'test'); return run('test',c.command,c.args,signal);},
    build(signal){const c=commandFor(manager,options.buildScript??'build'); return run('build',c.command,c.args,signal);},
    validateRuntime(signal){const c=commandFor(manager,'start'); return options.workspace.exec({command:c.command,args:c.args,cwd,timeoutMs:10000},signal).then(output=>result('runtime',output.exitCode,output.stdout,output.stderr)).catch(error=>{if(error instanceof Error && error.message==='WORKSPACE_COMMAND_TIMEOUT') return {ok:true,stage:'runtime',diagnostics:['start command remained alive for validation timeout']}; throw error;});}
  };
}
export function firstFailure(results:VerificationResult[]):VerificationResult|undefined{return results.find(result=>!result.ok);}
