import type { ProjectBlueprint } from './application-builder';
import { validateProjectCommand } from './application-policy';

export interface ContainerManifest {
  dockerfile: string;
  context: string;
  port: number;
  healthcheck?: string;
}

export function createContainerManifest(blueprint: ProjectBlueprint, port = 3000): ContainerManifest {
  const install = blueprint.packageManager === 'npm' ? 'npm install' :
    blueprint.packageManager === 'yarn' ? 'yarn install --frozen-lockfile' :
    blueprint.packageManager === 'bun' ? 'bun install --frozen-lockfile' :
    'pnpm install --no-frozen-lockfile';

  const start = blueprint.commands.start?.trim() || (
    blueprint.packageManager === 'npm' ? 'npm run start' :
    blueprint.packageManager === 'yarn' ? 'yarn start' :
    blueprint.packageManager === 'bun' ? 'bun run start' :
    'pnpm start'
  );
  validateProjectCommand(start);
  validateProjectCommand(blueprint.commands.build);
  validateProjectCommand(blueprint.commands.install);

  return {
    context: '.',
    port,
    healthcheck: `http://127.0.0.1:${port}`,
    dockerfile: [
      'FROM node:22-bookworm-slim',
      'ENV NODE_ENV=production',
      'WORKDIR /app',
      'COPY package.json ./',
      blueprint.packageManager === 'pnpm' ? 'RUN corepack enable && corepack prepare pnpm@10.15.0 --activate' : '',
      blueprint.packageManager === 'yarn' ? 'RUN corepack enable && corepack prepare yarn@stable --activate' : '',
      `RUN ${install}`,
      'COPY . .',
      blueprint.commands.build ? `RUN ${blueprint.commands.build}` : '',
      `ENV PORT=${port}`,
      `EXPOSE ${port}`,
      `CMD ["sh", "-c", ${JSON.stringify(start)}]`,
    ].filter(Boolean).join('\n') + '\n'
  };
}
