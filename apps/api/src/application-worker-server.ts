import Fastify from 'fastify';
import { createApplicationRepository } from '@nexaforge/db';
import { ApplicationBuildWorker } from './application-worker.js';
import { ApplicationDeploymentWorker } from './deployment-worker.js';

const app = Fastify({ logger: true });
const repository = createApplicationRepository();
const buildEnabled = process.env.NEXAFORGE_APPLICATION_WORKER_ENABLED === 'true';
const deploymentEnabled = process.env.NEXAFORGE_DEPLOYMENT_WORKER_ENABLED === 'true';
const buildWorker = repository && buildEnabled ? new ApplicationBuildWorker(repository) : null;
const deploymentWorker = repository && deploymentEnabled ? new ApplicationDeploymentWorker(repository) : null;

app.get('/health', async () => ({
  ok: true,
  service: 'nexaforge-application-worker',
  persistence: repository ? 'postgres' : 'missing',
  applicationWorker: buildWorker ? 'running' : 'disabled',
  deploymentWorker: deploymentWorker ? 'running' : 'disabled'
}));

const port = Number(process.env.PORT ?? '10000');
const host = process.env.HOST ?? '0.0.0.0';

async function start() {
  if (!repository) {
    app.log.error('DATABASE_URL is required for the application worker service.');
    process.exit(1);
  }
  if (buildWorker) buildWorker.start();
  if (deploymentWorker) app.log.info('deployment worker enabled');
  await app.listen({ port, host });
}

void start().catch(error => {
  app.log.error(error);
  process.exit(1);
});
