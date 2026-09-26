export interface WorkspacePathPolicy {
  root: string;
  allowRead: boolean;
  allowWrite: boolean;
  allowDelete: boolean;
  allowExec: boolean;
}

export interface CommandPolicy {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface WorkspaceExecutor {
  readFile(path: string, signal?: AbortSignal): Promise<string>;
  writeFile(path: string, content: string, signal?: AbortSignal): Promise<void>;
  deleteFile(path: string, signal?: AbortSignal): Promise<void>;
  exec(command: CommandPolicy, signal?: AbortSignal): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/**
 * Security boundary for generated projects.
 * Implementations must reject paths outside the project root and must not
 * expose host secrets or unrestricted shell/network access.
 */
export interface WorkspaceSandbox {
  readonly policy: WorkspacePathPolicy;
  resolve(relativePath: string): string;
  validateCommand(command: CommandPolicy): void;
}
