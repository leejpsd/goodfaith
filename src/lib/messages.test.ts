import { describe, expect, it } from 'vitest';
import { closedDoorComment, disputeOpenedComment, gateComment } from './messages';

describe('gateComment', () => {
  const text = gateComment({ login: 'new-person', holdUrl: 'https://x/hold/1', minCents: 200, maxCents: 2500 });

  it('says a hold is sandbox money on a project outside the demo, and only there', () => {
    expect(gateComment({ login: 'new-person', holdUrl: 'https://x/hold/1', minCents: 200, maxCents: 2500, sandbox: true })).toContain('PayPal sandbox account');
    expect(text).not.toContain('sandbox');
  });

  it('offers the free vouch before any money', () => {
    expect(text.indexOf('vouch')).toBeGreaterThan(-1);
    expect(text.indexOf('vouch')).toBeLessThan(text.indexOf('hold'));
    expect(text.indexOf('vouch')).toBeLessThan(text.indexOf('$'));
    expect(text).toContain('free');
  });

  it('says a hold is not a charge and how it comes back', () => {
    expect(text).toContain('not a charge');
    expect(text).toContain('merged or not');
    expect(text).toContain('Only a maintainer');
    expect(text).toContain('appeal');
  });

  it('shows the bounds and the link', () => {
    expect(text).toContain('$2.00 to $25.00');
    expect(text).toContain('https://x/hold/1');
  });
});

describe('closedDoorComment', () => {
  it('offers no way to pay around a ban', () => {
    const text = closedDoorComment('someone');
    expect(text).toContain('A hold cannot change that');
    expect(text).not.toContain('$');
  });
});

describe('disputeOpenedComment', () => {
  it('says the payout stopped only when it had not gone out', () => {
    expect(disputeOpenedComment(2500, false)).toContain('is stopped');
    expect(disputeOpenedComment(2500, true)).not.toContain('is stopped');
    expect(disputeOpenedComment(2500, true)).toContain('operator bears the result');
  });
});
