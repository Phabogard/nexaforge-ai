import { describe, expect, it, vi } from 'vitest';
import { createDockerRegistryArtifactPublisher, type ContainerRegistryCommandExecutor } from './application-registry-publisher';

function executor(outputs:Array<{exitCode:number;stdout:string;stderr:string}>):ContainerRegistryCommandExecutor{
  return {exec:vi.fn(async()=>outputs.shift()??{exitCode:1,stdout:'',stderr:'missing'})};
}

const artifact={projectId:'p',buildId:'b',source:{type:'image' as const,reference:'registry.example/nexaforge/app:build-1',registry:'registry.example'},files:[{path:'app.js',kind:'source' as const,contentHash:'abc',sizeBytes:3}],manifest:{},contentHash:'abc',createdAt:'2026-01-01T00:00:00.000Z'};

describe('docker registry artifact publisher',()=>{
  it('pushes and resolves the remote digest',async()=>{
    const ex=executor([{exitCode:0,stdout:'pushed',stderr:''},{exitCode:0,stdout:'registry.example/nexaforge/app@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n',stderr:''}]);
    const result=await createDockerRegistryArtifactPublisher({executor:ex,workspaceRoot:'/tmp'}).publish(artifact);
    expect(result).toEqual({type:'image',reference:artifact.source.reference,digest:'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',registry:'registry.example'});
    expect(ex.exec).toHaveBeenNthCalledWith(1,'docker',['push',artifact.source.reference],'/tmp',undefined);
    expect(ex.exec).toHaveBeenNthCalledWith(2,'docker',['image','inspect','--format={{index .RepoDigests 0}}',artifact.source.reference],'/tmp',undefined);
  });
  it('fails closed when docker push fails',async()=>{
    await expect(createDockerRegistryArtifactPublisher({executor:executor([{exitCode:1,stdout:'',stderr:'denied'}])}).publish(artifact)).rejects.toThrow('ARTIFACT_PUBLISH_FAILED:denied');
  });
  it('rejects non-image sources',async()=>{
    const workspaceArtifact={...artifact,source:{type:'workspace' as const,workspaceRoot:'/tmp/app'}};
    await expect(createDockerRegistryArtifactPublisher({executor:executor([])}).publish(workspaceArtifact)).rejects.toThrow('REGISTRY_PUBLISHER_REQUIRES_IMAGE_SOURCE');
  });
});
