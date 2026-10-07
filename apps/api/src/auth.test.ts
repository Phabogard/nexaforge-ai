import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyBearerToken } from './auth.js';

function token(secret: string, payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(header+'.'+body).digest('base64url');
  return header+'.'+body+'.'+signature;
}
afterEach(() => { delete process.env.NEXAFORGE_AUTH_JWT_SECRET; delete process.env.NEXAFORGE_AUTH_JWKS_URL; });

describe('bearer identity verification', () => {
  it('accepts valid HS256 token', async () => {
    process.env.NEXAFORGE_AUTH_JWT_SECRET='test-secret';
    const jwt=token('test-secret',{sub:'user-1',email:'user@example.com',exp:Math.floor(Date.now()/1000)+300});
    await expect(verifyBearerToken('Bearer '+jwt)).resolves.toEqual({userId:'user-1',email:'user@example.com'});
  });
  it('rejects expired token', async () => {
    process.env.NEXAFORGE_AUTH_JWT_SECRET='test-secret';
    const jwt=token('test-secret',{sub:'user-1',exp:Math.floor(Date.now()/1000)-1});
    await expect(verifyBearerToken('Bearer '+jwt)).rejects.toThrow('AUTH_TOKEN_EXPIRED');
  });
  it('rejects future nbf', async () => {
    process.env.NEXAFORGE_AUTH_JWT_SECRET='test-secret';
    const jwt=token('test-secret',{sub:'user-1',exp:Math.floor(Date.now()/1000)+300,nbf:Math.floor(Date.now()/1000)+60});
    await expect(verifyBearerToken('Bearer '+jwt)).rejects.toThrow('AUTH_TOKEN_NOT_YET_VALID');
  });
  it('requires a signing key id for RS256', async () => {
    process.env.NEXAFORGE_AUTH_JWKS_URL='https://example.invalid/jwks.json';
    const header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
    const body=Buffer.from(JSON.stringify({sub:'user-1',exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
    await expect(verifyBearerToken('Bearer '+header+'.'+body+'.signature')).rejects.toThrow('AUTH_KEY_ID_REQUIRED');
  });
});
