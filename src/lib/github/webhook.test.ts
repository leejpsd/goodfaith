import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appJwt } from './client';
import { issueCommentEvent, pullRequestEvent, verifySignature } from './webhook';

describe('verifySignature', () => {
  const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts a correct signature', () => {
    expect(verifySignature('s', '{"a":1}', sign('s', '{"a":1}'))).toBe(true);
  });

  it("matches the test values in GitHub's documentation", () => {
    expect(verifySignature("It's a Secret to Everybody", 'Hello, World!', 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17')).toBe(true);
  });

  it('rejects a wrong secret, changed body, wrong length or missing header', () => {
    expect(verifySignature('s', 'body', sign('other', 'body'))).toBe(false);
    expect(verifySignature('s', 'changed', sign('s', 'body'))).toBe(false);
    expect(verifySignature('s', 'body', 'sha256=short')).toBe(false);
    expect(verifySignature('s', 'body', null)).toBe(false);
  });
});

describe('event schemas', () => {
  it('rejects a payload missing what the gate relies on', () => {
    expect(pullRequestEvent.safeParse({ action: 'opened' }).success).toBe(false);
    expect(issueCommentEvent.safeParse({ action: 'created' }).success).toBe(false);
  });
});

describe('appJwt', () => {
  it('signs a token GitHub can verify, valid for under ten minutes', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const token = appJwt('123', pem, 1_000_000);
    const [head, body, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims).toEqual({ iat: 999_940, exp: 1_000_540, iss: '123' });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    const ok = createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(signature, 'base64url'));
    expect(ok).toBe(true);
  });
});
