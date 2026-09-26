import type { ApplicationBuildRequest, ProjectBlueprint } from './application-builder';
import type { ModelProvider } from './index';

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
  "directories": ["string"],
  "files": ["string"],
  "commands": {"install":"string","test":"string","build":"string","start":"string"},
  "dependencies": ["string"],
  "devDependencies": ["string"],
  "requiresDatabase": true
}
Never include secrets, host paths, arbitrary shell pipelines, or destructive commands. Prefer conventional project structures.`,
        messages: [{
          role: 'user',
          content: `Project request: ${request.prompt}\nWorkspace: ${request.workspaceRoot}\nMax iterations: ${request.maxIterations}`
        }]
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('INVALID_APPLICATION_BLUEPRINT');
      }
      if (!parsed || typeof parsed !== 'object') throw new Error('INVALID_APPLICATION_BLUEPRINT');
      const blueprint = parsed as ProjectBlueprint;
      if (!blueprint.name || !blueprint.runtime || !Array.isArray(blueprint.files)) {
        throw new Error('INVALID_APPLICATION_BLUEPRINT');
      }
      return blueprint;
    }
  };
}
