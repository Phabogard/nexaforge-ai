import type { AgentTask, ToolCall } from '@nexaforge/shared';
import type { AgentRuntime, Tool } from './index';
import { DefaultToolPolicy, ToolRegistry } from './tool-registry';

export interface RuntimeResult {
  calls: ToolCall[];
  status: 'completed' | 'waiting' | 'failed';
}

export class BoundedAgentExecutor {
  constructor(private readonly runtime: AgentRuntime, private readonly registry: ToolRegistry) {}

  async run(task: AgentTask): Promise<RuntimeResult> {
    const plan = await this.runtime.plan(task);
    const calls: ToolCall[] = [];
    const max = Math.max(1, Math.min(task.maxIterations || 12, 50));

    for (let i = 0; i < Math.min(plan.length, max); i++) {
      const step = plan[i];
      if (!step.tool) continue;
      const result = await this.registry.invoke(step.tool, { objective: step.objective }, { task }, new DefaultToolPolicy());
      calls.push(result);
      if (result.status === 'proposed') return { calls, status: 'waiting' };
      if (result.status === 'failed' || result.status === 'blocked') return { calls, status: 'failed' };
    }
    return { calls, status: 'completed' };
  }
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}
