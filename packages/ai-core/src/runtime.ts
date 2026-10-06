import type { AgentTask, ToolCall } from '@nexaforge/shared';
import type { AgentRuntime, Tool } from './index.js';
import {
  AgentRuntime as RuntimeValidator,
  DEFAULT_EXECUTION_LIMITS,
  type AgentExecutionContext
} from './agent-runtime.js';
import { ToolRegistry } from './tool-registry.js';

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

  async run(task: AgentTask, options?: { signal?: AbortSignal }): Promise<RuntimeResult> {
    const startTime = Date.now();
    const max = Math.max(1, Math.min(task.maxIterations || DEFAULT_EXECUTION_LIMITS.maxIterations, DEFAULT_EXECUTION_LIMITS.maxIterations));

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

    const ctx: AgentExecutionContext = {
      agentId: 'bounded-executor',
      agentType: 'PlanningAgent',
      userId: task.workspaceId ? `user-${task.workspaceId}` : 'default-user',
      workspaceId: task.workspaceId,
      taskId: task.id,
      currentDepth: 1,
      currentIteration: 0,
      currentStep: 0,
      toolCallCount: 0,
      modelCallCount: 0,
      startTime,
      signal: durationController.signal
    };

    // 1. Initial validation
    RuntimeValidator.validateLimits(ctx, { maxIterations: max });

    // 2. Planning phase (Model Call 1)
    ctx.modelCallCount = (ctx.modelCallCount ?? 0) + 1;
    ctx.currentStep = 1;
    RuntimeValidator.validateLimits(ctx, { maxIterations: max });

    const plan = (await this.runtime.plan(task)).slice(0, max);

    // 3. Execution phase (Iterating steps, calling tools and models)
    ctx.currentStep = 2;
    ctx.currentIteration = 1;
    RuntimeValidator.validateLimits(ctx, { maxIterations: max });

    const calls = await this.runtime.execute(task, plan, durationController.signal);

    // Count executed tool calls
    ctx.toolCallCount = (ctx.toolCallCount ?? 0) + calls.length;
    RuntimeValidator.validateLimits(ctx, { maxIterations: max });

    const hasPendingApproval = calls.some(call => call.status === 'proposed');
    const hasFailure = calls.some(call => call.status === 'failed' || call.status === 'blocked');

    if (hasPendingApproval) {
      clearTimeout(durationTimer);
      if (options?.signal) options.signal.removeEventListener('abort', onExternalAbort);
      return {
        calls,
        status: 'waiting',
        metrics: {
          iterations: ctx.currentIteration,
          steps: ctx.currentStep,
          toolCalls: ctx.toolCallCount,
          modelCalls: ctx.modelCallCount,
          durationMs: Date.now() - startTime
        }
      };
    }

    if (hasFailure) {
      clearTimeout(durationTimer);
      if (options?.signal) options.signal.removeEventListener('abort', onExternalAbort);
      return {
        calls,
        status: 'failed',
        metrics: {
          iterations: ctx.currentIteration,
          steps: ctx.currentStep,
          toolCalls: ctx.toolCallCount,
          modelCalls: ctx.modelCallCount,
          durationMs: Date.now() - startTime
        }
      };
    }

    // 4. Synthesis phase (Model Call 2)
    ctx.currentStep = 3;
    ctx.modelCallCount = (ctx.modelCallCount ?? 0) + 1;
    RuntimeValidator.validateLimits(ctx, { maxIterations: max });

    const answer = await this.runtime.synthesize(task, calls);

    clearTimeout(durationTimer);
    if (options?.signal) options.signal.removeEventListener('abort', onExternalAbort);
    return {
      calls,
      answer,
      status: 'completed',
      metrics: {
        iterations: ctx.currentIteration,
        steps: ctx.currentStep,
        toolCalls: ctx.toolCallCount,
        modelCalls: ctx.modelCallCount,
        durationMs: Date.now() - startTime
      }
    };
  }
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}
