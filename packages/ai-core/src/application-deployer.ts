import type { ApplicationDeploymentSource } from './application-artifact.js';

const RENDER_API = 'https://api.render.com/v1';
const TERMINAL_RENDER_FAILURES = new Set(['build_failed','update_failed','canceled','pre_deploy_failed','deactivated']);

type RenderHttp = (url:string, init?:RequestInit)=>Promise<Response>;

function sleep(ms:number, signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{const t=setTimeout(resolve,ms);if(signal?.aborted){clearTimeout(t);reject(new Error('RENDER_DEPLOY_CANCELLED'));return;}signal?.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('RENDER_DEPLOY_CANCELLED'));},{once:true});});}

function renderName(name:string){const value=name.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,55);return value||'nexaforge-app';}

export type DeploymentStatus = 'queued' | 'deploying' | 'ready' | 'failed' | 'cancelled';

export interface ApplicationDeploymentRequest {
  projectId: string;
  buildId: string;
  deploymentId?: string;
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

  const findExistingService = async (name:string) => {
    const result = await request(`/services?ownerId=${encodeURIComponent(ownerId!)}&name=${encodeURIComponent(name)}&limit=1`);
    const first = Array.isArray(result) ? result[0] : undefined;
    return first?.service ?? null;
  };

  return {
    async deploy(requestInput, signal) {
      if (signal?.aborted) return {status:'cancelled',provider:'render'};
      if (!ownerId) throw new Error('RENDER_OWNER_ID_NOT_CONFIGURED');
      if (requestInput.source.type !== 'image') throw new Error('RENDER_REQUIRES_IMAGE_SOURCE');

      const imagePath = requestInput.source.digest
        ? `${requestInput.source.reference.split('@')[0]}@${requestInput.source.digest}`
        : requestInput.source.reference;
      const serviceName = renderName(`${requestInput.name}-${requestInput.projectId.slice(0,8)}-${(requestInput.deploymentId ?? requestInput.buildId).slice(0,8)}`);

      let service = await findExistingService(serviceName);
      let deployId = '';

      if (!service) {
        let created: any;
        try {
          created = await request('/services', {
          method:'POST',
          body: JSON.stringify({
            type:'web_service',
            name:serviceName,
            ownerId,
            autoDeploy:'no',
            image:{imagePath},
            serviceDetails:{buildPlan:plan,region,healthCheckPath:healthPath}
          })
          });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('RENDER_API_409:')) throw error;
          service = await findExistingService(serviceName);
          if (!service) throw error;
          const triggered = await request(`/services/${encodeURIComponent(String(service.id))}/deploys`, {
            method:'POST',
            body: JSON.stringify({ imageUrl: imagePath })
          });
          deployId = String(triggered.id ?? '');
        }
        if (created) {
          service = created.service ?? created;
          deployId = String(created.deployId ?? '');
        }
      } else {
        const existingImage = typeof service.imagePath === 'string' ? service.imagePath.split('@')[0] : '';
        const requestedImage = imagePath.split('@')[0];
        if (existingImage && existingImage !== requestedImage) {
          throw new Error('RENDER_IDEMPOTENCY_IMAGE_MISMATCH');
        }
        const triggered = await request(`/services/${encodeURIComponent(String(service.id))}/deploys`, {
          method:'POST',
          body: JSON.stringify({ imageUrl: imagePath })
        });
        deployId = String(triggered.id ?? '');
      }

      const serviceId = String(service.id ?? '');
      if (!serviceId) throw new Error('RENDER_SERVICE_ID_MISSING');
      const deadline = Date.now() + timeoutMs;
      let deploy:any = { status: 'created' };
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          if (deployId) { try { await request(`/services/${serviceId}/deploys/${deployId}/cancel`,{method:'POST'}); } catch {} }
          return {status:'cancelled',provider:'render',externalId:deployId ? `${serviceId}:${deployId}` : serviceId};
        }
        if (deployId) deploy = await request(`/services/${serviceId}/deploys/${deployId}`);
        const status = String(deploy.status ?? '');
        if (status === 'live') {
          const url = typeof service.serviceDetails?.url === 'string' ? service.serviceDetails.url : typeof service.url === 'string' ? service.url : undefined;
          if (url) {
            const health = await http(new URL(healthPath, url).toString(), {signal, headers:{Accept:'application/json'}});
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
