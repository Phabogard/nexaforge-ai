import { describe, expect, it } from 'vitest';
import { AuditPayloadSanitizer } from './audit-payload-sanitizer.js';
import { AuditLogger } from './audit-logger.js';

describe('AuditPayloadSanitizer & AuditLogger Hardening', () => {
  it('redacts sensitive keys, tokens, auth headers, .env values, and private keys across nested objects and arrays', () => {
    const input = {
      username: 'jules',
      password: 'supersecretpassword123',
      passwd: 'pass',
      apiKey: 'sk-1234567890',
      nested: {
        accessToken: 'bearer-xyz',
        publicInfo: 'hello',
        credentialsArray: [{ secretToken: '123' }]
      },
      envValue: 'DATABASE_URL=postgres://user:pass@localhost:5432/db',
      pemString: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...'
    };

    const sanitized = AuditPayloadSanitizer.sanitize(input) as Record<string, any>;
    expect(sanitized.username).toBe('jules');
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.passwd).toBe('[REDACTED]');
    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.nested.accessToken).toBe('[REDACTED]');
    expect(sanitized.nested.credentialsArray[0].secretToken).toBe('[REDACTED]');
    expect(sanitized.nested.publicInfo).toBe('hello');
    expect(sanitized.envValue).toBe('[REDACTED_ENV_STRING]');
    expect(sanitized.pemString).toBe('[REDACTED_SECRET_STRING]');
  });

  it('fails closed when DB audit fails for HIGH risk action', async () => {
    const mockDbRepo = {
      addAuditLog: async () => {
        throw new Error('DB_CONNECTION_ERROR');
      }
    } as any;

    const logger = new AuditLogger(mockDbRepo);

    await expect(
      logger.log({
        actor: 'agent-1',
        actorType: 'agent',
        capability: 'screen.capture',
        action: 'capture_screen',
        status: 'executed'
      })
    ).rejects.toThrow('PERSISTENT_AUDIT_LOG_FAILED');
  });

  it('fails closed when repository is missing for HIGH risk action', async () => {
    const logger = new AuditLogger(null);

    await expect(
      logger.log({
        actor: 'agent-1',
        actorType: 'agent',
        capability: 'screen.capture',
        action: 'capture_screen',
        status: 'executed'
      })
    ).rejects.toThrow('PERSISTENT_AUDIT_LOG_REQUIRED');
  });
});
