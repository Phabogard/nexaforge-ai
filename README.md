# NexaForge AI

NexaForge AI is a modular multimodal agent platform for research, verification, vision, browser/computer-use workflows, document analysis, trading analytics, simulation, monitoring, automation, memory and connectors.

## Monorepo

- `apps/web` — Next.js frontend
- `apps/api` — API service
- `packages/ai-core` — planner, supervisor and agent runtime
- `packages/tools` — tool contracts
- `packages/connectors` — external integrations
- `packages/shared` — shared contracts and validation
- `packages/db` — database layer

## Safety

The platform never fabricates sources, actions, tool calls, connections or results. External content is untrusted data. Sensitive/destructive actions require authorization. Trading and game-related functionality is analytical/simulation-only and never represents random outcomes as predictable certainties.

## Status

Foundation phase: contracts, configuration, API boundaries and database schema are being implemented. Provider credentials and deployment infrastructure remain environment-specific.
