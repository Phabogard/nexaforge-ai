export interface VerificationResult {
  ok: boolean;
  stage: 'install' | 'test' | 'build' | 'runtime';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  diagnostics: string[];
}

export interface BuildVerifier {
  install(signal?: AbortSignal): Promise<VerificationResult>;
  test(signal?: AbortSignal): Promise<VerificationResult>;
  build(signal?: AbortSignal): Promise<VerificationResult>;
  validateRuntime(signal?: AbortSignal): Promise<VerificationResult>;
}

export function firstFailure(results: VerificationResult[]): VerificationResult | undefined {
  return results.find((result) => !result.ok);
}
