import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

export type TaskRecord = {
  id: string;
  prompt: string;
  mode: string;
  status: string;
  workspaceId: string;
  createdAt: string;
  completedAt?: string | null;
};

export type CreateTaskInput = {
  prompt: string;
  mode: string;
  workspaceId: string;
};

export interface TaskRepository {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  get(id: string): Promise<TaskRecord | null>;
  updateStatus(id: string, status: string): Promise<TaskRecord | null>;
}

const toTask = (row: Record<string, unknown>): TaskRecord => ({
  id: String(row.id),
  prompt: String(row.prompt),
  mode: String(row.mode),
  status: String(row.status),
  workspaceId: String(row.workspace_id),
  createdAt: new Date(String(row.created_at)).toISOString(),
  completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null
});

class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly sql: NeonQueryFunction<false, false>) {}

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const rows = await this.sql`
      INSERT INTO tasks (workspace_id, prompt, mode, status)
      VALUES (${input.workspaceId}::uuid, ${input.prompt}, ${input.mode}, 'queued')
      RETURNING id, workspace_id, prompt, mode, status, created_at, completed_at
    `;
    return toTask(rows[0] as Record<string, unknown>);
  }

  async get(id: string): Promise<TaskRecord | null> {
    const rows = await this.sql`
      SELECT id, workspace_id, prompt, mode, status, created_at, completed_at
      FROM tasks WHERE id = ${id}::uuid
    `;
    return rows.length ? toTask(rows[0] as Record<string, unknown>) : null;
  }

  async updateStatus(id: string, status: string): Promise<TaskRecord | null> {
    const rows = await this.sql`
      UPDATE tasks
      SET status = ${status}, completed_at = CASE WHEN ${status} IN ('completed','failed','cancelled') THEN now() ELSE completed_at END
      WHERE id = ${id}::uuid
      RETURNING id, workspace_id, prompt, mode, status, created_at, completed_at
    `;
    return rows.length ? toTask(rows[0] as Record<string, unknown>) : null;
  }
}

export function createTaskRepository(databaseUrl = process.env.DATABASE_URL): TaskRepository | null {
  if (!databaseUrl) return null;
  return new PostgresTaskRepository(neon(databaseUrl));
}
