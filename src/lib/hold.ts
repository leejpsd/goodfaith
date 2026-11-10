// The hold's rules, with no I/O. A caller runs the returned effects against PayPal, then
// stores `next` only if they succeed. Only a maintainer's command can lead to a capture:
// no timer and no model can start one.
const DAY = 864e5;

export const HONOR_DAYS = 3;
export const AUTHORIZATION_DAYS = 29;
// PayPal's guides suggest day 4. Before it, the capture uses the original authorization, which
// the sandbox completed at 3.33 days (docs/hold-lifecycle.md).
export const REAUTHORIZE_FROM_DAYS = 4;
// A hold is voided a full day before PayPal would expire it, so it never lapses unnoticed.
export const VOID_BEFORE_EXPIRY_DAYS = 1;
// With less than this left before that point, a forfeit is refused and the hold just voids.
export const MIN_APPEAL_MS = DAY;
// A capture stays reversible this long. After that it is paid out, and a payout is final.
export const PAYOUT_AFTER_DAYS = 1;

export type HoldState = 'held' | 'forfeit_pending' | 'appealed' | 'captured' | 'paid_out' | 'voided' | 'refunded';
export type Effect = 'void' | 'reauthorize' | 'capture' | 'refund' | 'payout';

export interface Hold {
  state: HoldState;
  authorizedAt: Date;
  reauthorized: boolean;
  appealEndsAt?: Date;
  capturedAt?: Date;
}

export type HoldEvent =
  | { type: 'good_faith_review' }
  | { type: 'vouched' }
  | { type: 'release' }
  | { type: 'forfeit'; at: Date; windowDays: number }
  | { type: 'appeal' }
  | { type: 'uphold'; at: Date; windowDays: number }
  | { type: 'reverse' };

export type Decision = { next: Hold; effects: Effect[] } | { refused: string };

export function voidDeadline(hold: Pick<Hold, 'authorizedAt'>): Date {
  return new Date(hold.authorizedAt.getTime() + (AUTHORIZATION_DAYS - VOID_BEFORE_EXPIRY_DAYS) * DAY);
}

function appealEnd(hold: Hold, at: Date, windowDays: number): Date | null {
  const deadline = voidDeadline(hold).getTime();
  if (deadline - at.getTime() < MIN_APPEAL_MS) return null;
  return new Date(Math.min(at.getTime() + windowDays * DAY, deadline));
}

export function decide(hold: Hold, event: HoldEvent): Decision {
  const release = (): Decision => ({ next: { ...hold, state: 'voided', appealEndsAt: undefined }, effects: ['void'] });
  const open = hold.state === 'held' || hold.state === 'forfeit_pending' || hold.state === 'appealed';

  switch (event.type) {
    case 'good_faith_review':
      // A review after a forfeit does not undo it. That takes an explicit release.
      return hold.state === 'held' ? release() : { refused: `no release from ${hold.state}` };
    case 'vouched':
    case 'release':
      return open ? release() : { refused: `no release from ${hold.state}` };
    case 'forfeit': {
      if (hold.state !== 'held') return { refused: `no forfeit from ${hold.state}` };
      const ends = appealEnd(hold, event.at, event.windowDays);
      if (!ends) return { refused: 'too close to the void deadline for an appeal window' };
      return { next: { ...hold, state: 'forfeit_pending', appealEndsAt: ends }, effects: [] };
    }
    case 'appeal':
      return hold.state === 'forfeit_pending'
        ? { next: { ...hold, state: 'appealed' }, effects: [] }
        : { refused: `no appeal from ${hold.state}` };
    case 'uphold': {
      if (hold.state !== 'appealed') return { refused: `no uphold from ${hold.state}` };
      // The maintainer has answered the appeal, so the rest of the window is not owed again.
      const ends = appealEnd(hold, event.at, 0);
      if (!ends) return { refused: 'too close to the void deadline to capture' };
      return { next: { ...hold, state: 'forfeit_pending', appealEndsAt: ends }, effects: [] };
    }
    case 'reverse':
      return hold.state === 'captured'
        ? { next: { ...hold, state: 'refunded' }, effects: ['refund'] }
        : { refused: `no reversal from ${hold.state}` };
  }
}

// What the clock requires now. Run on a schedule, so it must be safe to repeat.
export function dueEffects(hold: Hold, now: Date): Decision | null {
  if (hold.state === 'captured' && hold.capturedAt && now.getTime() - hold.capturedAt.getTime() >= PAYOUT_AFTER_DAYS * DAY) {
    return { next: { ...hold, state: 'paid_out' }, effects: ['payout'] };
  }
  if (hold.state === 'forfeit_pending' && hold.appealEndsAt && now >= hold.appealEndsAt) {
    const age = now.getTime() - hold.authorizedAt.getTime();
    const refresh = !hold.reauthorized && age >= REAUTHORIZE_FROM_DAYS * DAY;
    return {
      next: { ...hold, state: 'captured', reauthorized: hold.reauthorized || refresh },
      effects: refresh ? ['reauthorize', 'capture'] : ['capture'],
    };
  }
  const open = hold.state === 'held' || hold.state === 'forfeit_pending' || hold.state === 'appealed';
  if (open && now >= voidDeadline(hold)) {
    return { next: { ...hold, state: 'voided', appealEndsAt: undefined }, effects: ['void'] };
  }
  return null;
}

// Applies what a verified webhook reports, which can arrive from PayPal's own dashboard.
// Repeats are harmless, and a refund overrides anything earlier.
const FINAL: Record<'voided' | 'captured' | 'refunded', readonly HoldState[]> = {
  voided: ['held', 'forfeit_pending', 'appealed', 'voided'],
  captured: ['held', 'forfeit_pending', 'appealed', 'captured'],
  refunded: ['captured', 'paid_out', 'refunded'],
};

export function applyConfirmed(hold: Hold, confirmed: keyof typeof FINAL): Hold {
  return FINAL[confirmed].includes(hold.state) ? { ...hold, state: confirmed, appealEndsAt: undefined } : hold;
}

// Code clamps the model's amount, and a model failure falls back to the project's default.
export function holdCents(
  proposed: number | null,
  bounds: { minCents: number; maxCents: number; defaultCents: number },
): number {
  const value = proposed === null || !Number.isFinite(proposed) ? bounds.defaultCents : proposed;
  return Math.min(bounds.maxCents, Math.max(bounds.minCents, Math.round(value / 100) * 100));
}

export function toPayPalValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

// PayPal writes USD amounts with two decimals. Anything else is left unread.
export function fromPayPalValue(value: string | undefined): number | undefined {
  return value && /^\d+\.\d{2}$/.test(value) ? Number(value.replace('.', '')) : undefined;
}
