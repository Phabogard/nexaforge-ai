import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createConfiguredModelProvider, createApplicationBuilder } from '@nexaforge/ai-core';
import type { ApplicationRepository, ApplicationBuildRecord } from '@nexaforge/db';

export class ApplicationBuildWorker {
  private running=false;
  private timer?:NodeJS.Timeout;
  private readonly controllers=new Map<string,AbortController>();
  constructor(private readonly store:ApplicationRepository,private readonly pollMs=1000,private readonly root=process.env.APPLICATION_WORKSPACE_ROOT??'/tmp/nexaforge-projects'){}
  start(){if(this.running)return;this.running=true;void this.loop();}
  stop(){this.running=false;if(this.timer)clearTimeout(this.timer);for(const c of this.controllers.values())c.abort();this.controllers.clear();}
  cancel(id:string){this.controllers.get(id)?.abort();}
  private async loop(){while(this.running){try{const build=await this.store.claimNextBuild();if(build)await this.process(build);}catch(error){console.error('[nexaforge-application-worker]',error);}if(this.running)await new Promise<void>(r=>{this.timer=setTimeout(r,this.pollMs);});}}
  private async process(build:ApplicationBuildRecord){
    const controller=new AbortController();this.controllers.set(build.id,controller);
    const project=await this.store.getProject(build.projectId);
    if(!project){await this.store.updateBuild(build.id,{status:'failed',phase:'failed',errorCode:'PROJECT_NOT_FOUND'});this.controllers.delete(build.id);return;}
    const workspaceRoot=join(this.root,build.projectId);
    try{
      await mkdir(workspaceRoot,{recursive:true});
      const request=build.request as {prompt:string;maxIterations?:number;maxRepairAttempts?:number};
      const builder=createApplicationBuilder({model:createConfiguredModelProvider()});
      await this.store.upsertBuildStep({buildId:build.id,stepKey:'plan',phase:'planning',status:'running'});
      const result=await builder.build({projectId:project.id,prompt:request.prompt,workspaceRoot,maxIterations:request.maxIterations??12,maxRepairAttempts:request.maxRepairAttempts??3},controller.signal);
      for(const step of result.completedSteps) await this.store.upsertBuildStep({buildId:build.id,stepKey:step,phase:step==='plan'?'planning':step==='scaffold'?'scaffolding':step==='code'?'coding':step==='install'?'installing':step==='test'?'testing':step==='repair'?'repairing':'validating',status:'completed'});
      await this.store.updateBuild(build.id,{status:result.phase==='completed'?'completed':result.phase==='cancelled'?'cancelled':'failed',phase:result.phase,result,repairAttempts:result.repairAttempts,errorCode:result.errorCode});
    }catch(error){const message=error instanceof Error?error.message:'APPLICATION_BUILD_FAILED';await this.store.updateBuild(build.id,{status:controller.signal.aborted?'cancelled':'failed',phase:controller.signal.aborted?'cancelled':'failed',errorCode:message});}
    finally{this.controllers.delete(build.id);}
  }
}
