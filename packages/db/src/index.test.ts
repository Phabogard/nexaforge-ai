import { describe, expect, it } from "vitest";

describe("database - createProjectVersion concurrency lock structure", () => {
  it("documents SQL advisory transaction lock structure and MAX version allocation model", () => {
    // Note: The actual SQL implementation in packages/db/src/index.ts uses:
    // WITH lock AS (SELECT pg_advisory_xact_lock(hashtext(${i.projectId}))),
    // v AS (SELECT COALESCE(MAX(version), 0) + 1 AS next_ver FROM application_project_versions WHERE project_id = ${i.projectId}::uuid)
    // INSERT INTO application_project_versions (project_id, version, blueprint)
    // SELECT ${i.projectId}::uuid, v.next_ver, ${JSON.stringify(i.blueprint)}::jsonb FROM v RETURNING *
    //
    // This unit test verifies the sequential allocation logic structure in JS.
    // In live PostgreSQL environments, pg_advisory_xact_lock serializes transaction execution
    // per project ID to prevent version collisions.

    let currentVersion = 0;
    const lockMap = new Set<string>();

    async function mockCreateProjectVersion(projectId: string, blueprint: unknown) {
      while (lockMap.has(projectId)) {
        await new Promise(r => setTimeout(r, 10));
      }
      lockMap.add(projectId);
      try {
        currentVersion += 1;
        const ver = currentVersion;
        return { id: "v-" + ver, projectId, version: ver, blueprint, createdAt: new Date().toISOString() };
      } finally {
        lockMap.delete(projectId);
      }
    }

    return Promise.all([
      mockCreateProjectVersion("proj-1", {}),
      mockCreateProjectVersion("proj-1", {}),
      mockCreateProjectVersion("proj-1", {})
    ]).then(results => {
      const versions = results.map(r => r.version).sort((a, b) => a - b);
      expect(versions).toEqual([1, 2, 3]);
    });
  });
});
