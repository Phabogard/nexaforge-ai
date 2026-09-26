import type { ModelProvider } from './index';
import type {
  ApplicationBuildRequest, ApplicationBuildResult, ApplicationBuilder,
  ApplicationBuildPhase, ProjectBlueprint
} from './application-builder';
import { createApplicationPlanner } from './application-planner';
import { createBuildVerifier, type BuildVerifier } from './build-verifier';
import { createWorkspaceSandbox } from './workspace-sandbox';
import type { WorkspacePathPolicy } from './workspace-tools';
import { normalizeDependencySpec, validateProjectPath } from './application-policy';

interface GeneratedFile { path: string; content: string; }
interface ApplicationBuilderOptions {
  model: ModelProvider;
  sandboxPolicy?: Omit<WorkspacePathPolicy, 'root'>;
  verifierFactory?: (root: string, blueprint: ProjectBlueprint) => BuildVerifier;
}

function parseFiles(raw: string): GeneratedFile[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('INVALID_GENERATED_FILES_JSON'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100) throw new Error('INVALID_GENERATED_FILES_SHAPE');
  return parsed.map((item): GeneratedFile => {
    if (!item || typeof item !== 'object') throw new Error('INVALID_GENERATED_FILE');
    const value = item as Record<string, unknown>;
    if (typeof value.path !== 'string' || !value.path || typeof value.content !== 'string') throw new Error('INVALID_GENERATED_FILE');
    validateProjectPath(value.path);
    if (value.content.length > 1_000_000) throw new Error('GENERATED_FILE_TOO_LARGE');
    return { path: value.path, content: value.content };
  });
}

function packageJson(blueprint: ProjectBlueprint): string {
  const dependencies = Object.fromEntries(blueprint.dependencies.map(spec => {
    const parsed = normalizeDependencySpec(spec);
    return [parsed.name, parsed.version];
  }));
  const devDependencies = Object.fromEntries(blueprint.devDependencies.map(spec => {
    const parsed = normalizeDependencySpec(spec);
    return [parsed.name, parsed.version];
  }));
  return JSON.stringify({
    name: blueprint.name,
    version: '0.1.0',
    private: true,
    scripts: {
      test: blueprint.commands.test ?? 'echo "no tests configured"',
      build: blueprint.commands.build ?? 'echo "no build configured"',
      start: blueprint.commands.start ?? 'node .'
    },
    dependencies, devDependencies
  }, null, 2) + '\n';
}

export function createApplicationBuilder(options: ApplicationBuilderOptions): ApplicationBuilder {
  const planner = createApplicationPlanner(options.model);
  return {
    async build(request, signal): Promise<ApplicationBuildResult> {
      let phase: ApplicationBuildPhase = 'planning';
      let blueprint: ProjectBlueprint | undefined;
      const completedSteps: string[] = [];
      let repairAttempts = 0;
      const checkAbort = () => { if (signal?.aborted) throw new Error('APPLICATION_BUILD_CANCELLED'); };

      try {
        checkAbort();
        blueprint = await planner.createBlueprint(request);
        completedSteps.push('plan');
        phase = 'scaffolding';

        const policy = {
          root: request.workspaceRoot,
          allowRead: true,
          allowWrite: true,
          allowDelete: true,
          allowExec: true,
          ...(options.sandboxPolicy ?? {})
        };
        const workspace = createWorkspaceSandbox(policy);
        const verifier = options.verifierFactory
          ? options.verifierFactory(request.workspaceRoot, blueprint)
          : createBuildVerifier({ workspace, packageManager: blueprint.packageManager, cwd: '.' });

        const generationPrompt = [
          'You are the NexaForge coding agent.',
          'Generate a complete runnable application from the validated blueprint below.',
          'Return ONLY JSON: an array of { "path": "relative/path", "content": "full file contents" }.',
          'Never use absolute paths, secrets, host-specific paths, destructive scripts, or shell pipelines.',
          'Include every file required for install, test, build and start.',
          JSON.stringify(blueprint)
        ].join('\n');

        const generated = parseFiles(await options.model.generate({
          system: generationPrompt,
          messages: [{ role: 'user', content: request.prompt }]
        }));
        for (const file of generated) {
          checkAbort();
          await workspace.writeFile(file.path, file.content, signal);
        }
        if (!generated.some(file => file.path === 'package.json')) {
          await workspace.writeFile('package.json', packageJson(blueprint), signal);
        }
        completedSteps.push('scaffold', 'code');

        phase = 'installing';
        checkAbort();
        const installed = await verifier.install(signal);
        if (!installed.ok) throw new Error('INSTALL_FAILED');
        completedSteps.push('install');

        phase = 'testing';
        let verification = await verifier.test(signal);
        completedSteps.push('test');

        while (!verification.ok && repairAttempts < request.maxRepairAttempts) {
          phase = 'repairing';
          repairAttempts++;
          checkAbort();
          const repairPrompt = [
            'Repair the generated application.',
            'Return ONLY JSON array of file patches with full file contents.',
            'Only patch files needed to fix the diagnostics.',
            'Never use absolute paths, secrets, or destructive shell commands.',
            'Diagnostics:', JSON.stringify(verification)
          ].join('\n');
          const patches = parseFiles(await options.model.generate({
            system: repairPrompt,
            messages: [{ role: 'user', content: request.prompt }]
          }));
          for (const patch of patches) await workspace.writeFile(patch.path, patch.content, signal);
          phase = 'testing';
          verification = await verifier.test(signal);
        }

        if (!verification.ok) throw new Error('TESTS_FAILED');

        phase = 'validating';
        const build = await verifier.build(signal);
        if (!build.ok) throw new Error('BUILD_FAILED');
        const runtime = await verifier.validateRuntime(signal);
        if (!runtime.ok && runtime.exitCode !== undefined) throw new Error('RUNTIME_VALIDATION_FAILED');
        if (repairAttempts > 0) completedSteps.push('repair');
        completedSteps.push('validate');

        return { projectId: request.projectId, phase: 'completed', blueprint, completedSteps, repairAttempts, summary: 'Application generated, tested and validated.' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'APPLICATION_BUILD_FAILED';
        phase = message === 'APPLICATION_BUILD_CANCELLED' ? 'cancelled' : 'failed';
        return { projectId: request.projectId, phase, blueprint, completedSteps, repairAttempts, errorCode: message };
      }
    }
  };
}
