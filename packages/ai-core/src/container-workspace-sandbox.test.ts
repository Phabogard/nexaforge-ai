import { describe, expect, it } from "vitest";
import { createContainerWorkspaceSandbox, resolveNetworkForPhase, dockerCommand } from "./container-workspace-sandbox";

describe("container workspace sandbox - network isolation", () => {
  it("strictly enforces bridge for install and none for all other phases", () => {
    const opts = { root: "/tmp/workspace" };
    expect(resolveNetworkForPhase(opts, "install")).toBe("bridge");
    expect(resolveNetworkForPhase(opts, "test")).toBe("none");
    expect(resolveNetworkForPhase(opts, "build")).toBe("none");
    expect(resolveNetworkForPhase(opts, "validate")).toBe("none");
    expect(resolveNetworkForPhase(opts, "runtime")).toBe("none");
    expect(resolveNetworkForPhase(opts, "browser")).toBe("none");
    expect(resolveNetworkForPhase(opts, "coding")).toBe("none");
  });

  it("constructs docker command with phase network flags", () => {
    const opts = { root: "/tmp/workspace" };
    const cmd = { command: "pnpm", args: ["install"], cwd: ".", timeoutMs: 10000 };

    const installCmd = dockerCommand(opts, cmd, "install");
    expect(installCmd.args).toContain("--network=bridge");

    const testCmd = dockerCommand(opts, { command: "pnpm", args: ["test"], cwd: ".", timeoutMs: 10000 }, "test");
    expect(testCmd.args).toContain("--network=none");

    const buildCmd = dockerCommand(opts, { command: "pnpm", args: ["build"], cwd: ".", timeoutMs: 10000 }, "build");
    expect(buildCmd.args).toContain("--network=none");

    const runtimeCmd = dockerCommand(opts, { command: "node", args: ["server.js"], cwd: ".", timeoutMs: 10000 }, "runtime");
    expect(runtimeCmd.args).toContain("--network=none");

    const browserCmd = dockerCommand(opts, { command: "node", args: ["server.js"], cwd: ".", timeoutMs: 10000 }, "browser");
    expect(browserCmd.args).toContain("--network=none");
  });

  it("validates paths and commands securely", () => {
    const sandbox = createContainerWorkspaceSandbox({ root: "/tmp/workspace" });
    expect(() => sandbox.resolve("../etc/passwd")).toThrow("WORKSPACE_PATH_INVALID");
    expect(() => sandbox.validateCommand({ command: "sh; rm -rf /", args: [], cwd: ".", timeoutMs: 1000 })).toThrow("WORKSPACE_COMMAND_NOT_ALLOWED");
    expect(() => sandbox.validateCommand({ command: "node", args: ["arg;bad"], cwd: ".", timeoutMs: 1000 })).toThrow("WORKSPACE_COMMAND_ARGUMENT_BLOCKED");
  });
});
