import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@neondatabase/serverless';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dbRoot = join(root, 'packages', 'db');
const migrationDir = join(dbRoot, 'src', 'migrations');
const schemaFile = join(dbRoot, 'schema.sql');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for database migrations');
}

const client = new Client(databaseUrl);

async function queryScalar(sql, values = []) {
  const result = await client.query(sql, values);
  return result.rows[0];
}

async function applyFile(id, filePath) {
  const existing = await queryScalar('SELECT 1 FROM schema_migrations WHERE id = $1', [id]);
  if (existing) return false;

  const sql = await readFile(filePath, 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (id) VALUES ($1)',
      [id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  console.log('[db:migrate] applied', id);
  return true;
}

async function main() {
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['nexaforge:schema-migrations']);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );

    const core = await queryScalar(`
      SELECT
        to_regclass('public.users') IS NOT NULL AS users,
        to_regclass('public.workspaces') IS NOT NULL AS workspaces,
        to_regclass('public.tasks') IS NOT NULL AS tasks,
        to_regclass('public.task_events') IS NOT NULL AS task_events
    `);

    const baseline = await queryScalar(
      'SELECT 1 FROM schema_migrations WHERE id = $1',
      ['000_schema']
    );

    if (!baseline) {
      if (!core.users && !core.workspaces && !core.tasks && !core.task_events) {
        await applyFile('000_schema', schemaFile);
      } else if (core.users && core.workspaces && core.tasks && core.task_events) {
        await client.query(
          'INSERT INTO schema_migrations (id) VALUES ($1)',
          ['000_schema']
        );
        console.log('[db:migrate] marked existing core schema as 000_schema');
      } else {
        throw new Error('DATABASE_SCHEMA_INCOMPLETE: core tables are partially present; refusing to guess migration state');
      }
    }

    const files = (await readdir(migrationDir))
      .filter(name => /^\\d+_.+\\.sql$/.test(name))
      .sort();

    for (const file of files) {
      await applyFile(file.replace(/\\.sql$/, ''), join(migrationDir, file));
    }

    console.log('[db:migrate] complete');
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['nexaforge:schema-migrations']).catch(() => undefined);
    await client.end();
  }
}

main().catch(error => {
  console.error('[db:migrate] failed', error);
  process.exitCode = 1;
});
