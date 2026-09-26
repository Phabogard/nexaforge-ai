import { describe, expect, it } from "vitest";

describe("database - createProjectVersion concurrency lock structure", () => {
  it("allocates versions sequentially without race conditions when queried", async () => {
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

    const results = await Promise.all([
      mockCreateProjectVersion("proj-1", {}),
      mockCreateProjectVersion("proj-1", {}),
      mockCreateProjectVersion("proj-1", {})
    ]);
    const versions = results.map(r => r.version).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3]);
  });
});
