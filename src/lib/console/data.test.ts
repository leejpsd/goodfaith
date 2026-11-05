import { describe, expect, it } from 'vitest';
import { entryLabel, holdDates, HOLD_RULES, moneyEventLabel, toHoldRow } from './data';

describe('holdDates', () => {
  it('follows the money rules', () => {
    const dates = holdDates(new Date('2026-11-01T00:00:00.000Z'));
    expect(dates.honorEndsAt).toBe('2026-11-04T00:00:00.000Z');
    expect(dates.releaseBy).toBe('2026-11-29T00:00:00.000Z');
  });
});

describe('toHoldRow', () => {
  it('skips a hold that was never approved', () => {
    expect(toHoldRow({ state: 'awaiting_approval', cents: 500, authorizedAt: null, appealEndsAt: null, capturedAt: null }, 1)).toBeNull();
  });

  it('reports dollars and dates', () => {
    const row = toHoldRow({ state: 'held', cents: 2500, authorizedAt: new Date('2026-11-01T00:00:00.000Z'), appealEndsAt: null, capturedAt: null }, 7);
    expect(row).toMatchObject({ pr: 7, amount: 25, state: 'In place', open: 1, appealEndsAt: null, placed: '2026-11-01 00:00 UTC', appealEnds: 'none', releaseBy: '2026-11-29 00:00 UTC' });
  });
});

describe('HOLD_RULES', () => {
  it('states that no model can start a capture', () => {
    expect(HOLD_RULES).toContain('No timer and no model can start one');
  });
});

describe('entryLabel', () => {
  it('says how the author got in', () => {
    expect(entryLabel({ door: 'known', status: 'in_review', held: false })).toBe('Known contributor');
    expect(entryLabel({ door: 'closed', status: 'blocked', held: false })).toBe('Denounced');
    expect(entryLabel({ door: 'choose', status: 'in_review', held: true })).toBe('Refundable hold');
    expect(entryLabel({ door: 'choose', status: 'in_review', held: false })).toBe('Free vouch');
    expect(entryLabel({ door: 'choose', status: 'waiting', held: false })).toBe('Not yet');
  });
});

describe('moneyEventLabel', () => {
  it('counts only events that reserve or move money', () => {
    expect(moneyEventLabel('captured')).toBe('Captured');
    expect(moneyEventLabel('forfeit_opened')).toBeNull();
    expect(moneyEventLabel('appealed')).toBeNull();
    expect(moneyEventLabel('vouched')).toBeNull();
  });
});
