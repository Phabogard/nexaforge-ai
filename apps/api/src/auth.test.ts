import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyBearerToken } from './auth.js';

function token(secret: string, payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + signature;
}

describe('bearer identity verification', () => {
  it('accepts a valid scoped identity token', () => {
    process.env.NEXAFORGE_AUTH_JWT_SECRET = 'test-secret';
    const jwt = token('test-secret', { sub:'user-1', workspace_id:'workspace-1', exp:Math.floor(Date.now()/1000)+300 });
    expect(verifyBearerToken('Bearer ' + jwt)).toEqual({ userId:'user-1', workspaceId:'workspace-1' });
  });

  it('rejects expired tokens', () => {
    process.env.NEXAFORGE_AUTH_JWT_SECRET = 'test-secret';
    const jwt = token('test-secret', { sub:'user-1', exp:Math.floor(Date.now()/1000)-1 });
    expect(() => verifyBearerToken('Bearer ' + jwt)).toThrow('AUTH_TOKEN_EXPIRED');
  });
});
