import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

export type TaskRecord = {
  id: string;
  prompt: string;
  mode: string;
  status: string;
  workspaceId: string;
  maxIterations: number;
  budgetCents?: number | null;
  result?: unknown;
  errorCode?: string | null;
  iterationCount: number;
  createdAt: string;
  completedAt?: string | null;
};

export type CreateTaskInput = {
  prompt: string;
  mode: string;
  workspaceId: string;
  maxIterations?: number;
  budgetCents?: number;
};

export type TaskEventRecord = {
  id: string;
  taskId: string;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
};

export interface TaskRepository {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  get(id: string): Promise<TaskRecord | null>;
  claimNextQueued(): Promise<TaskRecord | null>;
  updateStatus(id: string, status: string): Promise<TaskRecord | null>;
  updateExecution(id: string, input: { status: string; result?: unknown; errorCode?: string; iterationCount: number }): Promise<TaskRecord | null>;
  addEvent(taskId: string, type: string, payload: unknown): Promise<TaskEventRecord>;
  listEvents(taskId: string): Promise<TaskEventRecord[]>;
  createWorkspace(input: { email: string; displayName?: string; workspaceName?: string }): Promise<WorkspaceRecord>;
  workspaceExists(id: string): Promise<boolean>;
}

const toTask = (row: Record<string, unknown>): TaskRecord => ({
  id: String(row.id), prompt: String(row.prompt), mode: String(row.mode), status: String(row.status),
  workspaceId: String(row.workspace_id), maxIterations: Number(row.max_iterations ?? 12),
  budgetCents: row.budget_cents === null ? null : Number(row.budget_cents), result: row.result ?? undefined,
  errorCode: row.error_code ? String(row.error_code) : null, iterationCount: Number(row.iteration_count ?? 0),
  createdAt: new Date(String(row.created_at)).toISOString(),
  completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null
});

const toEvent = (row: Record<string, unknown>): TaskEventRecord => ({
  id: String(row.id), taskId: String(row.task_id), type: String(row.event_type), payload: row.payload,
  createdAt: new Date(String(row.created_at)).toISOString()
});

const toWorkspace = (row: Record<string, unknown>): WorkspaceRecord => ({
  id: String(row.id), name: String(row.name), ownerId: String(row.owner_id), createdAt: new Date(String(row.created_at)).toISOString()
});

class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly sql: NeonQueryFunction<false, false>) {}

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const rows = await this.sql`
      INSERT INTO tasks (workspace_id, prompt, mode, status, max_iterations, budget_cents)
      VALUES (${input.workspaceId}::uuid, ${input.prompt}, ${input.mode}, 'queued', ${input.maxIterations ?? 12}, ${input.budgetCents ?? null})
      RETURNING id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at
    `;
    return toTask(rows[0] as Record<string, unknown>);
  }

  async get(id: string): Promise<TaskRecord | null> {
    const rows = await this.sql`SELECT id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at FROM tasks WHERE id = ${id}::uuid`;
    return rows.length ? toTask(rows[0] as Record<string, unknown>) : null;
  }

  async claimNextQueued(): Promise<TaskRecord | null> {
    const rows = await this.sql`
      WITH next_task AS (
        SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE tasks SET status = 'planning'
      WHERE id IN (SELECT id FROM next_task)
      RETURNING id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at
    `;
    return rows.length ? toTask(rows[0] as Record<string, unknown>) : null;
  }

  async updateStatus(id: string, status: string): Promise<TaskRecord | null> {
    const rows = await this.sql`
      UPDATE tasks SET status = ${status}, completed_at = CASE WHEN ${status} IN ('completed','failed','cancelled') THEN now() ELSE completed_at END
      WHERE id = ${id}::uuid
      RETURNING id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at
    `;
    return rows.length ? toTask(rows[0] as Record<string, unknown>) : null;
  }

  async updateExecution(id: string, input: { status: string; result?: unknown; errorCode?: string; iterationCount: number }): Promise<TaskRecord | null> {
    const rows = await this.sql`
      UPDATE tasks SET status = ${input.status}, result = ${input.result === undefined ? null : JSON.stringify(input.result)}::jsonb,
        error_code = ${input.errorCode ?? null}, iteration_count = ${input.iterationCount},
        completed_at = CASE WHEN ${input.status} IN ('completed','failed','cancelled') THEN now() ELSE completed_at END
      WHERE id = ${id}::uuid
      RETURNING id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at
    `;
    return rows.length ? toTask(rows[0] as Record<string, unknown>) : null;
  }

  async addEvent(taskId: string, type: string, payload: unknown): Promise<TaskEventRecord> {
    const rows = await this.sql`INSERT INTO task_events (task_id, event_type, payload) VALUES (${taskId}::uuid, ${type}, ${JSON.stringify(payload)}::jsonb) RETURNING id, task_id, event_type, payload, created_at`;
    return toEvent(rows[0] as Record<string, unknown>);
  }

  async listEvents(taskId: string): Promise<TaskEventRecord[]> {
    const rows = await this.sql`SELECT id, task_id, event_type, payload, created_at FROM task_events WHERE task_id = ${taskId}::uuid ORDER BY created_at ASC`;
    return rows.map(row => toEvent(row as Record<string, unknown>));
  }

  async createWorkspace(input: { email: string; displayName?: string; workspaceName?: string }): Promise<WorkspaceRecord> {
    const rows = await this.sql`
      WITH new_user AS (
        INSERT INTO users (email, display_name) VALUES (${input.email}, ${input.displayName ?? null})
        ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, users.display_name)
        RETURNING id
      )
      INSERT INTO workspaces (name, owner_id)
      SELECT ${input.workspaceName ?? 'NexaForge Workspace'}, id FROM new_user
      RETURNING id, name, owner_id, created_at
    `;
    return toWorkspace(rows[0] as Record<string, unknown>);
  }

  async workspaceExists(id: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM workspaces WHERE id = ${id}::uuid LIMIT 1`;
    return rows.length > 0;
  }
}

export function createTaskRepository(databaseUrl = process.env.DATABASE_URL): TaskRepository | null {
  if (!databaseUrl) return null;
  return new PostgresTaskRepository(neon(databaseUrl));
}
