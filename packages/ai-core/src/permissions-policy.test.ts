import { describe, expect, it } from 'vitest';
import { CapabilityEngine } from './capability-engine.js';
import { PermissionEngine } from './permission-engine.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLogger } from './audit-logger.js';

describe('Permissions & Policy Engines Hardening', () => {
  it('correctly maps capability risk levels', () => {
    expect(CapabilityEngine.getRiskLevel('web.read')).toBe('LOW');
    expect(CapabilityEngine.getRiskLevel('screen.capture')).toBe('HIGH');
    expect(CapabilityEngine.getRiskLevel('device.camera.use')).toBe('CRITICAL');
  });

  it('supports explicit namespace wildcard capability grants', () => {
    expect(CapabilityEngine.isCapabilityAllowedInScope('web.read', ['web.*'])).toBe(true);
    expect(CapabilityEngine.isCapabilityAllowedInScope('screen.capture', ['web.*'])).toBe(false);
  });

  it('rejects expired in-memory permission', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'web.read', 'ws-1', undefined, -1000); // expired 1s ago

    const res = await permEngine.checkPermission({ userId: 'u1', workspaceId: 'ws-1', capability: 'web.read' });
    expect(res.granted).toBe(false);
    expect(res.reason).toContain('expired');
  });

  it('rejects revoked permission', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'web.read', 'ws-1');
    permEngine.revokeInMemory('u1', 'web.read', 'ws-1');

    const res = await permEngine.checkPermission({ userId: 'u1', workspaceId: 'ws-1', capability: 'web.read' });
    expect(res.granted).toBe(false);
    expect(res.reason).toContain('revoked');
  });

  it('enforces strict user isolation', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('user-A', 'web.read', 'ws-1');

    const resA = await permEngine.checkPermission({ userId: 'user-A', workspaceId: 'ws-1', capability: 'web.read' });
    expect(resA.granted).toBe(true);

    const resB = await permEngine.checkPermission({ userId: 'user-B', workspaceId: 'ws-1', capability: 'web.read' });
    expect(resB.granted).toBe(false);
  });

  it('enforces strict workspace isolation', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'web.read', 'ws-A');

    const resA = await permEngine.checkPermission({ userId: 'u1', workspaceId: 'ws-A', capability: 'web.read' });
    expect(resA.granted).toBe(true);

    const resB = await permEngine.checkPermission({ userId: 'u1', workspaceId: 'ws-B', capability: 'web.read' });
    expect(resB.granted).toBe(false);
  });

  it('enforces strict agent isolation', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'web.read', 'ws-A', 'agent-1');

    const resAgent1 = await permEngine.checkPermission({ userId: 'u1', workspaceId: 'ws-A', agentId: 'agent-1', capability: 'web.read' });
    expect(resAgent1.granted).toBe(true);

    const resAgent2 = await permEngine.checkPermission({ userId: 'u1', workspaceId: 'ws-A', agentId: 'agent-2', capability: 'web.read' });
    expect(resAgent2.granted).toBe(false);
  });

  it('validates custom policy values and defaults invalid ones to HIGH risk', async () => {
    const policyEngine = new PolicyEngine();

    const lowRes = await policyEngine.evaluatePolicy({ capability: 'web.read' });
    expect(lowRes.decision).toBe('allow');

    const invalidRiskRes = await policyEngine.evaluatePolicy({ capability: 'web.read', riskLevel: 'INVALID_RISK' as any });
    expect(invalidRiskRes.riskLevel).toBe('HIGH');
    expect(invalidRiskRes.decision).toBe('require_approval');
  });
});
