import type { Capability } from '@nexaforge/shared';

export type AgentType =
  | 'PlanningAgent'
  | 'CodingAgent'
  | 'ReviewAgent'
  | 'TestAgent'
  | 'RepairAgent'
  | 'BrowserAgent'
  | 'WebResearchAgent'
  | 'AppAgent'
  | 'APIAgent'
  | 'DeviceAgent'
  | 'PersonalAssistantAgent'
  | 'MonitoringAgent'
  | 'DeploymentAgent';

export interface AgentExecutionLimits {
  maxIterations: number;
  maxDurationMs: number;
  maxRecursionDepth: number;
  maxToolCalls: number;
  maxModelCalls: number;
}

export interface AgentConfig {
  id: string;
  type: AgentType;
  name: string;
  requiredCapabilities: Capability[];
  limits?: Partial<AgentExecutionLimits>;
  memoryScope?: 'session' | 'task' | 'workspace' | 'user';
}

export interface AgentExecutionContext {
  agentId: string;
  agentType: AgentType;
  userId: string;
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  currentDepth: number;
  currentIteration: number;
  toolCallCount?: number;
  modelCallCount?: number;
  startTime: number;
  signal?: AbortSignal;
}

export const DEFAULT_EXECUTION_LIMITS: AgentExecutionLimits = {
  maxIterations: 12,
  maxDurationMs: 300000, // 5 minutes
  maxRecursionDepth: 3,
  maxToolCalls: 20,
  maxModelCalls: 15
};

export class AgentRuntime {
  static validateLimits(ctx: AgentExecutionContext, limits: AgentExecutionLimits = DEFAULT_EXECUTION_LIMITS): void {
    if (ctx.signal?.aborted) {
      throw new Error('AGENT_EXECUTION_CANCELLED');
    }
    if (ctx.currentDepth > limits.maxRecursionDepth) {
      throw new Error(`MAX_AGENT_RECURSION_DEPTH_EXCEEDED: ${ctx.currentDepth} > ${limits.maxRecursionDepth}`);
    }
    if (ctx.currentIteration > limits.maxIterations) {
      throw new Error(`MAX_AGENT_ITERATIONS_EXCEEDED: ${ctx.currentIteration} > ${limits.maxIterations}`);
    }
    if (ctx.toolCallCount !== undefined && ctx.toolCallCount > limits.maxToolCalls) {
      throw new Error(`MAX_AGENT_TOOL_CALLS_EXCEEDED: ${ctx.toolCallCount} > ${limits.maxToolCalls}`);
    }
    if (ctx.modelCallCount !== undefined && ctx.modelCallCount > limits.maxModelCalls) {
      throw new Error(`MAX_AGENT_MODEL_CALLS_EXCEEDED: ${ctx.modelCallCount} > ${limits.maxModelCalls}`);
    }
    if (Date.now() - ctx.startTime > limits.maxDurationMs) {
      throw new Error(`MAX_AGENT_DURATION_EXCEEDED: ${Date.now() - ctx.startTime}ms > ${limits.maxDurationMs}ms`);
    }
  }
}
