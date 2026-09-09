import type { AgentMode, AgentTask } from '@nexaforge/shared';
import { BoundedAgentExecutor, createConfiguredModelProvider, createSupervisor, echoTool, timeTool, UnconfiguredModelProvider } from '@nexaforge/ai-core';
import type { TaskRepository, TaskRecord } from '@nexaforge/db';

export type WorkerStore = TaskRepository & { memoryTasks?: Map<string, TaskRecord>; memoryEvents?: Map<string, unknown[]> };

const toAgentTask = (task: TaskRecord): AgentTask => ({
  id: task.id,
  workspaceId: task.workspaceId,
  prompt: task.prompt,
  mode: task.mode as AgentMode,
  status: task.status as AgentTask['status'],
  maxIterations: task.maxIterations,
  budgetCents: task.budgetCents ?? undefined
});

export class TaskWorker {
  private running = false;
  private readonly controllers = new Map<string, AbortController>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly store: WorkerStore, private readonly pollMs = 750) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
  }

  cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const task = await this.claim();
        if (task) await this.process(task);
      } catch (error) {
        console.error('[nexaforge-worker]', error);
      }
      await new Promise<void>(resolve => { this.timer = setTimeout(resolve, this.pollMs); });
    }
  }

  private async claim(): Promise<TaskRecord | null> {
    if (this.store.claimNextQueued) return this.store.claimNextQueued();
    return null;
  }

  private async process(task: TaskRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    await this.store.addEvent(task.id, 'task.planning', { worker: 'default' });
    try {
      const model = createConfiguredModelProvider();
      const runtime = createSupervisor([timeTool, echoTool], model);
      const executor = new BoundedAgentExecutor(runtime, undefined as never);
      await this.store.updateStatus(task.id, 'running');
      await this.store.addEvent(task.id, 'task.running', {});
      if (controller.signal.aborted) throw new Error('TASK_CANCELLED');
      const result = await executor.run(toAgentTask({ ...task, status: 'running' }));
      if (controller.signal.aborted) throw new Error('TASK_CANCELLED');
      const status = result.status;
      await this.store.updateExecution(task.id, {
        status,
        result: { calls: result.calls },
        iterationCount: result.calls.length,
        errorCode: status === 'failed' ? 'EXECUTION_FAILED' : undefined
      });
      await this.store.addEvent(task.id, `task.${status}`, { calls: result.calls.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'TASK_EXECUTION_FAILED';
      const cancelled = message === 'TASK_CANCELLED' || controller.signal.aborted;
      await this.store.updateExecution(task.id, {
        status: cancelled ? 'cancelled' : 'failed',
        errorCode: cancelled ? 'TASK_CANCELLED' : message,
        result: { error: message },
        iterationCount: task.iterationCount
      });
      await this.store.addEvent(task.id, cancelled ? 'task.cancelled' : 'task.failed', { error: message });
    } finally {
      this.controllers.delete(task.id);
    }
  }
}

export function configuredWorker(store: WorkerStore): TaskWorker {
  return new TaskWorker(store);
}
