import { describe, expect, it } from 'vitest';
import { checkSettings, readSettings, type ProjectSettings } from './config';

const current: ProjectSettings = { minCents: 200, maxCents: 2500, defaultCents: 500, appealDays: 7, payoutReceiver: null, trustEarned: true };

describe('readSettings', () => {
  it('applies valid settings', () => {
    expect(readSettings('{"min_cents":300,"max_cents":1000,"default_cents":400,"appeal_days":1,"payout_receiver":"a@example.com"}', current)).toEqual({
      minCents: 300,
      maxCents: 1000,
      defaultCents: 400,
      appealDays: 1,
      payoutReceiver: 'a@example.com',
      trustEarned: true,
    });
  });

  it('keeps what a partial file leaves out', () => {
    expect(readSettings('{"appeal_days":3}', current)).toEqual({ ...current, appealDays: 3 });
  });

  it.each([
    ['no file', null],
    ['broken JSON', '{'],
    ['an unknown key', '{"waive":true}'],
    ['a maximum over the cap', '{"max_cents":999999}'],
    ['a minimum under a dollar', '{"min_cents":1}'],
    ['a default outside the bounds', '{"default_cents":5000}'],
    ['a zero-day appeal', '{"appeal_days":0}'],
    ['a bad receiver', '{"payout_receiver":"not an email"}'],
  ])('ignores %s', (_name, text) => {
    expect(readSettings(text, current)).toEqual(current);
  });

  it('lets a project turn earned trust off', () => {
    expect(readSettings('{"trust_earned_elsewhere":false}', current).trustEarned).toBe(false);
  });
});

describe('checkSettings', () => {
  it('says nothing is wrong with a valid file', () => {
    expect(checkSettings('{"min_cents":300,"default_cents":400,"max_cents":1000}', current)).toEqual({ settings: { ...current, minCents: 300, defaultCents: 400, maxCents: 1000 }, problems: [] });
  });

  it.each([
    ['broken JSON', '{', 'not valid JSON'],
    ['an unknown key', '{"waive":true}', 'Unknown setting: waive'],
    ['a maximum over the cap', '{"max_cents":999999}', 'at most 10000'],
    ['a zero-day appeal', '{"appeal_days":0}', 'from 1 to 14'],
    ['a default outside the bounds', '{"default_cents":5000}', 'minimum, default, maximum'],
  ])('names the problem with %s, and keeps the current settings', (_name, text, problem) => {
    const checked = checkSettings(text, current);
    expect(checked.settings).toEqual(current);
    expect(checked.problems.join(' ')).toContain(problem);
  });
});
