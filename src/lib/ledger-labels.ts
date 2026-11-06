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
