import { describe, expect, it } from 'vitest';
import { holdDates, HOLD_RULES, toHoldRow } from './data';

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
    expect(row).toMatchObject({ pr: 7, amount: 25, state: 'held', appealEndsAt: null });
  });
});

describe('HOLD_RULES', () => {
  it('states that no model can start a capture', () => {
    expect(HOLD_RULES).toContain('No timer and no model can start one');
  });
});
