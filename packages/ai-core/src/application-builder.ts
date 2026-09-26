export type ApplicationBuildPhase =
  | 'queued'
  | 'planning'
  | 'scaffolding'
  | 'coding'
  | 'installing'
  | 'testing'
  | 'repairing'
  | 'validating'
  | 'deploying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_approval';

export type ApplicationBuildStatus = Exclude<ApplicationBuildPhase, 'queued'> | 'queued';

export interface ProjectBlueprint {
  name: string;
  description: string;
  runtime: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  directories: string[];
  files: string[];
  commands: {
    install?: string;
    test?: string;
    build?: string;
    start?: string;
  };
  dependencies: string[];
  devDependencies: string[];
  requiresDatabase: boolean;
}

export interface ApplicationBuildStep {
  id: string;
  phase: ApplicationBuildPhase;
  objective: string;
  dependsOn: string[];
  maxAttempts: number;
  requiresApproval: boolean;
}

export interface ApplicationBuildCheckpoint { stepKey:string; phase:ApplicationBuildPhase; status?:'running'|'completed'|'failed'; blueprint?:ProjectBlueprint; repairAttempts?:number; output?:unknown; errorCode?:string; }

export interface ApplicationBuildRequest {
  projectId: string;
  prompt: string;
  workspaceRoot: string;
  maxIterations: number;
  maxRepairAttempts: number;
  resumeFrom?: ApplicationBuildCheckpoint[];
  checkpoint?: (checkpoint: ApplicationBuildCheckpoint) => Promise<void>;
}

export interface ApplicationBuildResult {
  projectId: string;
  phase: ApplicationBuildPhase;
  blueprint?: ProjectBlueprint;
  completedSteps: string[];
  repairAttempts: number;
  errorCode?: string;
  summary?: string;
}

export interface ApplicationBuilder {
  build(
    request: ApplicationBuildRequest,
    signal?: AbortSignal,
  ): Promise<ApplicationBuildResult>;
}

/**
 * Stable state machine for autonomous application generation.
 * The builder must checkpoint after every phase transition.
 */
export const APPLICATION_BUILD_PHASES: readonly ApplicationBuildPhase[] = [
  'queued',
  'planning',
  'scaffolding',
  'coding',
  'installing',
  'testing',
  'repairing',
  'validating',
  'deploying',
  'completed',
  'failed',
  'cancelled',
  'waiting_approval',
];

export function createApplicationBuildSteps(request: ApplicationBuildRequest): ApplicationBuildStep[] {
  const approval = request.maxRepairAttempts > 0;
  return [
    { id: 'plan', phase: 'planning', objective: 'Create a validated project blueprint', dependsOn: [], maxAttempts: 1, requiresApproval: false },
    { id: 'scaffold', phase: 'scaffolding', objective: 'Create the project structure and baseline files', dependsOn: ['plan'], maxAttempts: 2, requiresApproval: approval },
    { id: 'code', phase: 'coding', objective: 'Implement the requested application features', dependsOn: ['scaffold'], maxAttempts: Math.max(1, request.maxIterations), requiresApproval: approval },
    { id: 'install', phase: 'installing', objective: 'Install declared dependencies in the sandbox', dependsOn: ['code'], maxAttempts: 2, requiresApproval: true },
    { id: 'test', phase: 'testing', objective: 'Run tests and collect diagnostics', dependsOn: ['install'], maxAttempts: 1, requiresApproval: false },
    { id: 'repair', phase: 'repairing', objective: 'Patch failures using test/build diagnostics', dependsOn: ['test'], maxAttempts: request.maxRepairAttempts, requiresApproval: approval },
    { id: 'validate', phase: 'validating', objective: 'Build and validate the application runtime', dependsOn: ['repair'], maxAttempts: 2, requiresApproval: false },
  ];
}
