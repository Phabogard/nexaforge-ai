import type { AgentTask, ToolCall } from '@nexaforge/shared';
import type { AgentRuntime, Tool } from './index.js';
import {
  AgentRuntime as RuntimeValidator,
  DEFAULT_EXECUTION_LIMITS,
  type AgentExecutionContext
} from './agent-runtime.js';
import { ToolRegistry } from './tool-registry.js';

export interface RuntimeExecutionContext extends AgentExecutionContext {
  requiredCapabilities?: import('@nexaforge/shared').Capability[];
}
export interface RuntimeResult {
  calls: ToolCall[];
  answer?: string;
  status: 'completed' | 'waiting' | 'failed';
  metrics?: {
    iterations: number;
    steps: number;
    toolCalls: number;
    modelCalls: number;
    durationMs: number;
  };
}

export class BoundedAgentExecutor {
  constructor(private readonly runtime: AgentRuntime, private readonly registry: ToolRegistry) {}

  async run(task: AgentTask, options?: { signal?: AbortSignal; context?: RuntimeExecutionContext }): Promise<RuntimeResult> {
    const startTime = Date.now();
    const max = Math.max(
      1,
      Math.min(
        task.maxIterations || DEFAULT_EXECUTION_LIMITS.maxIterations,
        DEFAULT_EXECUTION_LIMITS.maxIterations
      )
    );

    const durationController = new AbortController();
    const onExternalAbort = () => durationController.abort();

    if (options?.signal) {
      if (options.signal.aborted) durationController.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const durationTimer = setTimeout(
      () => durationController.abort(),
      DEFAULT_EXECUTION_LIMITS.maxDurationMs
    );

    try {
      const ctx: AgentExecutionContext = {
        ...(options?.context ?? {}),
        agentId: options?.context?.agentId ?? 'bounded-executor',
        agentType: options?.context?.agentType ?? 'PlanningAgent',
        userId: options?.context?.userId ?? (task.workspaceId ? `user-${task.workspaceId}` : 'default-user'),
        workspaceId: options?.context?.workspaceId ?? task.workspaceId,
        taskId: task.id,
        currentDepth: 1,
        currentIteration: 0,
        currentStep: 0,
        toolCallCount: 0,
        modelCallCount: 0,
        startTime,
        signal: durationController.signal
      };

      RuntimeValidator.validateLimits(ctx, { maxIterations: max });

      // Planning phase (model call 1).
      ctx.modelCallCount = 1;
      ctx.currentStep = 1;
      RuntimeValidator.validateLimits(ctx, { maxIterations: max });
      const plan = (await this.runtime.plan(task)).slice(0, max);

      // Tool execution phase.
      ctx.currentStep = 2;
      ctx.currentIteration = 1;
      RuntimeValidator.validateLimits(ctx, { maxIterations: max });

      const calls = await this.runtime.execute(task, plan, durationController.signal, ctx);

      ctx.toolCallCount = calls.length;
      RuntimeValidator.validateLimits(ctx, { maxIterations: max });

      const hasPendingApproval = calls.some(call => call.status === 'proposed');
      const hasFailure = calls.some(
        call => call.status === 'failed' || call.status === 'blocked'
      );

      if (hasPendingApproval) {
        return {
          calls,
          status: 'waiting',
          metrics: {
            iterations: ctx.currentIteration,
            steps: ctx.currentStep ?? 0,
            toolCalls: ctx.toolCallCount ?? 0,
            modelCalls: ctx.modelCallCount ?? 0,
            durationMs: Date.now() - startTime
          }
        };
      }

      if (hasFailure) {
        return {
          calls,
          status: 'failed',
          metrics: {
            iterations: ctx.currentIteration,
            steps: ctx.currentStep ?? 0,
            toolCalls: ctx.toolCallCount ?? 0,
            modelCalls: ctx.modelCallCount ?? 0,
            durationMs: Date.now() - startTime
          }
        };
      }

      // Synthesis phase (model call 2).
      ctx.currentStep = 3;
      ctx.modelCallCount = 2;
      RuntimeValidator.validateLimits(ctx, { maxIterations: max });
      const answer = await this.runtime.synthesize(task, calls);

      return {
        calls,
        answer,
        status: 'completed',
        metrics: {
          iterations: ctx.currentIteration,
          steps: ctx.currentStep ?? 0,
          toolCalls: ctx.toolCallCount ?? 0,
          modelCalls: ctx.modelCallCount ?? 0,
          durationMs: Date.now() - startTime
        }
      };
    } finally {
      clearTimeout(durationTimer);
      if (options?.signal) {
        options.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}
