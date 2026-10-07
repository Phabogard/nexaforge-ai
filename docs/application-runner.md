# NexaForge Application Runner

The Application Runner is the dedicated execution host for generated applications.

## Security boundary

Generated application code must never execute inside `nexaforge-api`.

The runner process is trusted infrastructure, while generated code executes inside the Docker containers created by `packages/ai-core/src/container-workspace-sandbox.ts`.

The runner host must therefore be dedicated to NexaForge application builds and must provide:

- a real Docker daemon;
- Docker socket access only to the trusted runner process/container;
- no production API workload on the same host;
- outbound network available to the runner only for dependency installation;
- generated build containers using `--network=none` for test, build, runtime and browser-validation phases;
- CPU, memory, PID and execution-time limits enforced by the sandbox;
- `NEXAFORGE_APPLICATION_SANDBOX=container`;
- `NEXAFORGE_APPLICATION_WORKER_ENABLED=true`;
- a valid `DATABASE_URL`.

Do **not** enable the worker on Render until the deployment target is confirmed to provide a real Docker daemon with an appropriate isolation boundary.

## Container image

Build from the repository root:

```bash
docker build -f apps/application-builder/Dockerfile -t nexaforge-application-builder .
```

Run the trusted runner against a dedicated Docker host:

```bash
docker run --rm \
  --name nexaforge-application-builder \
  -e DATABASE_URL=... \
  -e NEXAFORGE_APPLICATION_WORKER_ENABLED=true \
  -e NEXAFORGE_APPLICATION_SANDBOX=container \
  -e NEXAFORGE_APPLICATION_WORKER_CONCURRENCY=2 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -p 10000:10000 \
  nexaforge-application-builder
```

The Docker socket is intentionally required only by the trusted runner. Never expose this runner endpoint publicly without authentication/network controls.

## Operational requirements

1. Provision a dedicated VM or equivalent container host with Docker.
2. Restrict inbound access; the runner should normally poll Postgres rather than accept build commands from the public internet.
3. Inject the same Neon `DATABASE_URL` used by the API.
4. Keep the worker disabled until the host passes a Docker/isolation smoke test.
5. Monitor CPU, memory, disk and Docker container counts.
6. Rotate credentials and avoid placing provider API keys in generated application environments.

## First smoke test

Before enabling real builds:

```bash
docker version
docker run --rm hello-world
```

Then start the runner with the worker disabled and verify:

```text
GET /health
applicationWorker: disabled
```

Only after the host isolation checks pass should `NEXAFORGE_APPLICATION_WORKER_ENABLED=true` be used.
