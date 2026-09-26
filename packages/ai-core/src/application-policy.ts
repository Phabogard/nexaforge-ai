const FORBIDDEN_COMMAND_CHARS = [';', '&', '|', '$', '<', '>', '`', '\\', '\n', '\r'];
const ALLOWED_EXECUTABLES = new Set([
  'bun','bunx','node','npm','npx','pnpm','pnpm.cmd','yarn','python','python3',
  'tsx','tsc','vitest','vite','next','eslint','prettier'
]);

export function validateProjectPath(value: string): void {
  if (!value || value.length > 240) throw new Error('INVALID_PROJECT_PATH');
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) throw new Error('INVALID_PROJECT_PATH');
  const normalized = value.replaceAll('\\\\', '/');
  if (normalized.split('/').includes('..')) throw new Error('INVALID_PROJECT_PATH');
}

export function validateProjectCommand(command: string | undefined): void {
  if (!command) return;
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 500 || FORBIDDEN_COMMAND_CHARS.some(char => trimmed.includes(char))) {
    throw new Error('UNSAFE_PROJECT_COMMAND');
  }
  const executable = trimmed.split(/\s+/)[0];
  if (!ALLOWED_EXECUTABLES.has(executable)) throw new Error('UNSAFE_PROJECT_COMMAND');
}

function splitPackageSpec(spec: string): { name: string; version: string } {
  const value = spec.trim();
  if (value.startsWith('@')) {
    const at = value.indexOf('@', 1);
    if (at < 0) throw new Error('UNPINNED_DEPENDENCY');
    return { name: value.slice(0, at), version: value.slice(at + 1) };
  }
  const at = value.lastIndexOf('@');
  if (at <= 0) throw new Error('UNPINNED_DEPENDENCY');
  return { name: value.slice(0, at), version: value.slice(at + 1) };
}

export function normalizeDependencySpec(spec: string): { name: string; version: string } {
  const { name, version } = splitPackageSpec(spec);
  if (!/^[@a-zA-Z0-9._/-]+$/.test(name) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('INVALID_DEPENDENCY_SPEC');
  }
  return { name, version };
}
