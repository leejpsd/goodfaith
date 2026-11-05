import { AUTHORIZATION_DAYS, HONOR_DAYS, VOID_BEFORE_EXPIRY_DAYS } from '@/lib/hold';

const DAY = 864e5;

export interface PullRow {
  number: number;
  title: string;
  url: string;
  status: string;
  // How the author got in, which is the whole idea of the product.
  entry: string;
  band: string;
  openedAt: string;
}

const STATUS: Record<string, string> = { waiting: 'Waiting at the gate', in_review: 'In review', blocked: 'Denounced', merged: 'Merged', closed: 'Closed' };
const BAND: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', none: 'No AI read' };

export const statusLabel = (status: string) => STATUS[status] ?? status;
export const bandLabel = (band: string) => BAND[band] ?? band;

export function entryLabel(input: { door: string; status: string; held: boolean }): string {
  if (input.door === 'known') return 'Known contributor';
  if (input.door === 'closed') return 'Denounced';
  if (input.held) return 'Refundable hold';
  return input.status === 'waiting' ? 'Not yet' : 'Free vouch';
}

const HOLD_STATE: Record<string, string> = {
  held: 'In place',
  forfeit_pending: 'Forfeit pending',
  appealed: 'Appealed',
  captured: 'Captured',
  paid_out: 'Paid out',
  voided: 'Released',
  refunded: 'Refunded',
};

export const holdStateLabel = (state: string) => HOLD_STATE[state] ?? state;

// Only these events move money or reserve it. A forfeit or an appeal moves nothing, so summing
// them with the rest would overstate what happened.
const MONEY_EVENT: Partial<Record<string, string>> = { held: 'Held', voided: 'Released', captured: 'Captured', refunded: 'Refunded', paid_out: 'Paid out' };
export const moneyEventLabel = (kind: string) => MONEY_EVENT[kind] ?? null;

export interface HoldRow {
  pr: number;
  state: string;
  // 1 while the hold is still reserved at PayPal, so a sum counts the open ones.
  open: number;
  amount: number;
  // Exact times, which the timeline widget reads.
  placedAt: string;
  appealEndsAt: string | null;
  capturedAt: string | null;
  // The same dates for reading in a table, in one format whatever the viewer's locale.
  placed: string;
  honorEnds: string;
  appealEnds: string;
  captured: string;
  releaseBy: string;
}

export interface LedgerRow {
  pr: number;
  event: string;
  amount: number;
  by: string;
  reason: string;
  paypalId: string;
  confirmed: string;
  at: string;
}

export interface MoneyRow {
  outcome: string;
  amount: number;
}

export interface ConsoleData {
  pulls: PullRow[];
  holds: HoldRow[];
  ledger: LedgerRow[];
  money: MoneyRow[];
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);
const readable = (date: Date | string | null | undefined) => (date ? `${new Date(date).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'none');

// The two dates that matter for a hold, from the same constants the money rules use.
export function holdDates(placedAt: Date) {
  return {
    honorEndsAt: new Date(placedAt.getTime() + HONOR_DAYS * DAY).toISOString(),
    releaseBy: new Date(placedAt.getTime() + (AUTHORIZATION_DAYS - VOID_BEFORE_EXPIRY_DAYS) * DAY).toISOString(),
  };
}

export function toHoldRow(hold: { state: string; cents: number; authorizedAt: Date | null; appealEndsAt: Date | null; capturedAt: Date | null }, pr: number): HoldRow | null {
  if (!hold.authorizedAt) return null;
  const { honorEndsAt, releaseBy } = holdDates(hold.authorizedAt);
  return {
    pr,
    state: holdStateLabel(hold.state),
    open: ['held', 'forfeit_pending', 'appealed'].includes(hold.state) ? 1 : 0,
    amount: hold.cents / 100,
    placedAt: hold.authorizedAt.toISOString(),
    appealEndsAt: iso(hold.appealEndsAt),
    capturedAt: iso(hold.capturedAt),
    placed: readable(hold.authorizedAt),
    honorEnds: readable(honorEndsAt),
    appealEnds: readable(hold.appealEndsAt),
    captured: readable(hold.capturedAt),
    releaseBy: readable(releaseBy),
  };
}

// What a maintainer can ask the agent about. The agent reads these rules and cannot change them.
export const HOLD_RULES = [
  `A hold is a PayPal authorization, not a charge. It is released by a maintainer's review, a merge, a close, a !release or a later !vouch.`,
  `Only a maintainer's !forfeit, with a public reason, can lead to a capture. No timer and no model can start one.`,
  `After a forfeit the author can !appeal until the window closes. An appeal blocks the capture until a maintainer answers with !release or !uphold.`,
  `A capture can be reversed with !reverse for one day. After that it is paid out to the project, and a payout is final.`,
  `A hold nobody acts on is released after ${AUTHORIZATION_DAYS - VOID_BEFORE_EXPIRY_DAYS} days. Timeouts never forfeit.`,
  `PayPal's honor period is ${HONOR_DAYS} days. A capture after it reauthorizes first.`,
  `The AI picks a band, and code maps it to the project's minimum, default or maximum amount. It has no way to forfeit, vouch, close or change a bound.`,
].join('\n');
