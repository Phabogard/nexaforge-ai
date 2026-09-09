import { createHmac, timingSafeEqual } from 'node:crypto';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type AuthUser = { id: string; email: string; role: Role };

const secret = () => process.env.JWT_SECRET ?? (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret-change-me');
const b64 = (value: string) => Buffer.from(value).toString('base64url');
const unb64 = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

export function signToken(user: AuthUser, ttlSeconds = 60 * 60 * 8): string {
  const key = secret();
  if (!key) throw new Error('JWT_SECRET_REQUIRED');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64(JSON.stringify({ sub: user.id, email: user.email, role: user.role, iat: now, exp: now + ttlSeconds }));
  const input = `${header}.${payload}`;
  return `${input}.${b64(createHmac('sha256', key).update(input).digest())}`;
}

export function verifyToken(token: string): AuthUser {
  const key = secret();
  if (!key) throw new Error('JWT_SECRET_REQUIRED');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('INVALID_TOKEN');
  const [header, payload, signature] = parts;
  const parsedHeader = JSON.parse(unb64(header)) as { alg?: string; typ?: string };
  if (parsedHeader.alg !== 'HS256' || parsedHeader.typ !== 'JWT') throw new Error('INVALID_TOKEN');
  const expected = createHmac('sha256', key).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('INVALID_TOKEN');
  const parsed = JSON.parse(unb64(payload)) as Partial<AuthUser> & { exp?: number; sub?: string };
  if (!parsed.sub || !parsed.email || !parsed.role || !parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000)) throw new Error('TOKEN_EXPIRED');
  if (!['owner', 'admin', 'member', 'viewer'].includes(parsed.role)) throw new Error('INVALID_ROLE');
  return { id: parsed.sub, email: parsed.email, role: parsed.role as Role };
}

export function extractBearer(value: string | undefined): string | null {
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice(7).trim() || null;
}

export function can(role: Role, required: Role): boolean {
  const rank: Record<Role, number> = { viewer: 10, member: 20, admin: 30, owner: 40 };
  return rank[role] >= rank[required];
}
