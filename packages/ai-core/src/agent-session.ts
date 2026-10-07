import type { AgentType, Capability } from '@nexaforge/shared';
import type { AgentSessionRecord, PermissionRepository } from '@nexaforge/db';
import { CapabilityEngine } from './capability-engine.js';
import { PermissionEngine } from './permission-engine.js';

export interface AgentSessionRequest {
  userId: string;
  workspaceId?: string;
  agentId: string;
  agentType: AgentType;
  requiredCapabilities: Capability[];
  metadata?: Record<string, unknown>;
  expiresAt?: string;
}

export interface AgentSession {
  id: string;
  userId: string;
  workspaceId?: string;
  agentId: string;
  agentType: AgentType;
  grantedCapabilities: Capability[];
  metadata: Record<string, unknown>;
  createdAt: string;
  expiresAt?: string;
}

export class AgentSessionManager {
  constructor(
    private readonly repository: PermissionRepository,
    private readonly permissionEngine: PermissionEngine
  ) {}

  async start(request: AgentSessionRequest): Promise<AgentSession> {
    const uniqueCapabilities = [...new Set(request.requiredCapabilities)];

    // A session can never grant a capability that the user does not currently
    // possess in the requested workspace/agent scope.
    const grantedCapabilities: Capability[] = [];
    for (const capability of uniqueCapabilities) {
      const result = await this.permissionEngine.checkPermission({
        userId: request.userId,
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        capability
      });

      if (result.granted) {
        grantedCapabilities.push(capability);
      }
    }

    const record = await this.repository.createAgentSession({
      userId: request.userId,
      workspaceId: request.workspaceId,
      agentType: request.agentType,
      grantedCapabilities,
      metadata: {
        ...request.metadata,
        agentId: request.agentId
      },
      expiresAt: request.expiresAt
    });

    return this.toSession(record, request.agentId);
  }

  async get(id: string, expectedScope?: { userId?: string; workspaceId?: string; agentId?: string }): Promise<AgentSession | null> {
    const record = await this.repository.getAgentSession(id);
    if (!record) return null;

    const recordAgentId = typeof record.metadata === 'object' && record.metadata !== null
      ? (record.metadata as Record<string, unknown>).agentId
      : undefined;

    if (
      (expectedScope?.userId && record.userId !== expectedScope.userId) ||
      (expectedScope?.workspaceId && record.workspaceId !== expectedScope.workspaceId) ||
      (expectedScope?.agentId && recordAgentId !== expectedScope.agentId)
    ) {
      return null;
    }

    return this.toSession(record, typeof recordAgentId === 'string' ? recordAgentId : '');
  }

  async close(id: string, expectedScope?: { userId?: string; workspaceId?: string; agentId?: string }): Promise<boolean> {
    const session = await this.get(id, expectedScope);
    if (!session) return false;
    if (!this.repository.revokeAgentSession) return false;
    return this.repository.revokeAgentSession(id);
  }

  static isCapabilityGranted(session: AgentSession, capability: Capability): boolean {
    return CapabilityEngine.isCapabilityAllowedInScope(capability, session.grantedCapabilities);
  }

  private toSession(record: AgentSessionRecord, agentId: string): AgentSession {
    const grantedCapabilities = record.grantedCapabilities.filter(
      (capability): capability is Capability =>
        CapabilityEngine.getRiskLevel(capability as Capability) !== undefined
    );

    return {
      id: record.id,
      userId: record.userId,
      workspaceId: record.workspaceId ?? undefined,
      agentId,
      agentType: record.agentType as AgentType,
      grantedCapabilities,
      metadata: (record.metadata ?? {}) as Record<string, unknown>,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt ?? undefined
    };
  }
}
