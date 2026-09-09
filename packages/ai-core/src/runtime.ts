import type { AgentTask, ToolCall } from '@nexaforge/shared';
import type { AgentRuntime, Tool } from './index';
import { ToolRegistry } from './tool-registry';

export interface RuntimeResult {
  calls: ToolCall[];
  status: 'completed' | 'waiting' | 'failed';
}

export class BoundedAgentExecutor {
  constructor(private readonly runtime: AgentRuntime, private readonly registry: ToolRegistry) {}

  async run(task: AgentTask): Promise<RuntimeResult> {
    const max = Math.max(1, Math.min(task.maxIterations || 12, 50));
    const plan = (await this.runtime.plan(task)).slice(0, max);
    const calls = await this.runtime.execute(task, plan);
    const hasPendingApproval = calls.some(call => call.status === 'proposed');
    const hasFailure = calls.some(call => call.status === 'failed' || call.status === 'blocked');
    return {
      calls,
      status: hasPendingApproval ? 'waiting' : hasFailure ? 'failed' : 'completed'
    };
  }
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}
