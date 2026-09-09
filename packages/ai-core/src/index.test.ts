import { describe, expect, it } from 'vitest';
import { createSupervisor, type ModelProvider, type Tool } from './index';
import { BoundedAgentExecutor, createToolRegistry } from './runtime';

const task = {
  id: 'task-1', workspaceId: 'workspace-1', prompt: 'What time is it?', mode: 'auto' as const,
  status: 'running' as const, maxIterations: 3
};

const timeTool: Tool<{ timezone?: string }, { ok: boolean }> = {
  name: 'time.now', description: 'Return current time', risk: 'low',
  async execute() { return { ok: true }; }
};

function provider(response: string): ModelProvider {
  return { async generate() { return response; } };
}

describe('supervisor', () => {
  it('parses a structured plan and executes a known low-risk tool', async () => {
    const runtime = createSupervisor([timeTool], provider(JSON.stringify([
      { id: 's1', objective: 'Get the current time', mode: 'auto', tool: 'time.now', input: {} }
    ])));
    const result = await new BoundedAgentExecutor(runtime, createToolRegistry([timeTool])).run(task);
    expect(result.status).toBe('completed');
    expect(result.calls[0]?.status).toBe('completed');
  });

  it('fails closed when the model does not return JSON', async () => {
    const runtime = createSupervisor([timeTool], provider('I will use time.now'));
    await expect(runtime.plan(task)).rejects.toThrow('INVALID_PLAN_JSON');
  });

  it('requires approval for browser actions', async () => {
    const browserTool: Tool = { name: 'browser.open', description: 'Open a browser page', risk: 'low', async execute() { return {}; } };
    const browserTask = { ...task, mode: 'browser' as const };
    const runtime = createSupervisor([browserTool], provider(JSON.stringify([
      { objective: 'Open the page', mode: 'browser', tool: 'browser.open' }
    ])));
    const result = await new BoundedAgentExecutor(runtime, createToolRegistry([browserTool])).run(browserTask);
    expect(result.status).toBe('waiting');
    expect(result.calls[0]?.status).toBe('proposed');
  });
});
