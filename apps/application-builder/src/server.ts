import Fastify from 'fastify';
import { createApplicationRepository } from '@nexaforge/db';
import { ApplicationBuildWorker } from './application-worker.js';
import { assertApplicationWorkerIsolation, assertDockerDaemonAvailable } from './application-worker-guard.js';

const app = Fastify({ logger: true });
const repository = createApplicationRepository();
const buildEnabled = process.env.NEXAFORGE_APPLICATION_WORKER_ENABLED === 'true';

if (!repository) throw new Error('DATABASE_URL is required for application builder');
if (buildEnabled) assertApplicationWorkerIsolation();

const buildWorker = buildEnabled ? new ApplicationBuildWorker(repository) : null;

app.get('/health', async () => ({
  ok: true,
  service: 'nexaforge-application-builder',
  persistence: 'postgres',
  applicationWorker: buildWorker ? 'running' : 'disabled'
}));

const port = Number(process.env.PORT ?? '10000');
const host = process.env.HOST ?? '0.0.0.0';

async function start() {
  if (buildEnabled) {\n    assertApplicationWorkerIsolation();\n    await assertDockerDaemonAvailable();\n  }
  buildWorker?.start();
  await app.listen({ port, host });
}

const shutdown = async () => {
  buildWorker?.stop();
  await app.close();
};
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

void start().catch(error => {
  app.log.error(error);
  process.exit(1);
});
