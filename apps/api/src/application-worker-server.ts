import Fastify from 'fastify';
import { createApplicationRepository } from '@nexaforge/db';
import { ApplicationBuildWorker } from './application-worker.js';
import { ApplicationDeploymentWorker } from './deployment-worker.js';
import { assertApplicationWorkerIsolation } from './application-worker-guard.js';

const app = Fastify({ logger: true });
const repository = createApplicationRepository();
const buildEnabled = process.env.NEXAFORGE_APPLICATION_WORKER_ENABLED === 'true';
const deploymentEnabled = process.env.NEXAFORGE_DEPLOYMENT_WORKER_ENABLED === 'true';

if (!repository) throw new Error('DATABASE_URL is required for application worker');
if (buildEnabled) assertApplicationWorkerIsolation();

const buildWorker = buildEnabled ? new ApplicationBuildWorker(repository) : null;
const deploymentWorker = deploymentEnabled ? new ApplicationDeploymentWorker(repository) : null;

app.get('/health', async () => ({
  ok: true,
  service: 'nexaforge-application-worker',
  persistence: 'postgres',
  applicationWorker: buildWorker ? 'running' : 'disabled',
  deploymentWorker: deploymentWorker ? 'running' : 'disabled'
}));

const port = Number(process.env.PORT ?? '10000');
const host = process.env.HOST ?? '0.0.0.0';

async function start() {
  if (buildEnabled) assertApplicationWorkerIsolation();
  buildWorker?.start();
  deploymentWorker?.start();
  await app.listen({ port, host });
}

void start().catch(error => {
  app.log.error(error);
  process.exit(1);
});
