import { describe, expect, it } from 'vitest';
import { CapabilityEngine } from './capability-engine.js';
import { PermissionEngine } from './permission-engine.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLogger } from './audit-logger.js';

describe('Permissions & Policy Engines', () => {
  it('correctly maps capability risk levels', () => {
    expect(CapabilityEngine.getRiskLevel('web.read')).toBe('LOW');
    expect(CapabilityEngine.getRiskLevel('screen.capture')).toBe('HIGH');
    expect(CapabilityEngine.getRiskLevel('device.camera.use')).toBe('CRITICAL');
  });

  it('checks in-memory granted permissions', async () => {
    const permEngine = new PermissionEngine();
    const result1 = await permEngine.checkPermission({ userId: 'u1', capability: 'web.read' });
    expect(result1.granted).toBe(false);

    permEngine.grantInMemory('u1', 'web.read');
    const result2 = await permEngine.checkPermission({ userId: 'u1', capability: 'web.read' });
    expect(result2.granted).toBe(true);
  });

  it('evaluates default risk policies', async () => {
    const policyEngine = new PolicyEngine();

    const lowRes = await policyEngine.evaluatePolicy({ capability: 'web.read' });
    expect(lowRes.decision).toBe('allow');

    const highRes = await policyEngine.evaluatePolicy({ capability: 'screen.capture' });
    expect(highRes.decision).toBe('require_approval');

    const critRes = await policyEngine.evaluatePolicy({ capability: 'device.camera.use' });
    expect(critRes.decision).toBe('require_approval');
  });

  it('records audit logs in memory', async () => {
    const logger = new AuditLogger();
    await logger.log({
      actor: 'agent-1',
      actorType: 'agent',
      userId: 'u1',
      capability: 'web.read',
      action: 'fetch_page',
      status: 'executed',
      payload: { url: 'https://example.com' }
    });

    const logs = logger.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('fetch_page');
  });
});
