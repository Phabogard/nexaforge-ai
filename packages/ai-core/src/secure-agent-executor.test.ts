import { describe, expect, it } from 'vitest';
import { BoundedAgentExecutor, createToolRegistry } from './runtime.js';
import { SecureAgentExecutor } from './secure-agent-executor.js';

describe('SecureAgentExecutor', () => {
  const task = { id:'task-secure-1', workspaceId:'ws1', prompt:'test', mode:'auto' as const, status:'running' as const, maxIterations:3 };
  it('rejects missing or revoked sessions before execution', async () => {
    const repository={getAgentSession:async()=>null} as any;
    const runtime={plan:async()=>[],execute:async()=>[],synthesize:async()=> 'ok'} as any;
    const executor=new SecureAgentExecutor(repository,new BoundedAgentExecutor(runtime,createToolRegistry([])));
    await expect(executor.run({task,userId:'u1',workspaceId:'ws1',agentId:'agent-1',agentType:'PlanningAgent',sessionId:'missing'})).rejects.toThrow('AGENT_SESSION_INVALID_OR_REVOKED');
  });
  it('rejects capabilities not granted by the session', async () => {
    const repository={getAgentSession:async()=>({id:'session-1',userId:'u1',workspaceId:'ws1',agentType:'PlanningAgent',status:'active',grantedCapabilities:['web.read'],metadata:{agentId:'agent-1'},createdAt:new Date().toISOString(),expiresAt:null})} as any;
    const runtime={plan:async()=>[],execute:async()=>[],synthesize:async()=> 'ok'} as any;
    const executor=new SecureAgentExecutor(repository,new BoundedAgentExecutor(runtime,createToolRegistry([])));
    await expect(executor.run({task,userId:'u1',workspaceId:'ws1',agentId:'agent-1',agentType:'PlanningAgent',sessionId:'session-1',requiredCapabilities:['screen.capture']})).rejects.toThrow('AGENT_CAPABILITY_NOT_GRANTED:screen.capture');
  });
  it('passes the authenticated execution identity into bounded runtime', async () => {
    const repository={getAgentSession:async()=>({id:'session-1',userId:'u1',workspaceId:'ws1',agentType:'PlanningAgent',status:'active',grantedCapabilities:['web.read'],metadata:{agentId:'agent-1'},createdAt:new Date().toISOString(),expiresAt:null})} as any;
    let seen:any;
    const runtime={plan:async()=>[],execute:async(_task:any,_plan:any,_signal:any,context:any)=>{seen=context;return[]},synthesize:async()=> 'ok'} as any;
    const executor=new SecureAgentExecutor(repository,new BoundedAgentExecutor(runtime,createToolRegistry([])));
    const result=await executor.run({task,userId:'u1',workspaceId:'ws1',agentId:'agent-1',agentType:'PlanningAgent',sessionId:'session-1',requiredCapabilities:['web.read']});
    expect(result.status).toBe('completed'); expect(seen.userId).toBe('u1'); expect(seen.workspaceId).toBe('ws1'); expect(seen.agentId).toBe('agent-1'); expect(seen.sessionId).toBe('session-1');
  });
});
