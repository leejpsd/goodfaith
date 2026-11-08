import { AUTHORIZATION_DAYS, HONOR_DAYS, PAYOUT_AFTER_DAYS, VOID_BEFORE_EXPIRY_DAYS } from '@/lib/hold';

const DAY = 864e5;

// Several projects share the console, so a number alone names more than one pull request.
export const prRef = (repo: string, number: number) => `${repo}#${number}`;

export interface PullRow {
  pr: string;
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
  pr: string;
  url: string;
  state: string;
  // The AI band of the hold's pull request, so a chart of amounts by band needs no join.
  band: string;
  // 1 while the hold is still reserved at PayPal, so a sum counts the open ones.
  open: number;
  amount: number;
  // The same idea in dollars, and 1 for a hold that went back in full, so tiles can sum them.
  heldNow: number;
  returned: number;
  // Exact times, which the timeline widget reads.
  placedAt: string;
  appealEndsAt: string | null;
  capturedAt: string | null;
  // When it stopped being reserved, so the timeline can draw how long it really was.
  endedAt: string | null;
  // The same dates for reading in a table, in one format whatever the viewer's locale.
  placed: string;
  honorEnds: string;
  appealEnds: string;
  captured: string;
  releaseBy: string;
}

export interface LedgerRow {
  pr: string;
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

// One row for each pull request a maintainer has to act on, or has a deadline coming.
export interface QueueRow {
  pr: string;
  title: string;
  url: string;
  // Lower comes first: an appeal blocks money, and a reversible capture has a deadline.
  rank: number;
  // When the deadline falls, for ordering within a rank. Waiting on a person sorts first.
  dueAt: number;
  need: string;
  detail: string;
  due: string;
  amount: number;
  band: string;
  brief: string;
  flagged: string;
}

export interface ConsoleData {
  queue: QueueRow[];
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

export function toHoldRow(hold: { state: string; cents: number; authorizedAt: Date | null; appealEndsAt: Date | null; capturedAt: Date | null; updatedAt: Date }, pr: string, url = '', band = 'none'): HoldRow | null {
  if (!hold.authorizedAt) return null;
  const { honorEndsAt, releaseBy } = holdDates(hold.authorizedAt);
  return {
    pr,
    url,
    state: holdStateLabel(hold.state),
    band: bandLabel(band),
    open: ['held', 'forfeit_pending', 'appealed'].includes(hold.state) ? 1 : 0,
    amount: hold.cents / 100,
    heldNow: ['held', 'forfeit_pending', 'appealed'].includes(hold.state) ? hold.cents / 100 : 0,
    returned: ['voided', 'refunded'].includes(hold.state) ? 1 : 0,
    placedAt: hold.authorizedAt.toISOString(),
    appealEndsAt: iso(hold.appealEndsAt),
    capturedAt: iso(hold.capturedAt),
    endedAt: ['captured', 'paid_out', 'voided', 'refunded'].includes(hold.state) ? iso(hold.updatedAt) : null,
    placed: readable(hold.authorizedAt),
    honorEnds: readable(honorEndsAt),
    appealEnds: readable(hold.appealEndsAt),
    captured: readable(hold.capturedAt),
    releaseBy: readable(releaseBy),
  };
}

type QueuePull = { number: number; title: string; htmlUrl: string; status: string; triage: { band: string; reviewer_brief: string; instructions_to_ai: string | null } | null };
type QueueHold = { state: string; cents: number; authorizedAt: Date | null; appealEndsAt: Date | null; capturedAt: Date | null };

// What each open state asks of a maintainer, in plain words. Ended holds ask nothing.
export function toQueueRow(pr: QueuePull, hold: QueueHold | null, ref: string): QueueRow | null {
  const base = {
    pr: ref,
    title: pr.title,
    url: pr.htmlUrl,
    amount: hold?.authorizedAt ? hold.cents / 100 : 0,
    band: bandLabel(pr.triage?.band ?? 'none'),
    brief: pr.triage?.reviewer_brief ?? 'No AI brief.',
    flagged: pr.triage?.instructions_to_ai ? `Flagged: it addresses AI reviewers, "${pr.triage.instructions_to_ai}"` : '',
  };
  const state = hold?.authorizedAt ? hold.state : null;
  if (state === 'appealed') return { ...base, rank: 0, need: 'Appeal needs an answer', detail: 'Nothing can be captured until you comment !release or !uphold.', due: 'Waiting on you', dueAt: 0 };
  if (state === 'captured' && hold?.capturedAt) {
    const reversibleUntil = new Date(hold.capturedAt.getTime() + PAYOUT_AFTER_DAYS * DAY);
    return { ...base, rank: 1, dueAt: reversibleUntil.getTime(), need: 'Captured, still reversible', detail: 'Comment !reverse to refund it in full. After this date it is paid out, and a payout is final.', due: `Reversible until ${readable(reversibleUntil)}` };
  }
  if (state === 'forfeit_pending') return { ...base, rank: 2, dueAt: hold?.appealEndsAt?.getTime() ?? 0, need: 'Your forfeit, appeal window open', detail: 'Your !forfeit asked for this capture. It goes to PayPal when the window ends, unless the author appeals or you comment !release.', due: `Captures at ${readable(hold?.appealEndsAt)}, unless appealed or released` };
  if (state === 'held' && pr.status === 'in_review' && hold?.authorizedAt) {
    return { ...base, rank: 3, dueAt: Date.parse(holdDates(hold.authorizedAt).releaseBy), need: 'Hold in place, waiting for a review', detail: 'Any review by a maintainer releases all of it, merged or not.', due: `Released by ${readable(holdDates(hold.authorizedAt).releaseBy)}` };
  }
  if (pr.status === 'waiting') return { ...base, rank: 4, dueAt: Number.MAX_SAFE_INTEGER, need: 'Waiting at the gate', detail: 'Comment !vouch to let them in free, or leave it for them to place a hold.', due: 'No deadline' };
  return null;
}

// What a maintainer can ask the agent about. The agent reads these rules and cannot change them.
export const HOLD_RULES = [
  `A hold is a PayPal authorization, not a charge. It is released by a maintainer's review, a merge, a close, a !release or a later !vouch.`,
  `Only a maintainer's !forfeit, with a public reason, can lead to a capture. No timer and no model can start one.`,
  `After a forfeit the author can !appeal until the window closes. An appeal blocks the capture until a maintainer answers with !release or !uphold.`,
  `A capture can be reversed with !reverse for one day. After that it is paid out to the project, and a payout is final.`,
  `A newcomer whose pull request went through Goodfaith at another project and was merged gets the free door, unless this project sets trust_earned_elsewhere to false.`,
  `A hold nobody acts on is released after ${AUTHORIZATION_DAYS - VOID_BEFORE_EXPIRY_DAYS} days. Timeouts never forfeit.`,
  `PayPal's honor period is ${HONOR_DAYS} days. A capture after it reauthorizes first.`,
  `The AI picks a band, and code maps it to the project's minimum, default or maximum amount. It has no way to forfeit, vouch, close or change a bound.`,
].join('\n');
