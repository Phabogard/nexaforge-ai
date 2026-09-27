import { mkdir, readdir, stat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createConfiguredModelProvider, createApplicationBuilder, createContainerManifest, createWorkspaceArtifactManifest, createDockerImageBuilder, createDockerRegistryArtifactPublisher } from '@nexaforge/ai-core';
import type { ApplicationRepository, ApplicationBuildRecord } from '@nexaforge/db';
import type { ApplicationDeploymentSource } from '@nexaforge/ai-core';

const SECRET_FILE = /(^|\/)(\.env(?:\..*)?|credentials?\.(json|ya?ml)|.*\.(pem|key|p12|pfx))$/i;

async function collectArtifacts(root:string):Promise<Array<{path:string,kind:string,hash:string,size:number}>>{
  const out:Array<{path:string,kind:string,hash:string,size:number}>=[]; const ignored=new Set(['node_modules','.git','.next','dist','build']);
  async function walk(dir:string){for(const entry of await readdir(dir,{withFileTypes:true})){if(ignored.has(entry.name))continue;const full=join(dir,entry.name);if(entry.isDirectory())await walk(full);else{const path=relative(root,full).split('\\').join('/');if(SECRET_FILE.test(path))continue;const data=await readFile(full);const ext=path.split('.').pop()?.toLowerCase();const kind=['json','yaml','yml','toml','config'].includes(ext??'')?'config':['png','jpg','jpeg','gif','svg','webp','ico'].includes(ext??'')?'asset':'source';out.push({path,kind,hash:createHash('sha256').update(data).digest('hex'),size:(await stat(full)).size});}}}
  await walk(root); return out;
}

export class ApplicationBuildWorker {
  private running=false; private timer?:NodeJS.Timeout; private readonly controllers=new Map<string,AbortController>(); private readonly workerId=`application-worker-${process.pid}-${randomUUID()}`; private readonly leaseSeconds=60;
  constructor(private readonly store:ApplicationRepository,private readonly pollMs=1000,private readonly root=process.env.APPLICATION_WORKSPACE_ROOT??'/tmp/nexaforge-projects'){}
  start(){if(this.running)return;this.running=true;void this.loop();}
  stop(){this.running=false;if(this.timer)clearTimeout(this.timer);for(const c of this.controllers.values())c.abort();this.controllers.clear();}
  cancel(id:string){this.controllers.get(id)?.abort();}
  private async loop(){while(this.running){try{const build=await this.store.claimNextBuild(this.workerId,this.leaseSeconds);if(build)await this.process(build);}catch(error){console.error('[nexaforge-application-worker]',error);}if(this.running)await new Promise<void>(r=>{this.timer=setTimeout(r,this.pollMs);});}}
  private async process(build:ApplicationBuildRecord){
    const controller=new AbortController();this.controllers.set(build.id,controller);const heartbeat=setInterval(()=>{void this.store.renewBuildLease(build.id,this.workerId,this.leaseSeconds).catch(()=>{});},20000);
    const workspaceRoot=join(this.root,build.projectId);
    try{
      const project=await this.store.getProject(build.projectId);
      if(!project){await this.store.updateBuild(build.id,{status:'failed',phase:'failed',errorCode:'PROJECT_NOT_FOUND'});return;}
      await this.store.addBuildEvent({buildId:build.id,eventType:'build.started',phase:'planning',payload:{projectId:project.id}});
      if(process.env.REQUIRE_APPLICATION_APPROVAL==='true'){
        const approval=await this.store.requestApproval({buildId:build.id,stepKey:'execution',reason:'Application generation executes package installation, tests and build commands inside the isolated workspace.'});
        if(approval.status!=='approved'){
          await this.store.updateBuild(build.id,{status:'waiting_approval',phase:'waiting_approval'});
          await this.store.addBuildEvent({buildId:build.id,eventType:'approval.requested',phase:'waiting_approval',payload:{stepKey:'execution',reason:approval.reason}});
          return;
        }
      }
      await mkdir(workspaceRoot,{recursive:true});
      const request=build.request as {prompt:string;maxIterations?:number;maxRepairAttempts?:number};
      const persistedSteps=await this.store.getBuildSteps(build.id);
      const resumeFrom=persistedSteps.filter((step:any)=>step.status==='completed').map((step:any)=>({stepKey:step.stepKey,phase:step.phase as any,blueprint:step.output && typeof step.output==='object' ? (step.output as Record<string,unknown>).blueprint as any : undefined,repairAttempts:step.output && typeof step.output==='object' ? Number((step.output as Record<string,unknown>).repairAttempts??0) : 0}));
      const builder=createApplicationBuilder({model:createConfiguredModelProvider()});
      await this.store.upsertBuildStep({buildId:build.id,stepKey:'plan',phase:'planning',status:'running'});
      await this.store.addBuildEvent({buildId:build.id,eventType:'phase.started',phase:'planning'});
      const result=await builder.build({projectId:project.id,prompt:request.prompt,workspaceRoot,maxIterations:request.maxIterations??12,maxRepairAttempts:request.maxRepairAttempts??3,resumeFrom,checkpoint:async (checkpoint:any)=>{const previous=persistedSteps.find((step:any)=>step.stepKey===checkpoint.stepKey);const attempt=(previous?.attempt??0)+(checkpoint.status==='running'?1:0);await this.store.upsertBuildStep({buildId:build.id,stepKey:checkpoint.stepKey,phase:checkpoint.phase,status:checkpoint.status??'completed',attempt,output:checkpoint.output??{blueprint:checkpoint.blueprint,repairAttempts:checkpoint.repairAttempts},errorCode:checkpoint.errorCode});if(checkpoint.status!=='failed') await this.store.updateBuild(build.id,{status:'building',phase:checkpoint.phase,repairAttempts:checkpoint.repairAttempts});}},controller.signal);
      const phaseMap:Record<string,string>={plan:'planning',scaffold:'scaffolding',code:'coding',install:'installing',test:'testing',repair:'repairing',validate:'validating'};
      for(const step of result.completedSteps) await this.store.upsertBuildStep({buildId:build.id,stepKey:step,phase:phaseMap[step]??result.phase,status:'completed'});
      let deploymentSource: ApplicationDeploymentSource | undefined;
      if(result.phase==='completed' && result.blueprint){
        const container = createContainerManifest(result.blueprint);
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(workspaceRoot, 'Dockerfile'), container.dockerfile, 'utf8');
        await this.store.addBuildEvent({buildId:build.id,eventType:'artifact.container_manifest',phase:'validating',payload:{port:container.port,healthcheck:container.healthcheck}});
        const version=await this.store.createProjectVersion({projectId:project.id,blueprint:result.blueprint});
        const artifacts=await collectArtifacts(workspaceRoot);
        for(const artifact of artifacts) await this.store.addArtifact({projectVersionId:version.id,path:artifact.path,kind:artifact.kind,contentHash:artifact.hash,sizeBytes:artifact.size});

        const source = { type: 'workspace' as const, workspaceRoot };
        const artifactFiles = artifacts.map(artifact => ({
          path: artifact.path,
          kind: (artifact.kind === 'config' || artifact.kind === 'asset' ? artifact.kind : 'source') as 'source' | 'config' | 'asset' | 'manifest',
          contentHash: artifact.hash,
          sizeBytes: artifact.size
        }));
        const manifest = createWorkspaceArtifactManifest(project.id, build.id, source, artifactFiles);
        deploymentSource = source;
        const deploymentArtifactManifest = manifest as unknown as Record<string, unknown>;
        let image: { reference:string; digest?:string; registry?:string } | undefined;

        if (process.env.APPLICATION_IMAGE_BUILD === 'true') {
          const registry = process.env.APPLICATION_IMAGE_REGISTRY?.replace(/\/$/, '');
          image = await createDockerImageBuilder().build({
            projectId: project.id, buildId: build.id, source, workspaceRoot,
            imageName: `nexaforge/${project.id}`, imageTag: build.id, registry, port: container.port
          });
          deploymentSource = { type: 'image', reference: image!.reference, digest: image!.digest, registry: image!.registry };
          await this.store.addBuildEvent({buildId:build.id,eventType:'artifact.image.built',phase:'validating',payload:image});
        }

        if (image && process.env.APPLICATION_IMAGE_PUSH === 'true') {
          deploymentSource = await createDockerRegistryArtifactPublisher({workspaceRoot}).publish({
            projectId:project.id, buildId:build.id, source:deploymentSource, files:manifest.files,
            manifest: deploymentArtifactManifest, contentHash:manifest.contentHash, createdAt:manifest.createdAt
          }, controller.signal);
          await this.store.addBuildEvent({buildId:build.id,eventType:'artifact.image.published',phase:'deploying',payload:deploymentSource});
        }
        await this.store.addBuildEvent({buildId:build.id,eventType:'build.completed',phase:'completed',payload:{versionId:version.id,artifactCount:artifacts.length,artifact:{...manifest,source:deploymentSource},image}});
      } else {
        await this.store.addBuildEvent({buildId:build.id,eventType:result.phase==='cancelled'?'build.cancelled':'build.failed',phase:result.phase,payload:{errorCode:result.errorCode}});
      }
      const persistedResult = result.phase === 'completed' && result.blueprint ? { ...result, deploymentSource } : result;
      const current=await this.store.getBuild(build.id);
      if(current?.status==='cancelled') return;
      await this.store.updateBuild(build.id,{status:result.phase==='completed'?'completed':result.phase==='cancelled'?'cancelled':'failed',phase:result.phase,result:persistedResult,repairAttempts:result.repairAttempts,errorCode:result.errorCode});
    }catch(error){
      const message=error instanceof Error?error.message:'APPLICATION_BUILD_FAILED';
      const current=await this.store.getBuild(build.id);
      if(current?.status==='cancelled') return;
      await this.store.addBuildEvent({buildId:build.id,eventType:controller.signal.aborted?'build.cancelled':'build.failed',phase:controller.signal.aborted?'cancelled':'failed',payload:{errorCode:message}});
      await this.store.updateBuild(build.id,{status:controller.signal.aborted?'cancelled':'failed',phase:controller.signal.aborted?'cancelled':'failed',errorCode:message});
    }finally{clearInterval(heartbeat);this.controllers.delete(build.id);}
  }
}
