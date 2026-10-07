import type { Capability, CapabilityGrant, RiskLevel } from '@nexaforge/shared';

const CAPABILITY_RISKS: Record<Capability, RiskLevel> = {
  'web.read': 'LOW',
  'web.search': 'LOW',
  'web.navigate': 'MEDIUM',
  'web.form.fill': 'MEDIUM',
  'web.click': 'MEDIUM',
  'screen.capture': 'HIGH',
  'screen.observe': 'HIGH',
  'device.files.read': 'MEDIUM',
  'device.files.write': 'HIGH',
  'device.camera.use': 'CRITICAL',
  'device.microphone.use': 'CRITICAL',
  'device.location.read': 'HIGH',
  'calendar.read': 'LOW',
  'calendar.create': 'MEDIUM',
  'calendar.update': 'MEDIUM',
  'contacts.read': 'MEDIUM',
  'application.read': 'LOW',
  'application.write': 'HIGH',
  'ai.generate': 'LOW',
  'ai.analyze': 'LOW',
  'ai.execute': 'MEDIUM'
};

export class CapabilityEngine {
  static getRiskLevel(capability: Capability): RiskLevel {
    return CAPABILITY_RISKS[capability] ?? 'HIGH';
  }

  static isCapabilityAllowedInScope(requiredCap: Capability, grantedCaps: CapabilityGrant[]): boolean {
    if (grantedCaps.includes(requiredCap)) return true;

    // Support wildcard matching if scoped (e.g. 'web.*' covers 'web.read')
    const prefix = requiredCap.split('.')[0];
    if (grantedCaps.includes(`${prefix}.*` as CapabilityGrant)) return true;

    return false;
  }
}
