import { describe, expect, it } from 'vitest';
import { ledgerNote, PAYOUT_NOTE, webhookLabel } from './ledger-labels';

describe('ledger labels', () => {
  it('says a vouch or a forfeit has no PayPal event, instead of "not yet"', () => {
    expect(webhookLabel('vouched', false)).toBe('no PayPal event');
    expect(webhookLabel('forfeit_opened', false)).toBe('no PayPal event');
    expect(webhookLabel('captured', false)).toBe('not yet');
    expect(webhookLabel('captured', true)).toBe('confirmed');
  });

  it('never shows the payout address, even on rows that stored it', () => {
    expect(ledgerNote('paid_out', 'owner@example.com')).toBe(PAYOUT_NOTE);
    expect(ledgerNote('captured', 'A rename with no problem stated.')).toBe('A rename with no problem stated.');
    expect(ledgerNote('voided', null)).toBe('none');
  });
});
