import { describe, expect, it } from "vitest";
import { createContainerWorkspaceSandbox, resolveNetworkForPhase, dockerCommand } from "./container-workspace-sandbox";
import type { ApplicationBuildExecutionPhase } from "./workspace-tools";

describe("container workspace sandbox - network isolation", () => {
  it("strictly enforces bridge for install and none for all other phases", () => {
    const opts = { root: "/tmp/workspace" };
    expect(resolveNetworkForPhase(opts, "install")).toBe("bridge");
    expect(resolveNetworkForPhase(opts, "plan")).toBe("none");
    expect(resolveNetworkForPhase(opts, "scaffold")).toBe("none");
    expect(resolveNetworkForPhase(opts, "coding")).toBe("none");
    expect(resolveNetworkForPhase(opts, "test")).toBe("none");
    expect(resolveNetworkForPhase(opts, "repair")).toBe("none");
    expect(resolveNetworkForPhase(opts, "build")).toBe("none");
    expect(resolveNetworkForPhase(opts, "validate")).toBe("none");
    expect(resolveNetworkForPhase(opts, "runtime")).toBe("none");
    expect(resolveNetworkForPhase(opts, "browser")).toBe("none");
    expect(resolveNetworkForPhase(opts, undefined)).toBe("none");
  });

  it("constructs docker command with phase network flags", () => {
    const opts = { root: "/tmp/workspace" };
    const cmd = { command: "pnpm", args: ["install"], cwd: ".", timeoutMs: 10000 };

    const installCmd = dockerCommand(opts, cmd, "install");
    expect(installCmd.args).toContain("--network=bridge");

    const phases: ApplicationBuildExecutionPhase[] = [
      "test", "build", "validate", "runtime", "browser", "coding", "repair"
    ];

    for (const phase of phases) {
      const phaseCmd = dockerCommand(opts, { command: "node", args: ["server.js"], cwd: ".", timeoutMs: 10000 }, phase);
      expect(phaseCmd.args).toContain("--network=none");
      expect(phaseCmd.args).not.toContain("--network=bridge");
    }
  });

  it("prevents network override attempts by callers for sensitive phases", () => {
    const opts = { root: "/tmp/workspace" };
    const sensitivePhases: ApplicationBuildExecutionPhase[] = [
      "test", "build", "validate", "runtime", "browser", "coding", "repair"
    ];

    for (const phase of sensitivePhases) {
      const resolved = resolveNetworkForPhase(opts, phase);
      expect(resolved).toBe("none");
      const cmd = dockerCommand(opts, { command: "curl", args: ["https://example.com"], cwd: ".", timeoutMs: 5000 }, phase);
      expect(cmd.args).toContain("--network=none");
      expect(cmd.args).not.toContain("--network=bridge");
    }
  });

  it("validates paths and commands securely", () => {
    const sandbox = createContainerWorkspaceSandbox({ root: "/tmp/workspace" });
    expect(() => sandbox.resolve("../etc/passwd")).toThrow("WORKSPACE_PATH_INVALID");
    expect(() => sandbox.validateCommand({ command: "sh; rm -rf /", args: [], cwd: ".", timeoutMs: 1000 })).toThrow("WORKSPACE_COMMAND_NOT_ALLOWED");
    expect(() => sandbox.validateCommand({ command: "node", args: ["arg;bad"], cwd: ".", timeoutMs: 1000 })).toThrow("WORKSPACE_COMMAND_ARGUMENT_BLOCKED");
  });
});
