import type { ModelProvider } from './index';
import type {
  ApplicationBuildRequest, ApplicationBuildResult, ApplicationBuilder,
  ApplicationBuildPhase, ProjectBlueprint
} from './application-builder';
import { createApplicationPlanner } from './application-planner';
import { createBuildVerifier, type BuildVerifier } from './build-verifier';
import { createWorkspaceSandbox } from './workspace-sandbox';
import { createContainerWorkspaceSandbox } from './container-workspace-sandbox';
import type { WorkspacePathPolicy } from './workspace-tools';
import { normalizeDependencySpec, validateProjectPath } from './application-policy';
import { createApplicationTools } from './application-tools';
import { createApplicationCodingAgent } from './application-coding-agent';

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
      const checkpoints = request.resumeFrom ?? [];
      const has = (step:string) => checkpoints.some(c => c.stepKey === step);
      const checkpoint = async (stepKey:string, nextPhase:ApplicationBuildPhase, status:'running'|'completed'|'failed'='completed', output?:unknown, errorCode?:string) => { if(status==='completed' && !completedSteps.includes(stepKey)) completedSteps.push(stepKey); await request.checkpoint?.({stepKey,phase:nextPhase,status,blueprint,repairAttempts,output,errorCode}); };
      const checkAbort = () => { if (signal?.aborted) throw new Error('APPLICATION_BUILD_CANCELLED'); };

      try {
        checkAbort();
        if (has('plan')) blueprint = checkpoints.find(c => c.stepKey === 'plan')?.blueprint;
        if (!blueprint) { blueprint = await planner.createBlueprint(request); await checkpoint('plan','planning'); }
        else if (!completedSteps.includes('plan')) completedSteps.push('plan');
        phase = 'scaffolding';

        const policy = {
          root: request.workspaceRoot,
          allowRead: true,
          allowWrite: true,
          allowDelete: true,
          allowExec: true,
          ...(options.sandboxPolicy ?? {})
        };
        const workspace = process.env.NEXAFORGE_APPLICATION_SANDBOX === 'container'
          ? createContainerWorkspaceSandbox({ root: request.workspaceRoot })
          : createWorkspaceSandbox(policy);
        const verifier = options.verifierFactory
          ? options.verifierFactory(request.workspaceRoot, blueprint)
          : createBuildVerifier({ workspace, packageManager: blueprint.packageManager, cwd: '.' });

        if (!has('code')) {
          const codingTools = createApplicationTools({ workspace, verifier, packageManager: blueprint.packageManager, cwd: '.' });
          const codingAgent = createApplicationCodingAgent({ model: options.model, tools: codingTools.tools });
          const coding = await codingAgent.run({
            prompt: request.prompt,
            blueprint,
            workspaceRoot: request.workspaceRoot,
            maxIterations: Math.max(1, request.maxIterations),
            taskId: request.projectId,
            signal
          });
          if (!coding.completed) throw new Error('CODING_AGENT_MAX_ITERATIONS');
          if (!coding.calls.some(call => call.tool === 'filesystem.write')) {
            await workspace.writeFile('package.json', packageJson(blueprint), signal);
          }
          await checkpoint('scaffold','scaffolding');
          await checkpoint('code','coding');
        }

        phase = 'installing';
        checkAbort();
        const installed = has('install') ? {ok:true} : await verifier.install(signal);
        if (!installed.ok) throw new Error('INSTALL_FAILED');
        if (!has('install')) await checkpoint('install','installing');

        phase = 'testing';
        let verification = has('test') ? {ok:true} : await verifier.test(signal);
        if (!has('test')) await checkpoint('test','testing');

        while (!verification.ok && repairAttempts < request.maxRepairAttempts) {
          phase = 'repairing';
          repairAttempts++;
          checkAbort();
          await checkpoint('repair', 'repairing', 'running', { diagnostics: verification });
          const repairTools = createApplicationTools({ workspace, verifier, packageManager: blueprint.packageManager, cwd: '.' });
          const repairAgent = createApplicationCodingAgent({ model: options.model, tools: repairTools.tools });
          const repair = await repairAgent.run({
            prompt: [
              'Repair the application using the real verification diagnostics below.',
              'First inspect the relevant files. Make the smallest correct changes.',
              'Run tests or build after changes and continue until the diagnostics are resolved.',
              'Do not merely describe a patch: modify the workspace.',
              'Diagnostics:', JSON.stringify(verification)
            ].join('\\n'),
            blueprint,
            workspaceRoot: request.workspaceRoot,
            maxIterations: Math.max(2, Math.ceil(request.maxIterations / 2)),
            taskId: request.projectId,
            signal
          });
          if (!repair.completed) {
            await checkpoint('repair', 'repairing', 'failed', { diagnostics: verification, calls: repair.calls }, 'REPAIR_AGENT_MAX_ITERATIONS');
            throw new Error('REPAIR_AGENT_MAX_ITERATIONS');
          }
          phase = 'testing';
          verification = await verifier.test(signal);
          if (!verification.ok && repairAttempts >= request.maxRepairAttempts) {
            await checkpoint('repair', 'repairing', 'failed', { diagnostics: verification, calls: repair.calls }, 'TESTS_FAILED');
          } else {
            await checkpoint('repair', 'repairing', 'completed', { diagnostics: verification, calls: repair.calls });
          }
        }

        if (!verification.ok) throw new Error('TESTS_FAILED');

        phase = 'validating';
        const build = await verifier.build(signal);
        if (!build.ok) throw new Error('BUILD_FAILED');
        const runtime = has('validate') ? { ok: true, stage: 'runtime' as const, diagnostics: ['runtime validation resumed from checkpoint'] } : await verifier.validateRuntime(signal);
        if (!runtime.ok) throw new Error('RUNTIME_VALIDATION_FAILED');
        let browser = has('browser') ? { ok: true, stage: 'browser' as const, diagnostics: ['browser validation resumed from checkpoint'] } : await verifier.validateBrowser(signal);
        while (!browser.ok && repairAttempts < request.maxRepairAttempts) {
          phase = 'repairing';
          repairAttempts++;
          checkAbort();
          await checkpoint('repair', 'repairing', 'running', { diagnostics: browser });
          const repairTools = createApplicationTools({ workspace, verifier, packageManager: blueprint.packageManager, cwd: '.' });
          const repairAgent = createApplicationCodingAgent({ model: options.model, tools: repairTools.tools });
          const repair = await repairAgent.run({
            prompt: [
              'Repair the application using the browser validation diagnostics below.',
              'Inspect the relevant files and make the smallest correct changes.',
              'Run tests, build and runtime validation after changes.',
              'Do not merely describe a patch: modify the workspace.',
              'Browser diagnostics:', JSON.stringify(browser)
            ].join('\\n'),
            blueprint,
            workspaceRoot: request.workspaceRoot,
            maxIterations: Math.max(2, Math.ceil(request.maxIterations / 2)),
            taskId: request.projectId,
            signal
          });
          if (!repair.completed) {
            await checkpoint('repair', 'repairing', 'failed', { diagnostics: browser, calls: repair.calls }, 'REPAIR_AGENT_MAX_ITERATIONS');
            throw new Error('REPAIR_AGENT_MAX_ITERATIONS');
          }
          const repairedTests = await verifier.test(signal);
          if (!repairedTests.ok) {
            browser = { ok: false, stage: 'browser', diagnostics: ['repair introduced or left test failures', ...repairedTests.diagnostics] };
          } else {
            const repairedBuild = await verifier.build(signal);
            if (!repairedBuild.ok) {
              browser = { ok: false, stage: 'browser', diagnostics: ['repair introduced or left build failures', ...repairedBuild.diagnostics] };
            } else {
              const repairedRuntime = await verifier.validateRuntime(signal);
              if (!repairedRuntime.ok) {
                browser = { ok: false, stage: 'browser', diagnostics: ['repair introduced or left runtime failures', ...repairedRuntime.diagnostics] };
              } else {
                browser = await verifier.validateBrowser(signal);
              }
            }
          }
          if (!browser.ok && repairAttempts >= request.maxRepairAttempts) {
            await checkpoint('repair', 'repairing', 'failed', { diagnostics: browser, calls: repair.calls }, 'BROWSER_VALIDATION_FAILED');
          } else {
            await checkpoint('repair', 'repairing', 'completed', { diagnostics: browser, calls: repair.calls });
          }
        }

        if (!browser.ok) throw new Error('BROWSER_VALIDATION_FAILED');
        if (repairAttempts > 0 && !has('repair')) await checkpoint('repair','repairing');
        if (!has('validate')) await checkpoint('validate','validating');
        if (!has('browser')) await checkpoint('browser','validating', 'completed', { diagnostics: browser });

        return { projectId: request.projectId, phase: 'completed', blueprint, completedSteps, repairAttempts, summary: 'Application generated, tested, runtime-validated and browser-validated.' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'APPLICATION_BUILD_FAILED';
        phase = message === 'APPLICATION_BUILD_CANCELLED' ? 'cancelled' : 'failed';
        return { projectId: request.projectId, phase, blueprint, completedSteps, repairAttempts, errorCode: message };
      }
    }
  };
}
