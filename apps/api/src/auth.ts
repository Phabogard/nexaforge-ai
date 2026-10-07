import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';

export interface AuthenticatedIdentity { userId: string; email?: string; workspaceId?: string; }
type JwtPayload = Record<string, unknown>;
type Jwk = { kid?: string; kty?: string; alg?: string; use?: string; crv?: string; x?: string; n?: string; e?: string };
let jwksCache: { expiresAt: number; keys: Jwk[] } | null = null;

function base64urlDecode(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4), 'base64').toString('utf8');
}
function base64urlBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4), 'base64');
}
async function loadJwks(url: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('AUTH_JWKS_UNAVAILABLE');
  const body = await response.json() as { keys?: Jwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('AUTH_JWKS_INVALID');
  jwksCache = { expiresAt: Date.now() + 300000, keys: body.keys };
  return body.keys;
}
async function verifyNeonJwt(h: string, p: string, s: string, header: Record<string, unknown>): Promise<JwtPayload> {
  const url = process.env.NEXAFORGE_AUTH_JWKS_URL;
  if (!url) throw new Error('AUTH_JWKS_NOT_CONFIGURED');
  const kid = typeof header.kid === 'string' ? header.kid : '';
  if (!kid) throw new Error('AUTH_KEY_ID_REQUIRED');
  const algorithm = typeof header.alg === 'string' ? header.alg : '';
  const jwk = (await loadJwks(url)).find(key => key.kid === kid);
  if (!jwk) throw new Error('AUTH_SIGNING_KEY_NOT_FOUND');

  const expectedKeyType = algorithm === 'RS256' ? 'RSA' : algorithm === 'EdDSA' ? 'OKP' : '';
  if (!expectedKeyType || jwk.kty !== expectedKeyType) throw new Error('AUTH_SIGNING_KEY_NOT_FOUND');
  if (jwk.alg && jwk.alg !== algorithm) throw new Error('AUTH_SIGNING_KEY_INVALID');
  if (algorithm === 'EdDSA' && jwk.crv !== 'Ed25519') throw new Error('AUTH_SIGNING_KEY_INVALID');

  let publicKey;
  try { publicKey = createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' }); } catch { throw new Error('AUTH_SIGNING_KEY_INVALID'); }
  if (!verifySignature(algorithm === 'EdDSA' ? null : 'RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, base64urlBuffer(s))) {
    throw new Error('INVALID_AUTH_TOKEN');
  }
  try { return JSON.parse(base64urlDecode(p)) as JwtPayload; } catch { throw new Error('INVALID_AUTH_TOKEN'); }
}
export async function verifyBearerToken(authorization: string | undefined): Promise<AuthenticatedIdentity> {
  if (!authorization?.startsWith('Bearer ')) throw new Error('AUTHENTICATION_REQUIRED');
  const parts = authorization.slice(7).trim().split('.');
  if (parts.length !== 3) throw new Error('INVALID_AUTH_TOKEN');
  const [h,p,s] = parts;
  let header: Record<string, unknown>, payload: JwtPayload;
  try { header = JSON.parse(base64urlDecode(h)); } catch { throw new Error('INVALID_AUTH_TOKEN'); }
  if (header.typ !== undefined && header.typ !== 'JWT' && header.typ !== 'at+jwt') throw new Error('UNSUPPORTED_AUTH_TOKEN');
  if (header.alg === 'HS256') {
    const secret = process.env.NEXAFORGE_AUTH_JWT_SECRET;
    if (!secret) throw new Error('AUTHENTICATION_NOT_CONFIGURED');
    const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    const a = Buffer.from(s), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a,b)) throw new Error('INVALID_AUTH_TOKEN');
    try { payload = JSON.parse(base64urlDecode(p)) as JwtPayload; } catch { throw new Error('INVALID_AUTH_TOKEN'); }
  } else if (header.alg === 'RS256' || header.alg === 'EdDSA') payload = await verifyNeonJwt(h,p,s,header);
  else throw new Error('UNSUPPORTED_AUTH_TOKEN');
  const now = Math.floor(Date.now()/1000);
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('AUTH_SUBJECT_REQUIRED');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('AUTH_TOKEN_EXPIRED');
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now)) throw new Error('AUTH_TOKEN_NOT_YET_VALID');
  const issuer = process.env.NEXAFORGE_AUTH_ISSUER;
  if (issuer && payload.iss !== issuer) throw new Error('AUTH_ISSUER_MISMATCH');
  const audience = process.env.NEXAFORGE_AUTH_AUDIENCE;
  if (audience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) throw new Error('AUTH_AUDIENCE_MISMATCH');
  }
  return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined, workspaceId: typeof payload.workspace_id === 'string' ? payload.workspace_id : undefined };
}
