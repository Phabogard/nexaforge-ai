import { describe, expect, it } from 'vitest';
import { executionErrorStatus } from './server.js';

describe('executionErrorStatus', () => {
  it('maps authorization failures to 403', () => {
    expect(executionErrorStatus('AGENT_SESSION_INVALID_OR_REVOKED')).toBe(403);
    expect(executionErrorStatus('AGENT_CAPABILITY_NOT_GRANTED:ai.execute')).toBe(403);
    expect(executionErrorStatus('POLICY_DENIED')).toBe(403);
  });

  it('maps provider configuration failures to 503', () => {
    expect(executionErrorStatus('MODEL_PROVIDER_NOT_CONFIGURED')).toBe(503);
    expect(executionErrorStatus('SECURITY_REPOSITORY_NOT_CONFIGURED')).toBe(503);
  });

  it('maps action timeout to 504', () => {
    expect(executionErrorStatus('ACTION_TIMEOUT')).toBe(504);
  });

  it('maps unexpected runtime failures to 500', () => {
    expect(executionErrorStatus('OPENAI_HTTP_500')).toBe(500);
    expect(executionErrorStatus('UNKNOWN_RUNTIME_FAILURE')).toBe(500);
  });
});
