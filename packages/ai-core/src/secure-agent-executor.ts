import type { AgentTask, Capability } from '@nexaforge/shared';
import type { PermissionRepository } from '@nexaforge/db';
import { AgentSessionManager, type AgentSession } from './agent-session.js';
import { PermissionEngine } from './permission-engine.js';
import { BoundedAgentExecutor, type RuntimeResult } from './runtime.js';
import type { AgentExecutionContext, AgentType } from './agent-runtime.js';

export interface SecureAgentExecutionRequest {
  task: AgentTask;
  userId: string;
  workspaceId?: string;
  agentId: string;
  agentType: AgentType;
  sessionId: string;
  requiredCapabilities?: Capability[];
  signal?: AbortSignal;
}

export class SecureAgentExecutor {
  private readonly sessions: AgentSessionManager;

  constructor(
    private readonly repository: PermissionRepository,
    private readonly boundedExecutor: BoundedAgentExecutor
  ) {
    this.sessions = new AgentSessionManager(repository, new PermissionEngine(repository));
  }

  async run(request: SecureAgentExecutionRequest): Promise<RuntimeResult> {
    const session = await this.sessions.get(request.sessionId, {
      userId: request.userId,
      workspaceId: request.workspaceId,
      agentId: request.agentId
    });
    if (!session) throw new Error('AGENT_SESSION_INVALID_OR_REVOKED');
    const required = [...new Set(request.requiredCapabilities ?? [])];
    for (const capability of required) {
      if (!AgentSessionManager.isCapabilityGranted(session, capability)) {
        throw new Error(`AGENT_CAPABILITY_NOT_GRANTED:${capability}`);
      }
    }
    const context: AgentExecutionContext = {
      agentId: request.agentId, agentType: request.agentType, userId: request.userId,
      workspaceId: request.workspaceId, sessionId: session.id, taskId: request.task.id,
      currentDepth: 1, currentIteration: 0, startTime: Date.now(), signal: request.signal
    };
    return this.boundedExecutor.run(request.task, { signal: request.signal, context });
  }

  static sessionHasCapability(session: AgentSession, capability: Capability): boolean {
    return AgentSessionManager.isCapabilityGranted(session, capability);
  }
}
