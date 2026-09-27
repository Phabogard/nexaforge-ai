import { chromium } from "playwright";
import type { WorkspaceExecutor, WorkspaceProcess } from "./workspace-tools";

export interface BrowserValidationResult {
  ok: boolean;
  status?: number;
  url: string;
  title?: string;
  diagnostics: string[];
}

export interface BrowserValidatorOptions {
  workspace: WorkspaceExecutor;
  command: { command: string; args: string[] };
  cwd?: string;
  port?: number;
  path?: string;
  startupTimeoutMs?: number;
  navigationTimeoutMs?: number;
  executablePath?: string;
}

export async function validateApplicationInBrowser(
  options: BrowserValidatorOptions,
  signal?: AbortSignal
): Promise<BrowserValidationResult> {
  const port = options.port ?? 3000;
  const url = "http://127.0.0.1:" + port + (options.path ?? "/");
  const startFn = (options.workspace as any).startProcessForPhase
    ? (cmd: any, sig?: AbortSignal) => (options.workspace as any).startProcessForPhase("browser", cmd, sig)
    : options.workspace.startProcess
    ? (cmd: any, sig?: AbortSignal) => options.workspace.startProcess!(cmd, sig)
    : undefined;

  if (!startFn) return { ok: false, url, diagnostics: ["workspace executor does not support long-running processes"] };

  let appProcess: WorkspaceProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    appProcess = await startFn({
      command: options.command.command,
      args: options.command.args,
      cwd: options.cwd ?? ".",
      timeoutMs: options.startupTimeoutMs ?? 10000,
      env: { PORT: String(port) }
    }, signal);

    const deadline = Date.now() + (options.startupTimeoutMs ?? 10000);
    let lastError = "browser target not ready";

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("WORKSPACE_OPERATION_ABORTED");

      let timer: any | undefined;
      if (!appProcess) return { ok: false, url, diagnostics: ["failed to start process"] };
      const earlyExit = await Promise.race([
        appProcess.result,
        new Promise<undefined>(resolve => { timer = setTimeout(resolve, 200); })
      ]);
      if (timer) clearTimeout(timer);

      if (earlyExit && appProcess) {
        const exitResult = earlyExit as { stderr: string; stdout: string };
        return {
          ok: false,
          url,
          diagnostics: ["application process exited before browser validation", exitResult.stderr, exitResult.stdout].filter(Boolean).slice(0, 8)
        };
      }

      try {
        browser = await chromium.launch({
          headless: true,
          executablePath: options.executablePath || undefined,
          args: [
            "--disable-dev-shm-usage",
            ...(globalThis.process?.env?.NEXAFORGE_BROWSER_NO_SANDBOX === "true" ? ["--no-sandbox"] : [])
          ]
        });
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(options.navigationTimeoutMs ?? 10000);
        const response = await page.goto(url, { waitUntil: "domcontentloaded" });
        if (!response) {
          lastError = "browser navigation returned no response";
        } else if (response.status() >= 200 && response.status() < 500) {
          const title = await page.title().catch(() => undefined);
          await browser.close();
          browser = undefined;
          return {
            ok: true,
            status: response.status(),
            url: response.url(),
            title,
            diagnostics: ["browser smoke test passed: HTTP " + response.status(), title ? "page title: " + title : "page title unavailable"]
          };
        } else {
          lastError = "browser navigation returned HTTP " + response.status();
        }
        await browser.close();
        browser = undefined;
      } catch (error) {
        await browser?.close().catch(() => undefined);
        browser = undefined;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      ok: false,
      url,
      diagnostics: ["browser validation timed out after " + (options.startupTimeoutMs ?? 10000) + "ms", lastError]
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
      browser = undefined;
    }
    if (appProcess) {
      appProcess.kill("SIGTERM");
      await Promise.race([
        appProcess.result,
        new Promise(r => setTimeout(r, 500))
      ]).catch(() => undefined);
    }
  }
}
