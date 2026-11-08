import { describe, expect, it } from 'vitest';
import { applyConfirmed, decide, dueEffects, fromPayPalValue, holdCents, toPayPalValue, voidDeadline, type Decision, type Hold } from './hold';

const DAY = 864e5;
const start = new Date('2026-11-05T00:00:00Z');
const day = (n: number) => new Date(start.getTime() + n * DAY);
const held: Hold = { state: 'held', authorizedAt: start, reauthorized: false };

function ok(decision: Decision | null) {
  if (!decision || 'refused' in decision) throw new Error(`expected a decision, got ${JSON.stringify(decision)}`);
  return decision;
}

describe('releases', () => {
  it('voids on a good-faith review, merged or not', () => {
    const d = ok(decide(held, { type: 'good_faith_review' }));
    expect(d.next.state).toBe('voided');
    expect(d.effects).toEqual(['void']);
  });

  it('voids when a vouch arrives after a hold', () => {
    expect(ok(decide(held, { type: 'vouched' })).effects).toEqual(['void']);
  });

  it('does not let an ordinary review undo a pending forfeit', () => {
    const pending = ok(decide(held, { type: 'forfeit', at: day(1), windowDays: 7 })).next;
    expect(decide(pending, { type: 'good_faith_review' })).toHaveProperty('refused');
    expect(ok(decide(pending, { type: 'release' })).next.state).toBe('voided');
  });
});

describe('forfeit', () => {
  it('opens a window and moves no money yet', () => {
    const d = ok(decide(held, { type: 'forfeit', at: day(1), windowDays: 7 }));
    expect(d.next.state).toBe('forfeit_pending');
    expect(d.next.appealEndsAt).toEqual(day(8));
    expect(d.effects).toEqual([]);
  });

  it('shortens the window so capture lands before the void deadline', () => {
    const d = ok(decide(held, { type: 'forfeit', at: day(25), windowDays: 7 }));
    expect(d.next.appealEndsAt).toEqual(voidDeadline(held));
  });

  it('refuses a forfeit with under a day left to appeal', () => {
    expect(decide(held, { type: 'forfeit', at: new Date(voidDeadline(held).getTime() - DAY + 1), windowDays: 7 })).toHaveProperty('refused');
  });

  it('cannot be repeated', () => {
    const pending = ok(decide(held, { type: 'forfeit', at: day(1), windowDays: 7 })).next;
    expect(decide(pending, { type: 'forfeit', at: day(2), windowDays: 7 })).toHaveProperty('refused');
  });
});

describe('appeal', () => {
  const pending = ok(decide(held, { type: 'forfeit', at: day(1), windowDays: 7 })).next;

  it('stops the clock until a maintainer answers', () => {
    const appealed = ok(decide(pending, { type: 'appeal' })).next;
    expect(appealed.state).toBe('appealed');
    expect(dueEffects(appealed, day(10))).toBeNull();
  });

  it('lets a maintainer release or uphold', () => {
    const appealed = ok(decide(pending, { type: 'appeal' })).next;
    expect(ok(decide(appealed, { type: 'release' })).next.state).toBe('voided');
    const upheld = ok(decide(appealed, { type: 'uphold', at: day(3), windowDays: 7 })).next;
    expect(upheld.state).toBe('forfeit_pending');
    expect(ok(dueEffects(upheld, day(3))).effects).toEqual(['capture']);
  });

  it('is only open during the window', () => {
    expect(decide(held, { type: 'appeal' })).toHaveProperty('refused');
  });
});

describe('the clock', () => {
  it('does nothing to a fresh hold', () => {
    expect(dueEffects(held, day(1))).toBeNull();
  });

  it('never captures without a maintainer forfeit', () => {
    for (let n = 0; n <= 29; n++) {
      const due = dueEffects(held, day(n));
      expect(due === null || !('refused' in due) && !due.effects.includes('capture')).toBe(true);
    }
  });

  it('voids an untouched hold before expiry', () => {
    expect(dueEffects(held, day(27))).toBeNull();
    const d = ok(dueEffects(held, day(28)));
    expect(d.next.state).toBe('voided');
    expect(d.effects).toEqual(['void']);
  });

  it('voids an unanswered appeal rather than capturing it', () => {
    const appealed = ok(decide(ok(decide(held, { type: 'forfeit', at: day(1), windowDays: 7 })).next, { type: 'appeal' })).next;
    expect(ok(dueEffects(appealed, day(28))).effects).toEqual(['void']);
  });

  it('captures when the window ends, inside the honor period', () => {
    const pending = ok(decide(held, { type: 'forfeit', at: day(0), windowDays: 2 })).next;
    expect(dueEffects(pending, day(1))).toBeNull();
    expect(ok(dueEffects(pending, day(2))).effects).toEqual(['capture']);
  });

  it('reauthorizes first once the hold is old enough', () => {
    const pending = ok(decide(held, { type: 'forfeit', at: day(1), windowDays: 7 })).next;
    const d = ok(dueEffects(pending, day(8)));
    expect(d.effects).toEqual(['reauthorize', 'capture']);
    expect(d.next.reauthorized).toBe(true);
    const again = { ...pending, reauthorized: true };
    expect(ok(dueEffects(again, day(8))).effects).toEqual(['capture']);
  });

  it('captures a forfeit on the deadline rather than voiding it', () => {
    const pending = ok(decide(held, { type: 'forfeit', at: day(25), windowDays: 7 })).next;
    expect(ok(dueEffects(pending, voidDeadline(held))).next.state).toBe('captured');
  });
});

describe('reversal', () => {
  it('refunds only a captured hold', () => {
    const captured: Hold = { ...held, state: 'captured' };
    expect(ok(decide(captured, { type: 'reverse' })).effects).toEqual(['refund']);
    expect(decide(held, { type: 'reverse' })).toHaveProperty('refused');
  });
});

describe('applyConfirmed', () => {
  it('follows a refund made in the PayPal dashboard', () => {
    expect(applyConfirmed({ ...held, state: 'captured' }, 'refunded').state).toBe('refunded');
  });

  it('is safe to repeat', () => {
    const voided = applyConfirmed(held, 'voided');
    expect(applyConfirmed(voided, 'voided')).toEqual(voided);
  });

  it('ignores a late webhook that contradicts a later state', () => {
    const refunded: Hold = { ...held, state: 'refunded' };
    expect(applyConfirmed(refunded, 'captured').state).toBe('refunded');
    expect(applyConfirmed(held, 'refunded').state).toBe('held');
  });
});

describe('holdCents', () => {
  const bounds = { minCents: 200, maxCents: 2500, defaultCents: 500 };

  it('clamps the model to the bounds', () => {
    expect(holdCents(100000, bounds)).toBe(2500);
    expect(holdCents(0, bounds)).toBe(200);
    expect(holdCents(-500, bounds)).toBe(200);
    expect(holdCents(1200, bounds)).toBe(1200);
  });

  it('falls back to the default when the model fails', () => {
    expect(holdCents(null, bounds)).toBe(500);
    expect(holdCents(Number.NaN, bounds)).toBe(500);
  });

  it('rounds to whole dollars', () => {
    expect(holdCents(749, bounds)).toBe(700);
    expect(holdCents(750, bounds)).toBe(800);
  });

  it('formats for PayPal', () => {
    expect(toPayPalValue(500)).toBe('5.00');
  });

  it('reads PayPal amounts, and nothing it cannot read exactly', () => {
    expect(fromPayPalValue('23.78')).toBe(2378);
    expect(fromPayPalValue('0.30')).toBe(30);
    expect(fromPayPalValue('23.7')).toBeUndefined();
    expect(fromPayPalValue(undefined)).toBeUndefined();
  });
});
