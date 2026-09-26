import type { ApplicationDeploymentSource } from './application-artifact';

const RENDER_API = 'https://api.render.com/v1';
const TERMINAL_RENDER_FAILURES = new Set(['build_failed','update_failed','canceled','pre_deploy_failed','deactivated']);

type RenderHttp = (url:string, init?:RequestInit)=>Promise<Response>;

function sleep(ms:number, signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{const t=setTimeout(resolve,ms);if(signal?.aborted){clearTimeout(t);reject(new Error('RENDER_DEPLOY_CANCELLED'));return;}signal?.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('RENDER_DEPLOY_CANCELLED'));},{once:true});});}

function renderName(name:string){const value=name.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,55);return value||'nexaforge-app';}


export type DeploymentStatus = 'queued' | 'deploying' | 'ready' | 'failed' | 'cancelled';

export interface ApplicationDeploymentRequest {
  projectId: string;
  buildId: string;
  source: ApplicationDeploymentSource;
  environment: string;
  name: string;
  port?: number;
}

export interface ApplicationDeploymentResult {
  status: DeploymentStatus;
  provider: string;
  externalId?: string;
  url?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ApplicationDeployer {
  deploy(request: ApplicationDeploymentRequest, signal?: AbortSignal): Promise<ApplicationDeploymentResult>;
  cancel?(externalId: string, signal?: AbortSignal): Promise<void>;
}

export function createLocalDeployer(): ApplicationDeployer {
  return {
    async deploy(request, signal) {
      if (signal?.aborted) return { status: 'cancelled', provider: 'local' };
      return {
        status: 'failed',
        provider: 'local',
        externalId: request.buildId,
        message: 'LOCAL_DEPLOYMENT_UNSUPPORTED',
        metadata: { sourceType: request.source.type, environment: request.environment }
      };
    }
  };
}

export interface RenderImageDeployerOptions {
  apiKey?: string;
  ownerId?: string;
  region?: string;
  plan?: string;
  healthPath?: string;
  timeoutMs?: number;
  http?: RenderHttp;
}

export function createRenderImageDeployer(options: RenderImageDeployerOptions = {}): ApplicationDeployer {
  const apiKey = options.apiKey ?? process.env.RENDER_API_KEY;
  const ownerId = options.ownerId ?? process.env.RENDER_OWNER_ID;
  const region = options.region ?? process.env.RENDER_REGION ?? 'oregon';
  const plan = options.plan ?? process.env.RENDER_PLAN ?? 'free';
  const healthPath = options.healthPath ?? process.env.RENDER_HEALTH_PATH ?? '/';
  const timeoutMs = options.timeoutMs ?? Number(process.env.RENDER_DEPLOY_TIMEOUT_MS ?? 900000);
  const http = options.http ?? fetch;

  const request = async (path:string, init:RequestInit = {}) => {
    if (!apiKey) throw new Error('RENDER_API_KEY_NOT_CONFIGURED');
    const response = await http(RENDER_API + path, {
      ...init,
      headers: { Accept:'application/json', 'Content-Type':'application/json', Authorization:`Bearer ${apiKey}`, ...(init.headers ?? {}) }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`RENDER_API_${response.status}:${body.slice(0,1000)}`);
    }
    return response.json() as Promise<any>;
  };

  return {
    async deploy(requestInput, signal) {
      if (signal?.aborted) return {status:'cancelled',provider:'render'};
      if (!ownerId) throw new Error('RENDER_OWNER_ID_NOT_CONFIGURED');
      if (requestInput.source.type !== 'image') throw new Error('RENDER_REQUIRES_IMAGE_SOURCE');

      const imagePath = requestInput.source.digest
        ? `${requestInput.source.reference.split('@')[0]}@${requestInput.source.digest}`
        : requestInput.source.reference;

      const created = await request('/services', {
        method:'POST',
        body: JSON.stringify({
          type:'web_service',
          name:renderName(requestInput.name + '-' + requestInput.projectId.slice(0,8)),
          ownerId,
          autoDeploy:'no',
          image:{imagePath},
          serviceDetails:{buildPlan:plan,region,healthCheckPath:healthPath}
        })
      });

      const service = created.service ?? created;
      const serviceId = String(service.id ?? '');
      if (!serviceId) throw new Error('RENDER_SERVICE_ID_MISSING');
      const deployId = String(created.deployId ?? '');
      const deadline = Date.now() + timeoutMs;
      let deploy:any = created;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          if (deployId) { try { await request(`/services/${serviceId}/deploys/${deployId}/cancel`,{method:'POST'}); } catch {} }
          return {status:'cancelled',provider:'render',externalId:deployId || serviceId};
        }
        if (deployId) deploy = await request(`/services/${serviceId}/deploys/${deployId}`);
        const status = String(deploy.status ?? '');
        if (status === 'live') {
          const url = typeof service.serviceDetails?.url === 'string' ? service.serviceDetails.url : typeof service.url === 'string' ? service.url : undefined;
          if (url) {
            const health = await fetch(new URL(healthPath, url), {signal});
            if (!health.ok) throw new Error(`RENDER_HEALTH_CHECK_FAILED:${health.status}`);
          }
          return {status:'ready',provider:'render',externalId:`${serviceId}:${deployId}`,url,metadata:{serviceId,deployId,image:imagePath,renderStatus:status}};
        }
        if (TERMINAL_RENDER_FAILURES.has(status)) return {status:'failed',provider:'render',externalId:serviceId,message:`RENDER_DEPLOY_${status.toUpperCase()}`,metadata:{serviceId,deployId,renderStatus:status}};
        await sleep(5000, signal);
      }
      return {status:'failed',provider:'render',externalId:serviceId,message:'RENDER_DEPLOY_TIMEOUT',metadata:{serviceId,deployId}};
    },
    async cancel(externalId, signal) {
      if (!apiKey || signal?.aborted) return;
      const [serviceId, deployId] = externalId.split(':');
      if (serviceId && deployId) await request(`/services/${serviceId}/deploys/${deployId}/cancel`,{method:'POST'});
    }
  };
}
