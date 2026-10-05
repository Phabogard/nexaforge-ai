import type { Capability } from '@nexaforge/shared';

export interface ScreenPermission {
  userId: string;
  deviceId?: string;
  scope: 'full' | 'window' | 'application' | 'region';
  status: 'granted' | 'denied' | 'revoked' | 'expired';
  grantedAt: number;
  expiresAt: number;
}

export interface ScreenSession {
  sessionId: string;
  userId: string;
  deviceId?: string;
  status: 'active' | 'paused' | 'stopped' | 'expired';
  permission: ScreenPermission;
  startedAt: number;
  expiresAt: number;
}

export interface ScreenContext {
  sessionId: string;
  timestamp: number;
  source: 'full_screen' | 'window' | 'application' | 'region';
  frameReference?: string;
  ocrResult?: string;
  uiElementsDetected?: Array<{ id: string; type: string; label: string; bounds?: unknown }>;
  sensitivityClassification: 'public' | 'internal' | 'confidential' | 'sensitive_form_detected';
}
