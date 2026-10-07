import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTaskRepository, createApplicationRepository, type TaskRepository, type TaskRecord, type TaskEventRecord } from '@nexaforge/db';
import type { AgentMode } from '@nexaforge/shared';
import { configuredWorker, type TaskWorker } from './task-worker.js';
import { ApplicationDeploymentWorker } from './deployment-worker.js';
import { createPermissionRepository } from '@nexaforge/db';
import { verifyBearerToken } from './auth.js';

export const app = Fastify({ logger: true });
const isProduction = process.env.NODE_ENV === 'production';

const memoryTasks = new Map<string, TaskRecord>();
const memoryEvents = new Map<string, TaskEventRecord[]>();

export const repository: TaskRepository | null = createTaskRepository();
export const applicationRepository = createApplicationRepository();

if (isProduction && !repository) {
  app.log.error('DATABASE_URL is required in production mode. Memory fallback is strictly disabled.');
  process.exit(1);
}

export const worker: TaskWorker | null = repository ? configuredWorker(repository) : null;
export const deploymentWorker = applicationRepository ? new ApplicationDeploymentWorker(applicationRepository) : null;

const taskSchema = z.object({
  prompt: z.string().min(1).max(20000),
  mode: z.string().default('auto'),
  workspaceId: z.string().uuid().optional(),
  maxIterations: z.number().int().min(1).max(50).default(12),
  budgetCents: z.number().int().min(0).optional()
});

const bootstrapSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120).optional(),
  workspaceName: z.string().min(1).max(120).optional()
});

const applicationProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(5000).optional(),
  workspaceId: z.string().uuid().optional()
});

const applicationBuildSchema = z.object({
  prompt: z.string().min(1).max(30000),
  maxIterations: z.number().int().min(1).max(50).default(12),
  maxRepairAttempts: z.number().int().min(0).max(10).default(3)
});

const applicationDeploymentSchema = z.object({
  provider: z.enum(['local', 'render']),
  environment: z.string().min(1).max(64).default('production'),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const securityRepository = createPermissionRepository();
const authorizationErrors = new Set([
  'AGENT_SESSION_INVALID_OR_REVOKED',
  'AGENT_SESSION_SCOPE_MISMATCH',
  'AGENT_SESSION_SCOPE_MISSING',
  'WORKSPACE_SCOPE_MISMATCH',
  'AGENT_CAPABILITY_NOT_GRANTED',
  'PERMISSION_DENIED',
  'POLICY_DENIED',
  'ACTION_REPLAY_REJECTED',
  'EXPLICIT_APPROVAL_REQUIRED',
  'APPROVAL_ALREADY_CONSUMED',
  'PERSISTENT_ACTION_SECURITY_REPOSITORY_REQUIRED'
]);

export function executionErrorStatus(code: string): number {
  if (authorizationErrors.has(code) || code.startsWith('AGENT_CAPABILITY_NOT_GRANTED:')) return 403;
  if (code === 'MODEL_PROVIDER_NOT_CONFIGURED' || code === 'SECURITY_REPOSITORY_NOT_CONFIGURED' || code === 'AUTHENTICATION_NOT_CONFIGURED' || code === 'AUTH_JWKS_NOT_CONFIGURED' || code === 'AUTH_JWKS_UNAVAILABLE' || code === 'AUTH_JWKS_INVALID') return 503;
  if (code === 'ACTION_TIMEOUT') return 504;
  return 500;
}

async function requireIdentity(request: any, reply: any) {
  try { return await verifyBearerToken(request.headers.authorization); }
  catch (error) { const code = error instanceof Error ? error.message : 'AUTHENTICATION_FAILED'; const status = ['AUTHENTICATION_NOT_CONFIGURED','AUTH_JWKS_NOT_CONFIGURED','AUTH_JWKS_UNAVAILABLE','AUTH_JWKS_INVALID'].includes(code) ? 503 : 401; reply.code(status).send({ error: code }); return null; }
}

const agentSessionSchema = z.object({
  agentId: z.string().min(1).max(128),
  agentType: z.enum(['PlanningAgent','CodingAgent','ReviewAgent','TestAgent','RepairAgent','BrowserAgent','WebResearchAgent','AppAgent','APIAgent','DeviceAgent','PersonalAssistantAgent','MonitoringAgent','DeploymentAgent']),
  workspaceId: z.string().uuid().optional(),
  requiredCapabilities: z.array(z.string().min(1)).max(32).default([]),
  expiresAt: z.string().datetime().optional()
});

app.post('/api/v1/workspaces', async (request, reply) => {
  const identity = await requireIdentity(request, reply); if (!identity) return;
  if (!repository) return reply.code(503).send({ error:'DATABASE_NOT_CONFIGURED' });
  if (!identity.email) return reply.code(400).send({ error:'AUTH_EMAIL_REQUIRED' });
  try {
    const workspace = await repository.createAuthenticatedWorkspace({ authSubject:identity.userId, email:identity.email, workspaceName:'NexaForge Workspace' });
    if (!securityRepository) return reply.code(503).send({ error:'SECURITY_REPOSITORY_NOT_CONFIGURED' });
    const internalUserId = workspace.ownerId;
    const existing = await securityRepository.getPermission(internalUserId, 'ai.execute', workspace.id);
    if (!existing) await securityRepository.grantPermission({ userId:internalUserId, workspaceId:workspace.id, capability:'ai.execute', grantedBy:'system' });
    return reply.code(201).send({ workspace });
  } catch (error) { request.log.error(error); const code = error instanceof Error ? error.message : 'AUTHENTICATED_WORKSPACE_CREATE_FAILED'; return reply.code(code === 'AUTH_EMAIL_ALREADY_BOUND' ? 409 : 500).send({ error: code }); }
});

app.post('/api/v1/agent-sessions', async (request, reply) => {
  const identity = await requireIdentity(request, reply); if (!identity) return;
  if (!repository) return reply.code(503).send({ error:'DATABASE_NOT_CONFIGURED' });
  const parsed = agentSessionSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error:'INVALID_REQUEST', details:parsed.error.flatten() });
  const workspaceId = parsed.data.workspaceId ?? identity.workspaceId;
  if (identity.workspaceId && workspaceId && identity.workspaceId !== workspaceId) return reply.code(403).send({ error:'WORKSPACE_SCOPE_MISMATCH' });
  if (!workspaceId) return reply.code(400).send({ error:'WORKSPACE_REQUIRED' });
  const workspace = await repository.getWorkspace(workspaceId);
  if (!workspace) return reply.code(404).send({ error:'WORKSPACE_NOT_FOUND' });
  const internalUserId = await repository.getUserIdByAuthSubject(identity.userId);
  if (!internalUserId || workspace.ownerId !== internalUserId) return reply.code(403).send({ error:'WORKSPACE_ACCESS_DENIED' });
  try {
    const { AgentSessionManager, PermissionEngine } = await import('@nexaforge/ai-core');
    if (!securityRepository) return reply.code(503).send({ error:'SECURITY_REPOSITORY_NOT_CONFIGURED' });
    const manager = new AgentSessionManager(securityRepository, new PermissionEngine(securityRepository));
    const session = await manager.start({ userId:internalUserId, workspaceId, agentId:parsed.data.agentId, agentType:parsed.data.agentType, requiredCapabilities:parsed.data.requiredCapabilities as any, expiresAt:parsed.data.expiresAt });
    return reply.code(201).send({ session });
  } catch (error) { request.log.error(error); return reply.code(500).send({ error:'AGENT_SESSION_CREATE_FAILED' }); }
});

app.post('/api/v1/agent-sessions/:sessionId/execute', async (request, reply) => {
  const identity = await requireIdentity(request, reply); if (!identity) return;
  if (!repository) return reply.code(503).send({ error:'DATABASE_NOT_CONFIGURED' });
  const body = z.object({ prompt:z.string().min(1).max(20000), mode:z.string().default('auto'), requiredCapabilities:z.array(z.string().min(1)).max(32).default([]), maxIterations:z.number().int().min(1).max(12).default(12), budgetCents:z.number().int().min(0).optional() }).safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error:'INVALID_REQUEST', details:body.error.flatten() });
  const sessionId = (request.params as {sessionId:string}).sessionId;
  if (!securityRepository) return reply.code(503).send({ error:'SECURITY_REPOSITORY_NOT_CONFIGURED' });
  const record = await securityRepository.getAgentSession(sessionId);
  const internalUserId = await repository.getUserIdByAuthSubject(identity.userId);
  if (!internalUserId || !record || record.userId !== internalUserId) return reply.code(403).send({ error:'AGENT_SESSION_SCOPE_MISMATCH' });
  if (identity.workspaceId && record.workspaceId !== identity.workspaceId) return reply.code(403).send({ error:'WORKSPACE_SCOPE_MISMATCH' });
  const metadata = (record.metadata ?? {}) as Record<string,unknown>; const agentId = typeof metadata.agentId === 'string' ? metadata.agentId : '';
  if (!agentId) return reply.code(403).send({ error:'AGENT_SESSION_SCOPE_MISSING' });
  try {
    const core = await import('@nexaforge/ai-core');
    const pe = new core.PermissionEngine(securityRepository); const policy = new core.PolicyEngine(securityRepository); const audit = new core.AuditLogger(securityRepository);
    const action = new core.ActionEngine(pe, policy, audit, securityRepository); const registry = core.createToolRegistry([core.echoTool, core.timeTool, core.webSearchTool]);
    const runtime = core.createSupervisor(registry.list(), core.createConfiguredModelProvider(), action);
    const secure = new core.SecureAgentExecutor(securityRepository, new core.BoundedAgentExecutor(runtime, registry));
    const task:any = { id:randomUUID(), workspaceId:record.workspaceId ?? undefined, prompt:body.data.prompt, mode:body.data.mode as AgentMode, status:'running', maxIterations:body.data.maxIterations, budgetCents:body.data.budgetCents };
    const result = await secure.run({ task, userId:internalUserId, workspaceId:record.workspaceId ?? undefined, agentId, agentType:record.agentType as any, sessionId, requiredCapabilities:body.data.requiredCapabilities as any });
    return { task, result };
  } catch (error) {
    request.log.error(error);
    const code = error instanceof Error ? error.message : 'AGENT_EXECUTION_FAILED';
    return reply.code(executionErrorStatus(code)).send({ error: code });
  }
});

const DEFAULT_DEV_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

async function recordEvent(taskId: string, type: string, payload: unknown) {
  if (repository) return repository.addEvent(taskId, type, payload);
  const event: TaskEventRecord = { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
  const events = memoryEvents.get(taskId) ?? [];
  events.push(event);
  memoryEvents.set(taskId, events);
  return event;
}

const allowedOrigin = process.env.WEB_APP_URL ? process.env.WEB_APP_URL.replace(/\/$/, '') : true;
app.register(cors, { origin: allowedOrigin, credentials: true });

app.get('/health', async (request, reply) => {
  let dbOk = false;
  if (repository) dbOk = await repository.ping();
  if (isProduction && (!repository || !dbOk)) return reply.code(503).send({ ok:false, service:'nexaforge-api', persistence:repository?'postgres_unhealthy':'missing', worker:worker?'running':'disabled', applicationWorker:'external' });
  return { ok:dbOk || (!repository && !isProduction), service:'nexaforge-api', persistence:repository?(dbOk?'postgres':'postgres_unhealthy'):'memory', worker:worker?'running':'disabled', applicationWorker:'external' };
});

const handleDefaultWorkspace = async (request: any, reply: any) => {
  try {
    if (repository) return reply.code(200).send({ workspace: await repository.getOrCreateDefaultWorkspace() });
    return reply.code(200).send({ workspace:{ id:DEFAULT_DEV_WORKSPACE_ID,name:'NexaForge Local Workspace',ownerId:'local-owner',createdAt:new Date().toISOString() } });
  } catch (error) { request.log.error(error); return reply.code(500).send({ error:'WORKSPACE_GET_OR_CREATE_FAILED' }); }
};
app.get('/api/v1/workspaces/default', handleDefaultWorkspace);
app.post('/api/v1/workspaces/default', handleDefaultWorkspace);

app.post('/api/v1/dev/bootstrap', async (request, reply) => {
  if (isProduction) return reply.code(404).send({ error:'NOT_FOUND' });
  if (!repository) return reply.code(503).send({ error:'DATABASE_NOT_CONFIGURED' });
  const parsed=bootstrapSchema.safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST',details:parsed.error.flatten()});
  try{return reply.code(201).send({workspace:await repository.createWorkspace(parsed.data)});}catch(error){request.log.error(error);return reply.code(500).send({error:'BOOTSTRAP_FAILED'});}
});

app.post('/api/v1/tasks', async (request, reply) => {
  const parsed = taskSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error:'INVALID_REQUEST', details:parsed.error.flatten() });
  let workspaceId=parsed.data.workspaceId??'';
  if(!workspaceId){if(repository)workspaceId=(await repository.getOrCreateDefaultWorkspace()).id;else workspaceId=DEFAULT_DEV_WORKSPACE_ID;}
  else if(repository && !(await repository.workspaceExists(workspaceId)))return reply.code(404).send({error:'WORKSPACE_NOT_FOUND'});
  try{
    const task=repository?await repository.create({prompt:parsed.data.prompt,mode:parsed.data.mode,workspaceId,maxIterations:parsed.data.maxIterations,budgetCents:parsed.data.budgetCents}):(()=>{const id=randomUUID();const created:TaskRecord={id,prompt:parsed.data.prompt,mode:parsed.data.mode as AgentMode,status:'queued',workspaceId,maxIterations:parsed.data.maxIterations,budgetCents:parsed.data.budgetCents??null,result:undefined,errorCode:null,iterationCount:0,createdAt:new Date().toISOString(),completedAt:null};memoryTasks.set(id,created);return created;})();
    await recordEvent(task.id,'task.queued',{mode:task.mode,maxIterations:task.maxIterations,budgetCents:task.budgetCents??null}); return reply.code(202).send(task);
  }catch(error){request.log.error(error);return reply.code(500).send({error:'TASK_CREATE_FAILED'});}
});

app.get('/api/v1/tasks/:id', async (request, reply) => { const {id}=request.params as {id:string}; try{const task=repository?await repository.get(id):memoryTasks.get(id)??null;if(!task)return reply.code(404).send({error:'TASK_NOT_FOUND'});const events=repository?await repository.listEvents(id):memoryEvents.get(id)??[];return{task,events};}catch(error){request.log.error(error);return reply.code(500).send({error:'TASK_READ_FAILED'});} });
app.get('/api/v1/tasks/:id/events', async (request, reply) => { const {id}=request.params as {id:string}; const task=repository?await repository.get(id):memoryTasks.get(id)??null;if(!task)return reply.code(404).send({error:'TASK_NOT_FOUND'});return{events:repository?await repository.listEvents(id):memoryEvents.get(id)??[]}; });

app.get('/api/v1/tasks/:id/stream', async (request, reply) => {
  const {id}=request.params as {id:string}; const initialTask=repository?await repository.get(id):memoryTasks.get(id)??null; if(!initialTask)return reply.code(404).send({error:'TASK_NOT_FOUND'});
  reply.hijack(); const response=reply.raw; const reqOrigin=request.headers.origin||'*'; response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no','Access-Control-Allow-Origin':reqOrigin,'Access-Control-Allow-Credentials':'true'});
  let closed=false; const seenEventIds=new Set<string>(); let timer:NodeJS.Timeout|undefined;
  const cleanup=()=>{if(closed)return;closed=true;if(timer)clearTimeout(timer);request.raw.off('close',cleanup);if(!response.destroyed)response.end();}; request.raw.on('close',cleanup);
  const send=(event:string,data:unknown,evtId?:string)=>{if(closed||response.destroyed)return;if(evtId)response.write(`id: ${evtId}\n`);response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
  send('task.snapshot',initialTask,initialTask.id);
  const tick=async()=>{if(closed)return;try{const task=repository?await repository.get(id):memoryTasks.get(id)??null;if(!task){send('error',{error:'TASK_NOT_FOUND'});cleanup();return;}const events=repository?await repository.listEvents(id):memoryEvents.get(id)??[];for(const event of events){if(seenEventIds.has(event.id))continue;seenEventIds.add(event.id);send(event.type,event.payload,event.id);}send('task.snapshot',task,task.id);if(terminalStatuses.has(task.status)){send('done',{status:task.status,taskId:task.id});cleanup();return;}}catch(error){send('error',{error:error instanceof Error?error.message:'STREAM_FAILED'});}if(!closed)timer=setTimeout(()=>{void tick();},500);};
  void tick();
});

app.post('/api/v1/tasks/:id/cancel', async (request, reply) => { const {id}=request.params as {id:string}; try{const task=repository?await repository.updateStatus(id,'cancelled'):(()=>{const existing=memoryTasks.get(id);if(!existing)return null;const cancelled={...existing,status:'cancelled',completedAt:new Date().toISOString()};memoryTasks.set(id,cancelled);return cancelled;})();if(!task)return reply.code(404).send({error:'TASK_NOT_FOUND'});worker?.cancel(id);await recordEvent(id,'task.cancelled',{});return task;}catch(error){request.log.error(error);return reply.code(500).send({error:'TASK_CANCEL_FAILED'});} });

// Application Builder API
app.post('/api/v1/applications', async (request, reply) => {
  if (!applicationRepository) return reply.code(503).send({ error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED' });
  const parsed=applicationProjectSchema.safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST',details:parsed.error.flatten()});
  try{const workspaceId=parsed.data.workspaceId??(repository?await repository.getOrCreateDefaultWorkspace():null)?.id;if(!workspaceId)return reply.code(503).send({error:'WORKSPACE_NOT_AVAILABLE'});if(repository&&!(await repository.workspaceExists(workspaceId)))return reply.code(404).send({error:'WORKSPACE_NOT_FOUND'});const project=await applicationRepository.createProject({workspaceId,name:parsed.data.name,description:parsed.data.description});return reply.code(201).send({project});}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_PROJECT_CREATE_FAILED'});}
});

app.get('/api/v1/applications/:id', async (request, reply) => {if(!applicationRepository)return reply.code(503).send({error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED'});const {id}=request.params as {id:string};try{const project=await applicationRepository.getProject(id);if(!project)return reply.code(404).send({error:'APPLICATION_PROJECT_NOT_FOUND'});return{project};}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_PROJECT_READ_FAILED'});}});

app.post('/api/v1/applications/:id/builds', async (request, reply) => {if(!applicationRepository)return reply.code(503).send({error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED'});const {id}=request.params as {id:string};const parsed=applicationBuildSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST',details:parsed.error.flatten()});try{const project=await applicationRepository.getProject(id);if(!project)return reply.code(404).send({error:'APPLICATION_PROJECT_NOT_FOUND'});const build=await applicationRepository.createBuild({projectId:id,request:parsed.data});await applicationRepository.addBuildEvent({buildId:build.id,eventType:'build.queued',phase:'queued',payload:{projectId:id}});return reply.code(202).send({build});}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_BUILD_CREATE_FAILED'});}});

app.get('/api/v1/applications/:id/builds', async (request, reply) => {if(!applicationRepository)return reply.code(503).send({error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED'});const {id}=request.params as {id:string};try{const project=await applicationRepository.getProject(id);if(!project)return reply.code(404).send({error:'APPLICATION_PROJECT_NOT_FOUND'});const builds=await applicationRepository.listBuilds(id);return{project,builds};}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_BUILDS_READ_FAILED'});}});

app.get('/api/v1/application-builds/:buildId', async (request, reply) => {if(!applicationRepository)return reply.code(503).send({error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED'});const {buildId}=request.params as {buildId:string};try{const build=await applicationRepository.getBuild(buildId);if(!build)return reply.code(404).send({error:'APPLICATION_BUILD_NOT_FOUND'});const steps=await applicationRepository.getBuildSteps(buildId);const events=await applicationRepository.listBuildEvents(buildId);return{build,steps,events};}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_BUILD_READ_FAILED'});}});

app.post('/api/v1/application-builds/:buildId/cancel', async (request, reply) => {if(!applicationRepository)return reply.code(503).send({error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED'});const {buildId}=request.params as {buildId:string};try{const build=await applicationRepository.requestBuildCancellation(buildId);if(!build)return reply.code(404).send({error:'APPLICATION_BUILD_NOT_FOUND_OR_TERMINAL'});await applicationRepository.addBuildEvent({buildId,eventType:'build.cancel_requested',phase:build.phase,payload:{source:'api'}});return{build};}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_BUILD_CANCEL_FAILED'});}});

app.post('/api/v1/application-builds/:buildId/approvals/:stepKey', async (request, reply) => {if(!applicationRepository)return reply.code(503).send({error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED'});const {buildId,stepKey}=request.params as {buildId:string;stepKey:string};const body=request.body as {reason?:unknown};const reason=typeof body?.reason==='string'?body.reason:'Approval required';try{return reply.code(201).send({approval:await applicationRepository.requestApproval({buildId,stepKey,reason})});}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_APPROVAL_REQUEST_FAILED'});}});

app.post('/api/v1/application-builds/:buildId/approvals/:stepKey/:decision', async (request, reply) => {if(!applicationRepository)return reply.code(503).send({error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED'});const {buildId,stepKey,decision}=request.params as {buildId:string;stepKey:string;decision:string};if(decision!=='approved'&&decision!=='rejected')return reply.code(400).send({error:'INVALID_APPROVAL_DECISION'});try{const approval=await applicationRepository.decideApproval(buildId,stepKey,decision);if(!approval)return reply.code(404).send({error:'APPLICATION_APPROVAL_NOT_FOUND'});return{approval};}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_APPROVAL_DECISION_FAILED'});}});

app.post('/api/v1/applications/:id/deployments', async (request, reply) => {if(!applicationRepository)return reply.code(503).send({error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED'});const {id}=request.params as {id:string};const parsed=applicationDeploymentSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST',details:parsed.error.flatten()});try{const project=await applicationRepository.getProject(id);if(!project)return reply.code(404).send({error:'APPLICATION_PROJECT_NOT_FOUND'});const deployment=await applicationRepository.createDeployment({projectId:id,provider:parsed.data.provider,environment:parsed.data.environment,metadata:parsed.data.metadata});return reply.code(202).send({deployment});}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_DEPLOYMENT_CREATE_FAILED'});}});

app.get('/api/v1/applications/:id/deployments', async (request, reply) => {if(!applicationRepository)return reply.code(503).send({error:'APPLICATION_BUILDER_DATABASE_NOT_CONFIGURED'});const {id}=request.params as {id:string};try{const project=await applicationRepository.getProject(id);if(!project)return reply.code(404).send({error:'APPLICATION_PROJECT_NOT_FOUND'});return{project,deployments:await applicationRepository.listDeployments(id)};}catch(error){request.log.error(error);return reply.code(500).send({error:'APPLICATION_DEPLOYMENTS_READ_FAILED'});}});

const shutdown = async () => { worker?.stop(); deploymentWorker?.stop(); await app.close(); };
process.once('SIGINT',()=>{void shutdown().finally(()=>process.exit(0));});
process.once('SIGTERM',()=>{void shutdown().finally(()=>process.exit(0));});

if(process.env.NODE_ENV!=='test'){
  app.listen({port:Number(process.env.PORT??4000),host:process.env.HOST??'0.0.0.0'}).then(async()=>{if(repository){const pingOk=await repository.ping();if(pingOk)app.log.info('Connected to PostgreSQL/Neon database successfully.');else{app.log.error('Failed to ping PostgreSQL/Neon database on startup.');if(isProduction)process.exit(1);}}else app.log.warn('Running with in-memory store (DEVELOPMENT ONLY).');worker?.start();}).catch(error=>{app.log.error(error);process.exit(1);});
}
