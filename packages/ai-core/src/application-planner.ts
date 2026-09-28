import type { ApplicationBuildRequest, ProjectBlueprint } from './application-builder.js';
import type { ModelProvider } from './index.js';
import { normalizeDependencySpec, validateProjectCommand, validateProjectPath } from './application-policy.js';

export interface ApplicationPlanner {
  createBlueprint(request: ApplicationBuildRequest): Promise<ProjectBlueprint>;
}

export function createApplicationPlanner(model: ModelProvider): ApplicationPlanner {
  return {
    async createBlueprint(request) {
      const raw = await model.generate({
        system: `You are NexaForge Application Planner. Convert a natural-language application request into a safe, concrete project blueprint. Return ONLY JSON matching:
{
  "name": "string",
  "description": "string",
  "runtime": "string",
  "packageManager": "npm|pnpm|yarn|bun",
  "directories": ["relative/path"],
  "files": ["relative/path"],
  "commands": {"install":"safe command","test":"safe command","build":"safe command","start":"safe command"},
  "dependencies": ["package@exact.semver"],
  "devDependencies": ["package@exact.semver"],
  "requiresDatabase": true
}
Dependency entries MUST use exact semantic versions such as react@19.1.1, never latest, ranges, git URLs, tags or aliases.
Commands must be a single executable plus arguments, with no shell operators, pipelines, redirects, substitutions, absolute paths or destructive flags.
Never include secrets or host paths. Prefer conventional project structures.`,
        messages: [{
          role: 'user',
          content: `Project request: ${request.prompt}\nWorkspace: isolated project root\nMax iterations: ${request.maxIterations}`
        }]
      });

      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new Error('INVALID_APPLICATION_BLUEPRINT'); }
      if (!parsed || typeof parsed !== 'object') throw new Error('INVALID_APPLICATION_BLUEPRINT');
      const blueprint = parsed as ProjectBlueprint;
      if (!blueprint.name || !blueprint.runtime || !Array.isArray(blueprint.files) ||
          !Array.isArray(blueprint.directories) || !Array.isArray(blueprint.dependencies) ||
          !Array.isArray(blueprint.devDependencies) || !blueprint.commands) {
        throw new Error('INVALID_APPLICATION_BLUEPRINT');
      }
      for (const path of [...blueprint.files, ...blueprint.directories]) validateProjectPath(path);
      for (const dependency of [...blueprint.dependencies, ...blueprint.devDependencies]) normalizeDependencySpec(dependency);
      for (const command of Object.values(blueprint.commands)) validateProjectCommand(command);
      if (!['npm','pnpm','yarn','bun'].includes(blueprint.packageManager)) throw new Error('INVALID_PACKAGE_MANAGER');
      return blueprint;
    }
  };
}
