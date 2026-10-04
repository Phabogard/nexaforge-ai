import type { Capability } from '@nexaforge/shared';

export interface DeviceClient {
  deviceId: string;
  userId: string;
  platform: 'web' | 'desktop' | 'android' | 'ios';
  appVersion: string;
  status: 'online' | 'offline' | 'unregistered';
  registeredCapabilities: Capability[];
}

export interface LocalCapabilityBridge {
  deviceId: string;
  hasCapability(capability: Capability): Promise<boolean>;
  requestCapabilityPermission(capability: Capability, reason: string): Promise<boolean>;
  executeLocalAction(capability: Capability, action: string, params: Record<string, unknown>): Promise<unknown>;
}
