import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthenticatedIdentity {
  userId: string;
  workspaceId?: string;
}

function base64urlDecode(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4), 'base64').toString('utf8');
}

export function verifyBearerToken(authorization: string | undefined): AuthenticatedIdentity {
  const secret = process.env.NEXAFORGE_AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTHENTICATION_NOT_CONFIGURED');

  if (!authorization?.startsWith('Bearer ')) throw new Error('AUTHENTICATION_REQUIRED');
  const token = authorization.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('INVALID_AUTH_TOKEN');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64urlDecode(encodedHeader));
    payload = JSON.parse(base64urlDecode(encodedPayload));
  } catch {
    throw new Error('INVALID_AUTH_TOKEN');
  }

  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error('UNSUPPORTED_AUTH_TOKEN');

  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  const a = Buffer.from(encodedSignature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('INVALID_AUTH_TOKEN');

  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('AUTH_SUBJECT_REQUIRED');
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('AUTH_TOKEN_EXPIRED');

  const issuer = process.env.NEXAFORGE_AUTH_ISSUER;
  if (issuer && payload.iss !== issuer) throw new Error('AUTH_ISSUER_MISMATCH');

  const audience = process.env.NEXAFORGE_AUTH_AUDIENCE;
  if (audience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) throw new Error('AUTH_AUDIENCE_MISMATCH');
  }

  return {
    userId: payload.sub,
    workspaceId: typeof payload.workspace_id === 'string' ? payload.workspace_id : undefined
  };
}
