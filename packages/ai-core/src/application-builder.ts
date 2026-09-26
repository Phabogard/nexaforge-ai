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

export interface ApplicationBuildRequest {
  projectId: string;
  prompt: string;
  workspaceRoot: string;
  maxIterations: number;
  maxRepairAttempts: number;
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
