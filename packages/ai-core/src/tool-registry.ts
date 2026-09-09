import type { AgentMode, AgentTask, ToolCall } from '@nexaforge/shared';
import type { Tool, ToolContext } from './index';

export type ApprovalDecision = 'allow' | 'require_approval' | 'deny';

export interface ToolPolicy {
  decide(input: { task: AgentTask; tool: Tool; mode: AgentMode }): ApprovalDecision;
}

export class DefaultToolPolicy implements ToolPolicy {
  decide({ task, tool, mode }): ApprovalDecision {
    if (tool.risk === 'high') return 'require_approval';
    if (mode === 'computer-use' || mode === 'browser') return 'require_approval';
    if (task.budgetCents !== undefined && task.budgetCents <= 0) return 'deny';
    return 'allow';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`TOOL_ALREADY_REGISTERED:${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined { return this.tools.get(name); }
  list(): Tool[] { return [...this.tools.values()]; }

  async invoke(name: string, input: unknown, context: ToolContext, policy = new DefaultToolPolicy()): Promise<ToolCall> {
    const tool = this.get(name);
    if (!tool) return { id: crypto.randomUUID(), taskId: context.task.id, tool: name, input, status: 'failed', output: { error: 'TOOL_NOT_FOUND' } };

    const decision = policy.decide({ task: context.task, tool, mode: context.task.mode });
    const id = crypto.randomUUID();
    if (decision === 'deny') return { id, taskId: context.task.id, tool: name, input, status: 'blocked', output: { error: 'POLICY_DENIED' } };
    if (decision === 'require_approval') return { id, taskId: context.task.id, tool: name, input, status: 'proposed', output: { approvalRequired: true } };

    try {
      const output = await tool.execute(input, context);
      return { id, taskId: context.task.id, tool: name, input, output, status: 'completed' };
    } catch (error) {
      return { id, taskId: context.task.id, tool: name, input, status: 'failed', output: { error: error instanceof Error ? error.message : 'TOOL_EXECUTION_FAILED' } };
    }
  }
}
