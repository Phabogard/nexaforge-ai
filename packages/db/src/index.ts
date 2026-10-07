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


export type PermissionRecord = { id: string; userId: string; workspaceId?: string | null; agentId?: string | null; capability: string; status: string; scope: unknown; expiresAt?: string | null; grantedBy?: string | null; createdAt: string; updatedAt: string };
export type SecurityPolicyRecord = { id: string; workspaceId?: string | null; capability: string; riskLevel: string; policyAction: string; createdAt: string; updatedAt: string };
export type AuditLogRecord = { id: string; requestId?: string | null; actor: string; actorType: string; userId?: string | null; workspaceId?: string | null; agentId?: string | null; applicationId?: string | null; capability: string; tool?: string | null; action: string; status: string; reason?: string | null; payload: unknown; createdAt: string };
export type AgentSessionRecord = { id: string; userId: string; workspaceId?: string | null; agentType: string; status: string; grantedCapabilities: string[]; metadata: unknown; createdAt: string; expiresAt?: string | null };

export interface PermissionRepository {
  grantPermission(input: { userId: string; workspaceId?: string; agentId?: string; capability: string; scope?: unknown; expiresAt?: string; grantedBy?: string }): Promise<PermissionRecord>;
  getPermission(userId: string, capability: string, workspaceId?: string, agentId?: string): Promise<PermissionRecord | null>;
  listPermissions(userId: string, workspaceId?: string): Promise<PermissionRecord[]>;
  revokePermission(userId: string, capability: string, workspaceId?: string): Promise<boolean>;
  upsertPolicy(input: { workspaceId?: string; capability: string; riskLevel: string; policyAction: string }): Promise<SecurityPolicyRecord>;
  getPolicy(capability: string, workspaceId?: string): Promise<SecurityPolicyRecord | null>;
  addAuditLog(input: { requestId?: string; actor: string; actorType: string; userId?: string; workspaceId?: string; agentId?: string; applicationId?: string; capability: string; tool?: string; action: string; status: string; reason?: string; payload?: unknown }): Promise<AuditLogRecord>;
  listAuditLogs(filter: { userId?: string; workspaceId?: string; limit?: number }): Promise<AuditLogRecord[]>;
  createAgentSession(input: { userId: string; workspaceId?: string; agentType: string; grantedCapabilities?: string[]; metadata?: unknown; expiresAt?: string }): Promise<AgentSessionRecord>;
  getAgentSession(id: string): Promise<AgentSessionRecord | null>;
  revokeAgentSession(id: string): Promise<boolean>;
  consumeApproval(input: { approvalId: string; actionId: string; userId: string; workspaceId?: string; agentId?: string }): Promise<boolean>;
  reserveAction(input: { actionId: string; userId: string; workspaceId?: string; agentId?: string }): Promise<{ reserved: boolean; existingStatus?: string }>;
  updateActionStatus(input: { actionId: string; userId: string; workspaceId?: string; agentId?: string; status: 'executed' | 'failed' | 'cancelled' }): Promise<boolean>;
  recordExecutedAction(input: { actionId: string; userId: string; workspaceId?: string; agentId?: string; status: string }): Promise<boolean>;
  isActionExecuted(actionId: string): Promise<boolean>;
}

export type WorkspaceRecord = {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
};

export type ApplicationProjectRecord = { id:string; workspaceId:string; name:string; description:string; status:string; createdAt:string; updatedAt:string };
export type ApplicationBuildRecord = { id:string; projectId:string; status:string; phase:string; request:unknown; result?:unknown; errorCode?:string|null; repairAttempts:number; createdAt:string; completedAt?:string|null; leaseOwner?:string|null; leaseUntil?:string|null };
export type ApplicationBuildStepRecord = { id:string; buildId:string; stepKey:string; phase:string; status:string; attempt:number; input?:unknown; output?:unknown; errorCode?:string|null };
export type ApplicationBuildEventRecord = { id:string; buildId:string; eventType:string; phase:string; payload:unknown; createdAt:string };
export type ApplicationBuildApprovalRecord = { id:string; buildId:string; stepKey:string; status:string; reason:string; decidedAt?:string|null; createdAt:string };
export type ApplicationDeploymentRecord = { id:string; projectId:string; buildId:string|null; provider:string; environment:string; status:string; externalId?:string|null; url?:string|null; metadata:unknown; createdAt:string; completedAt?:string|null; leaseOwner?:string|null; leaseUntil?:string|null };
export interface ApplicationRepository {
  createProject(input:{workspaceId:string;name:string;description?:string}):Promise<ApplicationProjectRecord>;
  getProject(id:string):Promise<ApplicationProjectRecord|null>;
  createBuild(input:{projectId:string;request:unknown}):Promise<ApplicationBuildRecord>;
  getBuild(id:string):Promise<ApplicationBuildRecord|null>;
  getBuildSteps(buildId:string):Promise<ApplicationBuildStepRecord[]>;
  claimNextBuild(workerId?:string,leaseSeconds?:number):Promise<ApplicationBuildRecord|null>;
  renewBuildLease(id:string,workerId:string,leaseSeconds?:number):Promise<boolean>;
  claimNextDeployment(workerId?:string,leaseSeconds?:number):Promise<ApplicationDeploymentRecord|null>;
  renewDeploymentLease(id:string,workerId:string,leaseSeconds?:number):Promise<boolean>;
  updateBuild(id:string,input:{status:string;phase:string;result?:unknown;errorCode?:string;repairAttempts?:number}):Promise<ApplicationBuildRecord|null>;
  upsertBuildStep(input:{buildId:string;stepKey:string;phase:string;status:string;attempt?:number;input?:unknown;output?:unknown;errorCode?:string}):Promise<ApplicationBuildStepRecord>;
  addBuildEvent(input:{buildId:string;eventType:string;phase:string;payload?:unknown}):Promise<ApplicationBuildEventRecord>;
  listBuildEvents(buildId:string):Promise<ApplicationBuildEventRecord[]>;
  getApproval(buildId:string,stepKey:string):Promise<ApplicationBuildApprovalRecord|null>;
  requestApproval(input:{buildId:string;stepKey:string;reason:string}):Promise<ApplicationBuildApprovalRecord>;
  decideApproval(buildId:string,stepKey:string,status:'approved'|'rejected'):Promise<ApplicationBuildApprovalRecord|null>;
  createProjectVersion(input:{projectId:string;blueprint:unknown}):Promise<{id:string;projectId:string;version:number;blueprint:unknown;createdAt:string}>;
  addArtifact(input:{projectVersionId:string;path:string;kind:string;contentHash:string;sizeBytes:number}):Promise<void>;
  listArtifacts(projectVersionId:string):Promise<Array<{id:string;projectVersionId:string;path:string;kind:string;contentHash:string;sizeBytes:number;createdAt:string}>>;
  listBuilds(projectId:string):Promise<ApplicationBuildRecord[]>;
  createDeployment(input:{projectId:string;buildId?:string;provider:string;environment?:string;metadata?:unknown}):Promise<ApplicationDeploymentRecord>;
  getDeployment(id:string):Promise<ApplicationDeploymentRecord|null>;
  updateDeployment(id:string,input:{status:string;externalId?:string;url?:string;metadata?:unknown}):Promise<ApplicationDeploymentRecord|null>;
  listDeployments(projectId:string):Promise<ApplicationDeploymentRecord[]>;
}

export interface TaskRepository {
  ping(): Promise<boolean>;
  create(input: CreateTaskInput): Promise<TaskRecord>;
  get(id: string): Promise<TaskRecord | null>;
  claimNextQueued(): Promise<TaskRecord | null>;
  updateStatus(id: string, status: string): Promise<TaskRecord | null>;
  updateExecution(id: string, input: { status: string; result?: unknown; errorCode?: string; iterationCount: number }): Promise<TaskRecord | null>;
  addEvent(taskId: string, type: string, payload: unknown): Promise<TaskEventRecord>;
  listEvents(taskId: string): Promise<TaskEventRecord[]>;
  createWorkspace(input: { email: string; displayName?: string; workspaceName?: string }): Promise<WorkspaceRecord>;
  workspaceExists(id: string): Promise<boolean>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  getOrCreateDefaultWorkspace(): Promise<WorkspaceRecord>;
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
  private readonly sql: NeonQueryFunction<false, false>;
  constructor(sql: NeonQueryFunction<false, false>) { this.sql = sql; }
  async ping(): Promise<boolean> { try { const rows = await this.sql`SELECT 1 as alive`; return rows.length > 0; } catch { return false; } }
  async create(input: CreateTaskInput): Promise<TaskRecord> { const rows = await this.sql`INSERT INTO tasks (workspace_id, prompt, mode, status, max_iterations, budget_cents) VALUES (${input.workspaceId}::uuid, ${input.prompt}, ${input.mode}, 'queued', ${input.maxIterations ?? 12}, ${input.budgetCents ?? null}) RETURNING id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at`; return toTask(rows[0] as Record<string, unknown>); }
  async get(id: string): Promise<TaskRecord | null> { const rows = await this.sql`SELECT id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at FROM tasks WHERE id = ${id}::uuid`; return rows.length ? toTask(rows[0] as Record<string, unknown>) : null; }
  async claimNextQueued(): Promise<TaskRecord | null> { const rows = await this.sql`WITH next_task AS (SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE tasks SET status = 'planning' WHERE id IN (SELECT id FROM next_task) RETURNING id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at`; return rows.length ? toTask(rows[0] as Record<string, unknown>) : null; }
  async updateStatus(id: string, status: string): Promise<TaskRecord | null> { const rows = await this.sql`UPDATE tasks SET status = ${status}, completed_at = CASE WHEN ${status} IN ('completed','failed','cancelled') THEN now() ELSE completed_at END WHERE id = ${id}::uuid RETURNING id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at`; return rows.length ? toTask(rows[0] as Record<string, unknown>) : null; }
  async updateExecution(id: string, input: { status: string; result?: unknown; errorCode?: string; iterationCount: number }): Promise<TaskRecord | null> { const rows = await this.sql`UPDATE tasks SET status = ${input.status}, result = ${input.result === undefined ? null : JSON.stringify(input.result)}::jsonb, error_code = ${input.errorCode ?? null}, iteration_count = ${input.iterationCount}, completed_at = CASE WHEN ${input.status} IN ('completed','failed','cancelled') THEN now() ELSE completed_at END WHERE id = ${id}::uuid RETURNING id, workspace_id, prompt, mode, status, max_iterations, budget_cents, result, error_code, iteration_count, created_at, completed_at`; return rows.length ? toTask(rows[0] as Record<string, unknown>) : null; }
  async addEvent(taskId: string, type: string, payload: unknown): Promise<TaskEventRecord> { const rows = await this.sql`INSERT INTO task_events (task_id, event_type, payload) VALUES (${taskId}::uuid, ${type}, ${JSON.stringify(payload)}::jsonb) RETURNING id, task_id, event_type, payload, created_at`; return toEvent(rows[0] as Record<string, unknown>); }
  async listEvents(taskId: string): Promise<TaskEventRecord[]> { const rows = await this.sql`SELECT id, task_id, event_type, payload, created_at FROM task_events WHERE task_id = ${taskId}::uuid ORDER BY created_at ASC`; return rows.map(row => toEvent(row as Record<string, unknown>)); }
  async createWorkspace(input: { email: string; displayName?: string; workspaceName?: string }): Promise<WorkspaceRecord> { const rows = await this.sql`WITH new_user AS (INSERT INTO users (email, display_name) VALUES (${input.email}, ${input.displayName ?? null}) ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, users.display_name) RETURNING id) INSERT INTO workspaces (name, owner_id) SELECT ${input.workspaceName ?? 'NexaForge Workspace'}, id FROM new_user RETURNING id, name, owner_id, created_at`; return toWorkspace(rows[0] as Record<string, unknown>); }
  async workspaceExists(id: string): Promise<boolean> { const rows = await this.sql`SELECT 1 FROM workspaces WHERE id = ${id}::uuid LIMIT 1`; return rows.length > 0; }
  async getWorkspace(id: string): Promise<WorkspaceRecord | null> { const rows = await this.sql`SELECT id, name, owner_id, created_at FROM workspaces WHERE id = ${id}::uuid LIMIT 1`; return rows.length ? toWorkspace(rows[0] as Record<string, unknown>) : null; }
  async getOrCreateDefaultWorkspace(): Promise<WorkspaceRecord> { const existing = await this.sql`SELECT id, name, owner_id, created_at FROM workspaces ORDER BY created_at ASC LIMIT 1`; if (existing.length > 0) return toWorkspace(existing[0] as Record<string, unknown>); return this.createWorkspace({ email:'default@nexaforge.ai', displayName:'Default User', workspaceName:'Default Workspace' }); }
}

export function createTaskRepository(databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL): TaskRepository | null { if (!databaseUrl) return null; return new PostgresTaskRepository(neon(databaseUrl)); }

const applicationProject = (r:Record<string,unknown>):ApplicationProjectRecord => ({ id:String(r.id), workspaceId:String(r.workspace_id), name:String(r.name), description:String(r.description??''), status:String(r.status), createdAt:new Date(String(r.created_at)).toISOString(), updatedAt:new Date(String(r.updated_at)).toISOString() });
const applicationBuild = (r:Record<string,unknown>):ApplicationBuildRecord => ({ id:String(r.id), projectId:String(r.project_id), status:String(r.status), phase:String(r.phase), request:r.request, result:r.result??undefined, errorCode:r.error_code?String(r.error_code):null, repairAttempts:Number(r.repair_attempts??0), createdAt:new Date(String(r.created_at)).toISOString(), completedAt:r.completed_at?new Date(String(r.completed_at)).toISOString():null, leaseOwner:r.lease_owner?String(r.lease_owner):null, leaseUntil:r.lease_until?new Date(String(r.lease_until)).toISOString():null });
const applicationDeployment = (r:Record<string,unknown>):ApplicationDeploymentRecord => ({ id:String(r.id), projectId:String(r.project_id), buildId:r.build_id?String(r.build_id):null, provider:String(r.provider), environment:String(r.environment), status:String(r.status), externalId:r.external_id?String(r.external_id):null, url:r.url?String(r.url):null, metadata:r.metadata??{}, createdAt:new Date(String(r.created_at)).toISOString(), completedAt:r.completed_at?new Date(String(r.completed_at)).toISOString():null, leaseOwner:r.lease_owner?String(r.lease_owner):null, leaseUntil:r.lease_until?new Date(String(r.lease_until)).toISOString():null });
const approval = (x:Record<string,unknown>):ApplicationBuildApprovalRecord => ({ id:String(x.id), buildId:String(x.build_id), stepKey:String(x.step_key), status:String(x.status), reason:String(x.reason??''), decidedAt:x.decided_at?new Date(String(x.decided_at)).toISOString():null, createdAt:new Date(String(x.created_at)).toISOString() });

export function createApplicationRepository(databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL): ApplicationRepository | null {
  if (!databaseUrl) return null;
  const sql = neon(databaseUrl);
  return {
    async createProject(i){const r=await sql`INSERT INTO application_projects(workspace_id,name,description) VALUES(${i.workspaceId}::uuid,${i.name},${i.description??''}) RETURNING *`;return applicationProject(r[0] as Record<string,unknown>);},
    async getProject(id){const r=await sql`SELECT * FROM application_projects WHERE id=${id}::uuid`;return r.length?applicationProject(r[0] as Record<string,unknown>):null;},
    async createBuild(i){const r=await sql`INSERT INTO application_builds(project_id,request) VALUES(${i.projectId}::uuid,${JSON.stringify(i.request)}::jsonb) RETURNING *`;return applicationBuild(r[0] as Record<string,unknown>);},
    async getBuild(id){const r=await sql`SELECT * FROM application_builds WHERE id=${id}::uuid`;return r.length?applicationBuild(r[0] as Record<string,unknown>):null;},
    async getBuildSteps(buildId){const r=await sql`SELECT * FROM application_build_steps WHERE build_id=${buildId}::uuid ORDER BY step_key`;return r.map(x=>{const q=x as Record<string,unknown>;return{id:String(q.id),buildId:String(q.build_id),stepKey:String(q.step_key),phase:String(q.phase),status:String(q.status),attempt:Number(q.attempt??0),input:q.input??undefined,output:q.output??undefined,errorCode:q.error_code?String(q.error_code):null};});},
    async claimNextBuild(workerId='application-worker',leaseSeconds=60){const r=await sql`WITH n AS(SELECT id FROM application_builds WHERE status='queued' OR (status='building' AND lease_until < now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE application_builds SET status='building',phase=CASE WHEN status='queued' THEN 'planning' ELSE phase END,lease_owner=${workerId},lease_until=now()+(${leaseSeconds}||' seconds')::interval WHERE id IN(SELECT id FROM n) RETURNING *`;return r.length?applicationBuild(r[0] as Record<string,unknown>):null;},
    async renewBuildLease(id,workerId,leaseSeconds=60){const r=await sql`UPDATE application_builds SET lease_until=now()+(${leaseSeconds}||' seconds')::interval WHERE id=${id}::uuid AND lease_owner=${workerId} AND status='building' AND lease_until > now() RETURNING id`;return r.length>0;},
    async updateBuild(id,i){const terminal=['completed','failed','cancelled'];const r=await sql`UPDATE application_builds SET status=${i.status},phase=${i.phase},result=${i.result===undefined?null:JSON.stringify(i.result)}::jsonb,error_code=${i.errorCode??null},repair_attempts=COALESCE(${i.repairAttempts??null},repair_attempts),completed_at=CASE WHEN ${terminal.includes(i.status)} THEN now() ELSE completed_at END,lease_owner=CASE WHEN ${terminal.includes(i.status)} THEN NULL ELSE lease_owner END,lease_until=CASE WHEN ${terminal.includes(i.status)} THEN NULL ELSE lease_until END WHERE id=${id}::uuid RETURNING *`;return r.length?applicationBuild(r[0] as Record<string,unknown>):null;},
    async upsertBuildStep(i){const r=await sql`INSERT INTO application_build_steps(build_id,step_key,phase,status,attempt,input,output,error_code,started_at,completed_at) VALUES(${i.buildId}::uuid,${i.stepKey},${i.phase},${i.status},${i.attempt??0},${i.input===undefined?null:JSON.stringify(i.input)}::jsonb,${i.output===undefined?null:JSON.stringify(i.output)}::jsonb,${i.errorCode??null},CASE WHEN ${i.status}='running' THEN now() ELSE NULL END,CASE WHEN ${i.status} IN('completed','failed','cancelled') THEN now() ELSE NULL END) ON CONFLICT(build_id,step_key) DO UPDATE SET phase=EXCLUDED.phase,status=EXCLUDED.status,attempt=EXCLUDED.attempt,input=EXCLUDED.input,output=EXCLUDED.output,error_code=EXCLUDED.error_code,started_at=COALESCE(application_build_steps.started_at,EXCLUDED.started_at),completed_at=EXCLUDED.completed_at RETURNING *`;const x=r[0] as Record<string,unknown>;return{id:String(x.id),buildId:String(x.build_id),stepKey:String(x.step_key),phase:String(x.phase),status:String(x.status),attempt:Number(x.attempt),input:x.input??undefined,output:x.output??undefined,errorCode:x.error_code?String(x.error_code):null};},
    async addBuildEvent(i){const r=await sql`INSERT INTO application_build_events(build_id,event_type,phase,payload) VALUES(${i.buildId}::uuid,${i.eventType},${i.phase},${JSON.stringify(i.payload??{})}::jsonb) RETURNING *`;const x=r[0] as Record<string,unknown>;return{id:String(x.id),buildId:String(x.build_id),eventType:String(x.event_type),phase:String(x.phase),payload:x.payload,createdAt:new Date(String(x.created_at)).toISOString()};},
    async listBuildEvents(buildId){const r=await sql`SELECT * FROM application_build_events WHERE build_id=${buildId}::uuid ORDER BY created_at ASC`;return r.map(x=>{const q=x as Record<string,unknown>;return{id:String(q.id),buildId:String(q.build_id),eventType:String(q.event_type),phase:String(q.phase),payload:q.payload,createdAt:new Date(String(q.created_at)).toISOString()};});},
    async getApproval(buildId,stepKey){const r=await sql`SELECT * FROM application_build_approvals WHERE build_id=${buildId}::uuid AND step_key=${stepKey}`;return r.length?approval(r[0] as Record<string,unknown>):null;},
    async requestApproval(i){const r=await sql`INSERT INTO application_build_approvals(build_id,step_key,reason) VALUES(${i.buildId}::uuid,${i.stepKey},${i.reason}) ON CONFLICT(build_id,step_key) DO UPDATE SET reason=EXCLUDED.reason,status=CASE WHEN application_build_approvals.status='rejected' THEN 'pending' ELSE application_build_approvals.status END RETURNING *`;return approval(r[0] as Record<string,unknown>);},
    async decideApproval(buildId,stepKey,status){const r=await sql`UPDATE application_build_approvals SET status=${status},decided_at=now() WHERE build_id=${buildId}::uuid AND step_key=${stepKey} RETURNING *`;return r.length?approval(r[0] as Record<string,unknown>):null;},
    async createProjectVersion(i){const r=await sql`WITH v AS(SELECT COALESCE(MAX(version),0)+1 AS next_ver FROM application_project_versions WHERE project_id=${i.projectId}::uuid) INSERT INTO application_project_versions(project_id,version,blueprint) SELECT ${i.projectId}::uuid,v.next_ver,${JSON.stringify(i.blueprint)}::jsonb FROM v RETURNING *`;const x=r[0] as Record<string,unknown>;return{id:String(x.id),projectId:String(x.project_id),version:Number(x.version),blueprint:x.blueprint,createdAt:new Date(String(x.created_at)).toISOString()};},
    async addArtifact(i){await sql`INSERT INTO application_artifacts(project_version_id,path,kind,content_hash,size_bytes) VALUES(${i.projectVersionId}::uuid,${i.path},${i.kind},${i.contentHash},${i.sizeBytes}) ON CONFLICT(project_version_id,path) DO UPDATE SET kind=EXCLUDED.kind,content_hash=EXCLUDED.content_hash,size_bytes=EXCLUDED.size_bytes`;},
    async listArtifacts(projectVersionId){const r=await sql`SELECT * FROM application_artifacts WHERE project_version_id=${projectVersionId}::uuid ORDER BY path ASC`;return r.map(x=>{const q=x as Record<string,unknown>;return{id:String(q.id),projectVersionId:String(q.project_version_id),path:String(q.path),kind:String(q.kind),contentHash:String(q.content_hash),sizeBytes:Number(q.size_bytes),createdAt:new Date(String(q.created_at)).toISOString()};});},
    async listBuilds(projectId){const r=await sql`SELECT * FROM application_builds WHERE project_id=${projectId}::uuid ORDER BY created_at DESC`;return r.map(x=>applicationBuild(x as Record<string,unknown>));},
    async createDeployment(i){const r=await sql`INSERT INTO application_deployments(project_id,build_id,provider,environment,metadata) VALUES(${i.projectId}::uuid,${i.buildId?i.buildId:null}::uuid,${i.provider},${i.environment??'production'},${JSON.stringify(i.metadata??{})}::jsonb) RETURNING *`;return applicationDeployment(r[0] as Record<string,unknown>);},
    async getDeployment(id){const r=await sql`SELECT * FROM application_deployments WHERE id=${id}::uuid`;return r.length?applicationDeployment(r[0] as Record<string,unknown>):null;},
    async listDeployments(projectId){const r=await sql`SELECT * FROM application_deployments WHERE project_id=${projectId}::uuid ORDER BY created_at DESC`;return r.map(x=>applicationDeployment(x as Record<string,unknown>));},
    async claimNextDeployment(workerId='deployment-worker',leaseSeconds=60){const r=await sql`WITH n AS(SELECT id FROM application_deployments WHERE status='queued' OR (status='deploying' AND lease_until < now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE application_deployments SET status='deploying',lease_owner=${workerId},lease_until=now()+(${leaseSeconds}||' seconds')::interval WHERE id IN(SELECT id FROM n) RETURNING *`;return r.length?applicationDeployment(r[0] as Record<string,unknown>):null;},
    async renewDeploymentLease(id,workerId,leaseSeconds=60){const r=await sql`UPDATE application_deployments SET lease_until=now()+(${leaseSeconds}||' seconds')::interval WHERE id=${id}::uuid AND lease_owner=${workerId} AND status='deploying' AND lease_until > now() RETURNING id`;return r.length>0;},
    async updateDeployment(id,i){const terminal=['ready','failed','cancelled'];const r=await sql`UPDATE application_deployments SET status=${i.status},external_id=COALESCE(${i.externalId??null},external_id),url=COALESCE(${i.url??null},url),metadata=CASE WHEN ${i.metadata===undefined} THEN metadata ELSE ${JSON.stringify(i.metadata)}::jsonb END,completed_at=CASE WHEN ${terminal.includes(i.status)} THEN now() ELSE completed_at END,lease_owner=CASE WHEN ${terminal.includes(i.status)} THEN NULL ELSE lease_owner END,lease_until=CASE WHEN ${terminal.includes(i.status)} THEN NULL ELSE lease_until END WHERE id=${id}::uuid RETURNING *`;return r.length?applicationDeployment(r[0] as Record<string,unknown>):null;}
  };
}


const toPermission = (r: Record<string, unknown>): PermissionRecord => ({
  id: String(r.id), userId: String(r.user_id), workspaceId: r.workspace_id ? String(r.workspace_id) : null,
  agentId: r.agent_id ? String(r.agent_id) : null, capability: String(r.capability), status: String(r.status),
  scope: r.scope ?? {}, expiresAt: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null,
  grantedBy: r.granted_by ? String(r.granted_by) : null, createdAt: new Date(String(r.created_at)).toISOString(),
  updatedAt: new Date(String(r.updated_at)).toISOString()
});

const toPolicy = (r: Record<string, unknown>): SecurityPolicyRecord => ({
  id: String(r.id), workspaceId: r.workspace_id ? String(r.workspace_id) : null, capability: String(r.capability),
  riskLevel: String(r.risk_level), policyAction: String(r.policy_action),
  createdAt: new Date(String(r.created_at)).toISOString(), updatedAt: new Date(String(r.updated_at)).toISOString()
});

const toAuditLog = (r: Record<string, unknown>): AuditLogRecord => ({
  id: String(r.id), requestId: r.request_id ? String(r.request_id) : null, actor: String(r.actor),
  actorType: String(r.actor_type), userId: r.user_id ? String(r.user_id) : null,
  workspaceId: r.workspace_id ? String(r.workspace_id) : null, agentId: r.agent_id ? String(r.agent_id) : null,
  applicationId: r.application_id ? String(r.application_id) : null, capability: String(r.capability),
  tool: r.tool ? String(r.tool) : null, action: String(r.action), status: String(r.status),
  reason: r.reason ? String(r.reason) : null, payload: r.payload ?? {},
  createdAt: new Date(String(r.created_at)).toISOString()
});

const toAgentSession = (r: Record<string, unknown>): AgentSessionRecord => ({
  id: String(r.id), userId: String(r.user_id), workspaceId: r.workspace_id ? String(r.workspace_id) : null,
  agentType: String(r.agent_type), status: String(r.status),
  grantedCapabilities: Array.isArray(r.granted_capabilities) ? r.granted_capabilities.map(String) : [],
  metadata: r.metadata ?? {}, createdAt: new Date(String(r.created_at)).toISOString(),
  expiresAt: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null
});

export function createPermissionRepository(databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL): PermissionRepository | null {
  if (!databaseUrl) return null;
  const sql = neon(databaseUrl);
  return {
    async grantPermission(i) {
      const r = await sql`INSERT INTO permissions(user_id, workspace_id, agent_id, capability, scope, expires_at, granted_by) VALUES(${i.userId}, ${i.workspaceId ? i.workspaceId : null}::uuid, ${i.agentId ?? null}, ${i.capability}, ${JSON.stringify(i.scope ?? {})}::jsonb, ${i.expiresAt ? new Date(i.expiresAt) : null}, ${i.grantedBy ?? null}) RETURNING *`;
      return toPermission(r[0] as Record<string, unknown>);
    },
    async getPermission(userId, capability, workspaceId, agentId) {
      const r = await sql`SELECT * FROM permissions WHERE user_id=${userId} AND capability=${capability} AND (${workspaceId ? workspaceId : null}::uuid IS NULL OR workspace_id=${workspaceId ? workspaceId : null}::uuid) AND (${agentId ? agentId : null}::text IS NULL OR agent_id IS NULL OR agent_id=${agentId ? agentId : null}) AND status = 'granted' AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 1`;
      return r.length ? toPermission(r[0] as Record<string, unknown>) : null;
    },
    async listPermissions(userId, workspaceId) {
      const r = await sql`SELECT * FROM permissions WHERE user_id=${userId} AND (workspace_id IS NULL OR workspace_id=${workspaceId ? workspaceId : null}::uuid) ORDER BY created_at DESC`;
      return r.map(x => toPermission(x as Record<string, unknown>));
    },
    async revokePermission(userId, capability, workspaceId) {
      const r = await sql`UPDATE permissions SET status='revoked', updated_at=now() WHERE user_id=${userId} AND capability=${capability} AND (workspace_id IS NULL OR workspace_id=${workspaceId ? workspaceId : null}::uuid) RETURNING id`;
      return r.length > 0;
    },
    async upsertPolicy(i) {
      const r = await sql`INSERT INTO security_policies(workspace_id, capability, risk_level, policy_action) VALUES(${i.workspaceId ? i.workspaceId : null}::uuid, ${i.capability}, ${i.riskLevel}, ${i.policyAction}) RETURNING *`;
      return toPolicy(r[0] as Record<string, unknown>);
    },
    async getPolicy(capability, workspaceId) {
      const r = await sql`SELECT * FROM security_policies WHERE capability=${capability} AND (workspace_id IS NULL OR workspace_id=${workspaceId ? workspaceId : null}::uuid) ORDER BY created_at DESC LIMIT 1`;
      return r.length ? toPolicy(r[0] as Record<string, unknown>) : null;
    },
    async addAuditLog(i) {
      const r = await sql`INSERT INTO audit_logs(request_id, actor, actor_type, user_id, workspace_id, agent_id, application_id, capability, tool, action, status, reason, payload) VALUES(${i.requestId ?? null}, ${i.actor}, ${i.actorType}, ${i.userId ?? null}, ${i.workspaceId ? i.workspaceId : null}::uuid, ${i.agentId ?? null}, ${i.applicationId ? i.applicationId : null}::uuid, ${i.capability}, ${i.tool ?? null}, ${i.action}, ${i.status}, ${i.reason ?? null}, ${JSON.stringify(i.payload ?? {})}::jsonb) RETURNING *`;
      return toAuditLog(r[0] as Record<string, unknown>);
    },
    async listAuditLogs(filter) {
      const limit = filter.limit ?? 50;
      const r = await sql`SELECT * FROM audit_logs WHERE (${filter.userId ?? null}::text IS NULL OR user_id=${filter.userId}) AND (${filter.workspaceId ?? null}::uuid IS NULL OR workspace_id=${filter.workspaceId ? filter.workspaceId : null}::uuid) ORDER BY created_at DESC LIMIT ${limit}`;
      return r.map(x => toAuditLog(x as Record<string, unknown>));
    },
    async createAgentSession(i) {
      const r = await sql`INSERT INTO agent_sessions(user_id, workspace_id, agent_type, granted_capabilities, metadata, expires_at) VALUES(${i.userId}, ${i.workspaceId ? i.workspaceId : null}::uuid, ${i.agentType}, ${JSON.stringify(i.grantedCapabilities ?? [])}::jsonb, ${JSON.stringify(i.metadata ?? {})}::jsonb, ${i.expiresAt ? new Date(i.expiresAt) : null}) RETURNING *`;
      return toAgentSession(r[0] as Record<string, unknown>);
    },
    async getAgentSession(id) {
      const r = await sql`SELECT * FROM agent_sessions WHERE id=${id}::uuid AND status='active' AND (expires_at IS NULL OR expires_at > now())`;
      return r.length ? toAgentSession(r[0] as Record<string, unknown>) : null;
    },
    async revokeAgentSession(id) {
      const r = await sql`UPDATE agent_sessions SET status='revoked' WHERE id=${id}::uuid AND status='active' RETURNING id`;
      return r.length > 0;
    },
    async consumeApproval(i) {
      const r = await sql`INSERT INTO consumed_approvals(approval_id, action_id, user_id, workspace_id, agent_id) VALUES(${i.approvalId}, ${i.actionId}, ${i.userId}, ${i.workspaceId ? i.workspaceId : null}::uuid, ${i.agentId ?? null}) ON CONFLICT(approval_id) DO NOTHING RETURNING id`;
      return r.length > 0;
    },
    async reserveAction(i) {
      // Lock an existing action row so retries after failure cannot both
      // transition the same action back to pending concurrently.
      const existing = await sql`
        SELECT status, user_id, workspace_id, agent_id
        FROM executed_actions
        WHERE action_id=${i.actionId}
        FOR UPDATE
      `;

      const requestedWorkspace = i.workspaceId ?? null;
      const requestedAgent = i.agentId ?? null;

      if (existing.length > 0) {
        const row = existing[0];
        const st = String(row.status);
        const existingUser = String(row.user_id);
        const existingWorkspace = row.workspace_id ? String(row.workspace_id) : null;
        const existingAgent = row.agent_id ? String(row.agent_id) : null;

        // actionId is permanently bound to its original execution scope.
        if (
          existingUser !== i.userId ||
          existingWorkspace !== requestedWorkspace ||
          existingAgent !== requestedAgent
        ) {
          return { reserved: false, existingStatus: 'SCOPE_MISMATCH' };
        }

        if (st === 'pending' || st === 'executed') {
          return { reserved: false, existingStatus: st };
        }

        if (st === 'failed' || st === 'cancelled') {
          const updated = await sql`
            UPDATE executed_actions
            SET status='pending', updated_at=now()
            WHERE action_id=${i.actionId}
              AND user_id=${i.userId}
              AND workspace_id IS NOT DISTINCT FROM ${requestedWorkspace}::uuid
              AND agent_id IS NOT DISTINCT FROM ${requestedAgent}
              AND status IN ('failed', 'cancelled')
            RETURNING id
          `;
          return { reserved: updated.length > 0, existingStatus: st };
        }

        return { reserved: false, existingStatus: st };
      }

      // For a new actionId, the UNIQUE(action_id) constraint remains the
      // final arbiter if two transactions race to insert the same action.
      const inserted = await sql`
        INSERT INTO executed_actions(action_id, user_id, workspace_id, agent_id, status)
        VALUES(${i.actionId}, ${i.userId}, ${requestedWorkspace}::uuid, ${requestedAgent}, 'pending')
        ON CONFLICT(action_id) DO NOTHING
        RETURNING id
      `;
      return { reserved: inserted.length > 0 };
    },
    async updateActionStatus(i) {
      const r = await sql`
        UPDATE executed_actions
        SET status=${i.status}, updated_at=now()
        WHERE action_id=${i.actionId}
          AND user_id=${i.userId}
          AND workspace_id IS NOT DISTINCT FROM ${i.workspaceId ?? null}::uuid
          AND agent_id IS NOT DISTINCT FROM ${i.agentId ?? null}
        RETURNING id
      `;
      return r.length > 0;
    },
    async recordExecutedAction(i) {
      const r = await sql`
        INSERT INTO executed_actions(action_id, user_id, workspace_id, agent_id, status)
        VALUES(${i.actionId}, ${i.userId}, ${i.workspaceId ?? null}::uuid, ${i.agentId ?? null}, ${i.status})
        ON CONFLICT(action_id) DO UPDATE
        SET status=EXCLUDED.status, updated_at=now()
        WHERE executed_actions.user_id = EXCLUDED.user_id
          AND executed_actions.workspace_id IS NOT DISTINCT FROM EXCLUDED.workspace_id
          AND executed_actions.agent_id IS NOT DISTINCT FROM EXCLUDED.agent_id
        RETURNING id
      `;
      return r.length > 0;
    },
    async isActionExecuted(actionId) {
      const r = await sql`SELECT 1 FROM executed_actions WHERE action_id=${actionId} AND status='executed' LIMIT 1`;
      return r.length > 0;
    }
  };
}
