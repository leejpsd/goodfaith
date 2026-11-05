import { describe, expect, it } from 'vitest';
import { fromThisSite } from './same-origin';

const request = (headers: Record<string, string>) => new Request('https://goodfaith.onrender.com/api/try', { method: 'POST', headers });

describe('fromThisSite', () => {
  it('accepts the site itself', () => {
    expect(fromThisSite(request({ origin: 'https://goodfaith.onrender.com', host: 'goodfaith.onrender.com' }))).toBe(true);
    expect(fromThisSite(request({ origin: 'https://goodfaith.onrender.com', 'x-forwarded-host': 'goodfaith.onrender.com', host: 'internal:10000' }))).toBe(true);
  });

  it('refuses another site, a bare script and a bad header', () => {
    expect(fromThisSite(request({ origin: 'https://evil.example', host: 'goodfaith.onrender.com' }))).toBe(false);
    expect(fromThisSite(request({ host: 'goodfaith.onrender.com' }))).toBe(false);
    expect(fromThisSite(request({ origin: 'not a url', host: 'goodfaith.onrender.com' }))).toBe(false);
  });
});
