import type { LedgerKind } from '@/db/schema';
import { toPayPalValue } from '@/lib/hold';

// One set of words for the ledger, wherever it is shown.
export const LEDGER_LABEL: Record<LedgerKind, string> = {
  vouched: 'Vouched',
  held: 'Hold placed',
  voided: 'Hold released',
  forfeit_opened: 'Forfeit opened',
  appealed: 'Appealed',
  upheld: 'Appeal upheld',
  captured: 'Captured',
  paid_out: 'Paid out',
  payout_failed: 'Payout failed',
  refunded: 'Refunded',
  disputed: 'Dispute opened',
  dispute_resolved: 'Dispute resolved',
};

// These change nothing at PayPal, so no webhook will ever confirm them.
export const NO_PAYPAL_EVENT: readonly LedgerKind[] = ['vouched', 'forfeit_opened', 'appealed', 'upheld'];

// A forfeit or an appeal moves no money, so its amount is what is at stake, not what moved.
export function ledgerAmount(kind: LedgerKind, cents: number): string {
  const value = `$${toPayPalValue(cents)}`;
  return kind !== 'vouched' && NO_PAYPAL_EVENT.includes(kind) ? `${value} at stake` : value;
}

// What the webhook column says. A vouch or a forfeit has no PayPal event, so "not yet" would mislead.
export function webhookLabel(kind: LedgerKind, reconciled: boolean): string {
  if (NO_PAYPAL_EVENT.includes(kind)) return 'no PayPal event';
  return reconciled ? 'confirmed' : 'not yet';
}

// The settings file names the payout account, and the ledger points there instead of repeating
// the address. Older rows stored the address as the note, so this also covers them.
export const PAYOUT_NOTE = 'to the payout account in the project settings';

export function ledgerNote(kind: LedgerKind, note: string | null): string {
  if (kind === 'paid_out') return PAYOUT_NOTE;
  return note ?? 'none';
}
