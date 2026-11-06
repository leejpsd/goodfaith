import { describe, expect, it } from 'vitest';
import { chooseDoor } from './gate';

const base = { isBot: false, association: 'NONE', listStatus: 'unknown' } as const;

describe('chooseDoor', () => {
  it('offers a newcomer the choice', () => {
    expect(chooseDoor(base).door).toBe('choose');
    expect(chooseDoor({ ...base, association: 'FIRST_TIME_CONTRIBUTOR' }).door).toBe('choose');
    expect(chooseDoor({ ...base, association: 'FIRST_TIMER' }).door).toBe('choose');
  });

  it('lets bots and people with history straight in', () => {
    expect(chooseDoor({ ...base, isBot: true }).door).toBe('known');
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] as const) {
      expect(chooseDoor({ ...base, association }).door).toBe('known');
    }
  });

  it('honors the vouch list', () => {
    expect(chooseDoor({ ...base, listStatus: 'vouched' })).toEqual({ door: 'known', reason: 'on_vouch_list' });
  });

  it('offers a denounced user no hold', () => {
    expect(chooseDoor({ ...base, listStatus: 'denounced' })).toEqual({ door: 'closed', reason: 'denounced' });
  });

  it('lets in an author whose gated pull request was merged elsewhere, unless denounced', () => {
    expect(chooseDoor({ ...base, earned: true })).toEqual({ door: 'known', reason: 'earned' });
    expect(chooseDoor({ ...base, earned: true, listStatus: 'denounced' }).door).toBe('closed');
  });
});
