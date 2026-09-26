import type { Tool } from './index';

export interface ApplicationToolset {
  tools: Tool[];
  names: string[];
}

const tool = (name: string, description: string, risk: Tool['risk']): Tool => ({
  name,
  description,
  risk,
  async execute() {
    throw new Error(`TOOL_NOT_IMPLEMENTED:${name}`);
  },
});

/**
 * Canonical capability names for the Application Builder.
 * Implementations are deliberately separate from the contracts so that
 * filesystem/shell execution can later be backed by a real sandbox.
 */
export const applicationBuilderTools: ApplicationToolset = {
  tools: [
    tool('filesystem.read', 'Read a file inside the project workspace', 'low'),
    tool('filesystem.write', 'Create or replace a file inside the project workspace', 'high'),
    tool('filesystem.delete', 'Delete a file inside the project workspace', 'high'),
    tool('shell.exec', 'Execute an allowlisted command inside the project sandbox', 'high'),
    tool('package.install', 'Install project dependencies using the configured package manager', 'high'),
    tool('git.init', 'Initialize git metadata for the generated project', 'medium'),
    tool('git.commit', 'Create a source-control checkpoint for generated changes', 'medium'),
    tool('test.run', 'Run the project test suite and return diagnostics', 'medium'),
    tool('build.run', 'Build the generated application and return diagnostics', 'medium'),
    tool('runtime.validate', 'Validate that the generated application starts and responds', 'medium'),
  ],
  names: [
    'filesystem.read',
    'filesystem.write',
    'filesystem.delete',
    'shell.exec',
    'package.install',
    'git.init',
    'git.commit',
    'test.run',
    'build.run',
    'runtime.validate',
  ],
};
