# Dedicated NexaForge Application Runner Host

This directory defines the deployment boundary for the isolated Application Runner.

## Host requirements

- Dedicated Linux VM or equivalent host.
- Docker Engine (dockerd) installed and running.
- No nexaforge-api or nexaforge-web workload on this host.
- Outbound network for the trusted Runner during dependency installation.
- Inbound access restricted to operators and monitoring.
- Persistent disk sized for Docker images, build workspaces and logs.

## Preflight

Run on the host:

```bash
docker version
docker run --rm hello-world
```

Both commands must succeed before enabling the worker.

## Runner container

Build from the repository root:

```bash
docker build -f apps/application-builder/Dockerfile -t nexaforge-application-builder:latest .
```

Run the trusted Runner:

```bash
docker run -d \\
  --name nexaforge-application-builder \\
  --restart unless-stopped \\
  --env-file /etc/nexaforge/application-runner.env \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -p 127.0.0.1:10000:10000 \\
  nexaforge-application-builder:latest
```

The Docker socket is highly privileged. Only the trusted Runner may access it. Do not publish the Runner port publicly.

## Environment

Required: DATABASE_URL, NEXAFORGE_APPLICATION_WORKER_ENABLED=true, NEXAFORGE_APPLICATION_SANDBOX=container.

Recommended: NEXAFORGE_APPLICATION_WORKER_CONCURRENCY=2, NEXAFORGE_APPLICATION_SANDBOX_MEMORY_MB=1024, NEXAFORGE_APPLICATION_SANDBOX_CPUS=1.

Never commit the real DATABASE_URL or provider/API credentials.

## Rollout order

1. Provision the dedicated Docker host.
2. Run the Docker preflight.
3. Start the Runner with the worker disabled.
4. Verify /health reports applicationWorker: disabled.
5. Verify Neon/Postgres connectivity.
6. Confirm Docker socket access from the trusted Runner.
7. Enable the worker.
8. Submit one controlled test build.
9. Verify resource limits and network isolation.
10. Keep API and Web on separate infrastructure.

The API remains the durable job producer; the Runner polls the Postgres queue.
