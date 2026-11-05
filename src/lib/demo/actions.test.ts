import { describe, expect, it } from 'vitest';
import { availableActions } from './actions';

describe('availableActions', () => {
  it('offers the vouch while waiting, even with an unfinished hold', () => {
    expect(availableActions('waiting', null)).toEqual(['vouch']);
    expect(availableActions('waiting', 'awaiting_approval')).toEqual(['vouch']);
  });

  it('follows the hold through its states', () => {
    expect(availableActions('in_review', 'held')).toEqual(['review', 'forfeit']);
    expect(availableActions('in_review', 'forfeit_pending')).toEqual(['appeal', 'release']);
    expect(availableActions('in_review', 'appealed')).toEqual(['uphold', 'release']);
    expect(availableActions('in_review', 'captured')).toEqual(['reverse']);
  });

  it('keeps offering the appeal after a forfeit closed the pull request', () => {
    expect(availableActions('closed', 'forfeit_pending')).toEqual(['appeal', 'release']);
    expect(availableActions('closed', 'appealed')).toEqual(['uphold', 'release']);
    expect(availableActions('closed', 'captured')).toEqual(['reverse']);
  });

  it('offers nothing at the end', () => {
    for (const state of ['voided', 'refunded', 'paid_out'] as const) expect(availableActions('in_review', state)).toEqual([]);
    expect(availableActions('in_review', null)).toEqual([]);
    expect(availableActions('closed', 'held')).toEqual([]);
    expect(availableActions('blocked', null)).toEqual([]);
  });
});
