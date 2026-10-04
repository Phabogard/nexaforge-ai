import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { ApplicationArtifact, ApplicationArtifactPublisher, ApplicationDeploymentSource } from './application-artifact.js';
import { validateApplicationDeploymentSource } from './application-artifact.js';

export interface ContainerRegistryCommandExecutor {
  exec(command:string,args:string[],cwd:string,signal?:AbortSignal):Promise<{exitCode:number;stdout:string;stderr:string}>;
}

const SAFE_REFERENCE=/^[A-Za-z0-9._:@/-]{1,500}$/;
const MAX_OUTPUT=200_000;

function defaultExecutor():ContainerRegistryCommandExecutor{
  return {
    exec(command,args,cwd,signal){
      return new Promise((resolvePromise,reject)=>{
        const child=spawn(command,args,{cwd:resolve(cwd),shell:false,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'/tmp',DOCKER_CONFIG:process.env.DOCKER_CONFIG??''},stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='',settled=false;
        const finish=(v:{exitCode:number;stdout:string;stderr:string})=>{if(!settled){settled=true;resolvePromise(v);}};
        const fail=(e:Error)=>{if(!settled){settled=true;reject(e);}};
        const onAbort=()=>{child.kill('SIGTERM');fail(new Error('ARTIFACT_PUBLISH_CANCELLED'));};
        signal?.addEventListener('abort',onAbort,{once:true});
        child.stdout.on('data',c=>{stdout=(stdout+String(c)).slice(0,MAX_OUTPUT);});
        child.stderr.on('data',c=>{stderr=(stderr+String(c)).slice(0,MAX_OUTPUT);});
        child.on('error',e=>{signal?.removeEventListener('abort',onAbort);fail(e);});
        child.on('close',code=>{signal?.removeEventListener('abort',onAbort);finish({exitCode:code??1,stdout,stderr});});
      });
    }
  };
}

export interface DockerRegistryArtifactPublisherOptions {
  executor?:ContainerRegistryCommandExecutor;
  dockerExecutable?:string;
  workspaceRoot?:string;
}

export function createDockerRegistryArtifactPublisher(options:DockerRegistryArtifactPublisherOptions={}):ApplicationArtifactPublisher{
  const executor=options.executor??defaultExecutor();
  const dockerExecutable=options.dockerExecutable??'docker';
  return {
    async publish(artifact:ApplicationArtifact,signal?:AbortSignal):Promise<ApplicationDeploymentSource>{
      validateApplicationDeploymentSource(artifact.source);
      if(artifact.source.type!=='image') throw new Error('REGISTRY_PUBLISHER_REQUIRES_IMAGE_SOURCE');
      if(!SAFE_REFERENCE.test(artifact.source.reference)) throw new Error('INVALID_IMAGE_REFERENCE');
      if(signal?.aborted) throw new Error('ARTIFACT_PUBLISH_CANCELLED');
      const cwd=options.workspaceRoot??process.cwd();

      let pushed;
      try{
        pushed=await executor.exec(dockerExecutable,['push',artifact.source.reference],cwd,signal);
      }catch(error){
        if(error instanceof Error&&error.message==='ARTIFACT_PUBLISH_CANCELLED')throw error;
        const message=error instanceof Error?error.message:String(error);
        if(message.includes('ENOENT'))throw new Error('DOCKER_UNAVAILABLE');
        throw new Error(`ARTIFACT_PUBLISH_EXECUTION_FAILED:${message}`);
      }
      if(pushed.exitCode!==0)throw new Error(`ARTIFACT_PUBLISH_FAILED:${pushed.stderr.trim()||pushed.stdout.trim()||'docker push failed'}`);

      let inspect;
      try{
        inspect=await executor.exec(dockerExecutable,['image','inspect','--format={{index .RepoDigests 0}}',artifact.source.reference],cwd,signal);
      }catch(error){
        if(error instanceof Error&&error.message==='ARTIFACT_PUBLISH_CANCELLED')throw error;
        throw new Error(`ARTIFACT_PUBLISH_INSPECT_FAILED:${error instanceof Error?error.message:String(error)}`);
      }
      if(inspect.exitCode!==0)throw new Error(`ARTIFACT_PUBLISH_INSPECT_FAILED:${inspect.stderr.trim()||'unable to inspect pushed image'}`);
      const repoDigest=inspect.stdout.trim();
      const digest=repoDigest.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
      return {type:'image',reference:artifact.source.reference,digest,registry:artifact.source.registry};
    }
  };
}
