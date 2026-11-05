import { and, eq, inArray, or } from 'drizzle-orm';
import { holds, ledgerEvents, projects, pullRequests, type LedgerKind } from '@/db/schema';
import type { Command } from '@/lib/commands';
import type { CheckState } from '@/lib/github/client';
import { applyConfirmed, decide, dueEffects, holdCents, type Effect, type Hold, type HoldEvent } from '@/lib/hold';
import {
  appealComment,
  capturedComment,
  captureFailedComment,
  changedOnPayPalComment,
  CHECK,
  forfeitComment,
  heldComment,
  noHoldComment,
  refundedComment,
  refusedComment,
  releasedComment,
  upheldComment,
} from '@/lib/messages';
import { PayPalError } from '@/lib/paypal/client';
import { readConfirmation, type PayPalEvent } from '@/lib/paypal/webhook';
import type { HoldDeps } from './deps';

type HoldRow = typeof holds.$inferSelect;
export interface Scope {
  pr: typeof pullRequests.$inferSelect;
  project: typeof projects.$inferSelect;
}

const OPEN = ['held', 'forfeit_pending', 'appealed'] as const;

function toHold(row: HoldRow): Hold | null {
  if (row.state === 'awaiting_approval' || !row.authorizedAt) return null;
  return { state: row.state, authorizedAt: row.authorizedAt, reauthorized: row.reauthorized, appealEndsAt: row.appealEndsAt ?? undefined };
}

async function scopeOf(deps: HoldDeps, pullRequestId: string): Promise<Scope | null> {
  const [row] = await deps.db
    .select({ pr: pullRequests, project: projects })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(eq(pullRequests.id, pullRequestId));
  return row ?? null;
}

async function holdOf(deps: HoldDeps, pullRequestId: string): Promise<HoldRow | null> {
  const [row] = await deps.db.select().from(holds).where(eq(holds.pullRequestId, pullRequestId));
  return row ?? null;
}

// The money has already moved by the time this runs, so a GitHub failure must not undo the
// record of it.
async function tell(deps: HoldDeps, { pr, project }: Scope, message: { check?: CheckState; comment?: string }) {
  const github = deps.githubFor(project.installationId);
  try {
    if (message.check && pr.checkRunId) await github.updateCheck(project.owner, project.repo, pr.checkRunId, message.check);
    if (message.comment) await github.comment(project.owner, project.repo, pr.number, message.comment);
  } catch (error) {
    console.error('GitHub notification failed', pr.id, error instanceof Error ? error.message : 'unknown error');
  }
}

async function record(deps: HoldDeps, { pr, project }: Scope, row: HoldRow, kind: LedgerKind, entry: { paypalId?: string | null; actor?: string | null; note?: string; reconciled?: boolean }) {
  await deps.db.insert(ledgerEvents).values({
    projectId: project.id,
    pullRequestId: pr.id,
    holdId: row.id,
    kind,
    cents: row.cents,
    paypalId: entry.paypalId ?? null,
    actor: entry.actor ?? null,
    note: entry.note ?? null,
    reconciledAt: entry.reconciled ? new Date() : null,
  });
}

export function holdAmount({ project }: Scope): number {
  return holdCents(null, project);
}

export type Refusal = 'not_found' | 'not_waiting' | 'stale_order' | 'declined';

export async function beginHold(deps: HoldDeps, pullRequestId: string): Promise<{ orderId: string } | { refused: Refusal }> {
  const scope = await scopeOf(deps, pullRequestId);
  if (!scope) return { refused: 'not_found' };
  if (scope.pr.door !== 'choose' || scope.pr.status !== 'waiting') return { refused: 'not_waiting' };

  const cents = holdAmount(scope);
  const page = `${deps.appUrl}/hold/${pullRequestId}`;
  const orderId = await deps.paypal.createOrder({
    cents,
    description: `Refundable hold for pull request #${scope.pr.number} on ${scope.project.owner}/${scope.project.repo}`,
    referenceId: pullRequestId,
    returnUrl: page,
    cancelUrl: page,
  });
  // An abandoned approval reuses the row. A hold that exists already is never replaced.
  const [row] = await deps.db
    .insert(holds)
    .values({ pullRequestId, state: 'awaiting_approval', cents, orderId })
    .onConflictDoUpdate({ target: holds.pullRequestId, set: { orderId, cents, updatedAt: new Date() }, where: eq(holds.state, 'awaiting_approval') })
    .returning();
  return row ? { orderId } : { refused: 'not_waiting' };
}

export async function confirmHold(deps: HoldDeps, pullRequestId: string, orderId: string): Promise<{ ok: true } | { refused: Refusal }> {
  const scope = await scopeOf(deps, pullRequestId);
  const row = await holdOf(deps, pullRequestId);
  if (!scope || !row) return { refused: 'not_found' };
  if (row.orderId !== orderId) return { refused: 'stale_order' };
  if (row.state !== 'awaiting_approval') return { ok: true };
  // A vouch or a close can arrive while the buyer is on PayPal. Nothing is held in that case.
  if (scope.pr.status !== 'waiting') return { refused: 'not_waiting' };

  let authorization;
  try {
    authorization = await deps.paypal.authorizeOrder(orderId, `hold-${row.id}-authorize-${orderId}`);
  } catch (error) {
    if (error instanceof PayPalError && !error.retryable) return { refused: 'declined' };
    throw error;
  }
  if (authorization.status === 'DENIED') return { refused: 'declined' };

  const [saved] = await deps.db
    .update(holds)
    .set({ state: 'held', authorizationId: authorization.authorizationId, authorizedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(holds.id, row.id), eq(holds.state, 'awaiting_approval')))
    .returning();
  if (!saved) return { ok: true };

  await deps.db.update(pullRequests).set({ status: 'in_review', updatedAt: new Date() }).where(eq(pullRequests.id, pullRequestId));
  await record(deps, scope, saved, 'held', { paypalId: authorization.authorizationId, actor: scope.pr.authorLogin });
  await tell(deps, scope, { check: CHECK.held, comment: heldComment(scope.pr.authorLogin, saved.cents) });
  return { ok: true };
}

async function runEffects(deps: HoldDeps, row: HoldRow, effects: Effect[]) {
  const result: { captureId?: string; refundId?: string } = {};
  let authorizationId = row.authorizationId!;
  for (const effect of effects) {
    switch (effect) {
      case 'void':
        await deps.paypal.voidAuthorization(authorizationId, `hold-${row.id}-void-${authorizationId}`);
        break;
      case 'reauthorize':
        authorizationId = await deps.paypal.reauthorize(authorizationId, row.cents, `hold-${row.id}-reauthorize`);
        // Saved at once, so a capture that fails next retries against the new authorization.
        await deps.db.update(holds).set({ authorizationId, reauthorized: true, updatedAt: new Date() }).where(eq(holds.id, row.id));
        break;
      case 'capture': {
        const capture = await deps.paypal.capture(authorizationId, row.cents, `hold-${row.id}-capture-${authorizationId}`);
        if (capture.status === 'DECLINED' || capture.status === 'FAILED') throw new PayPalError('capture', 422, capture.status, undefined);
        result.captureId = capture.captureId;
        break;
      }
      case 'refund':
        result.refundId = await deps.paypal.refund(row.captureId!, `hold-${row.id}-refund-${row.captureId}`);
        break;
    }
  }
  return result;
}

// Runs the effects, then stores the next state only if nothing else moved the hold first.
// Returns null when something did, so the caller adds no second ledger row or comment.
async function settle(deps: HoldDeps, row: HoldRow, next: Hold, effects: Effect[], extra: Partial<HoldRow> = {}): Promise<HoldRow | null> {
  const result = await runEffects(deps, row, effects);
  const [saved] = await deps.db
    .update(holds)
    .set({ state: next.state, appealEndsAt: next.appealEndsAt ?? null, reauthorized: next.reauthorized, updatedAt: new Date(), ...extra, ...result })
    .where(and(eq(holds.id, row.id), eq(holds.state, row.state)))
    .returning();
  return saved ?? null;
}

async function release(deps: HoldDeps, scope: Scope, event: HoldEvent, actor: string | null, because: string, note: string) {
  const row = await holdOf(deps, scope.pr.id);
  const hold = row && toHold(row);
  if (!row || !hold) return;
  const decision = decide(hold, event);
  if ('refused' in decision) return;
  const saved = await settle(deps, row, decision.next, decision.effects);
  if (!saved) return;
  await record(deps, scope, saved, 'voided', { paypalId: saved.authorizationId, actor, note });
  await tell(deps, scope, { check: CHECK.released, comment: releasedComment(scope.pr.authorLogin, saved.cents, because) });
}

export const releaseForReview = (deps: HoldDeps, scope: Scope, actor: string | null, because: string) =>
  release(deps, scope, { type: 'good_faith_review' }, actor, because, because);

export const releaseForVouch = (deps: HoldDeps, scope: Scope, actor: string) =>
  release(deps, scope, { type: 'vouched' }, actor, `@${actor} vouched for you`, 'vouched after the hold');

export async function onHoldCommand(deps: HoldDeps, scope: Scope, command: Exclude<Command, { name: 'vouch' | 'unvouch' }>, actor: string): Promise<void> {
  const row = await holdOf(deps, scope.pr.id);
  const hold = row && toHold(row);
  if (!row || !hold) {
    await tell(deps, scope, { comment: noHoldComment(actor) });
    return;
  }
  const at = new Date();
  const event: HoldEvent =
    command.name === 'forfeit'
      ? { type: 'forfeit', at, windowDays: scope.project.appealDays }
      : command.name === 'uphold'
        ? { type: 'uphold', at, windowDays: 0 }
        : { type: command.name };
  const decision = decide(hold, event);
  if ('refused' in decision) {
    await tell(deps, scope, { comment: refusedComment(actor, decision.refused) });
    return;
  }

  const login = scope.pr.authorLogin;
  switch (command.name) {
    case 'forfeit': {
      const saved = await settle(deps, row, decision.next, decision.effects, { forfeitedBy: actor, forfeitReason: command.reason });
      if (!saved) return;
      await record(deps, scope, saved, 'forfeit_opened', { paypalId: saved.authorizationId, actor, note: command.reason });
      await tell(deps, scope, {
        check: CHECK.forfeitPending,
        comment: forfeitComment({ login, by: actor, cents: saved.cents, reason: command.reason, appealEndsAt: saved.appealEndsAt! }),
      });
      return;
    }
    case 'appeal': {
      const saved = await settle(deps, row, decision.next, decision.effects, { appealReason: command.reason });
      if (!saved) return;
      await record(deps, scope, saved, 'appealed', { paypalId: saved.authorizationId, actor, note: command.reason });
      await tell(deps, scope, { comment: appealComment(actor) });
      return;
    }
    case 'release': {
      const saved = await settle(deps, row, decision.next, decision.effects);
      if (!saved) return;
      await record(deps, scope, saved, 'voided', { paypalId: saved.authorizationId, actor, note: 'released by a maintainer' });
      await tell(deps, scope, { check: CHECK.released, comment: releasedComment(login, saved.cents, `@${actor} released it`) });
      return;
    }
    case 'uphold': {
      const saved = await settle(deps, row, decision.next, decision.effects);
      if (!saved) return;
      await record(deps, scope, saved, 'forfeit_opened', { paypalId: saved.authorizationId, actor, note: 'appeal answered: upheld' });
      await tell(deps, scope, { comment: upheldComment(actor) });
      // The appeal window is over, so the capture does not need to wait for the clock.
      await settleDue(deps, scope, saved, new Date());
      return;
    }
    case 'reverse': {
      const saved = await settle(deps, row, decision.next, decision.effects);
      if (!saved) return;
      await record(deps, scope, saved, 'refunded', { paypalId: saved.refundId, actor, note: command.reason });
      await tell(deps, scope, { check: CHECK.refunded, comment: refundedComment(login, saved.cents) });
      return;
    }
  }
}

async function settleDue(deps: HoldDeps, scope: Scope, row: HoldRow, now: Date): Promise<void> {
  const hold = toHold(row);
  const decision = hold && dueEffects(hold, now);
  if (!decision || 'refused' in decision) return;
  const capturing = decision.effects.includes('capture');

  let saved: HoldRow | null;
  try {
    saved = await settle(deps, row, decision.next, decision.effects);
  } catch (error) {
    if (!capturing || !(error instanceof PayPalError) || error.retryable) throw error;
    // Clearing the time stops the retries. The hold stays open, and the void deadline or a
    // maintainer's release still ends it, so a refused capture never strands the money.
    await deps.db.update(holds).set({ appealEndsAt: null, updatedAt: new Date() }).where(eq(holds.id, row.id));
    await tell(deps, scope, { comment: captureFailedComment(row.cents) });
    return;
  }
  if (!saved) return;

  if (capturing) {
    await record(deps, scope, saved, 'captured', { paypalId: saved.captureId, actor: saved.forfeitedBy, note: saved.forfeitReason ?? undefined });
    await tell(deps, scope, { check: CHECK.captured, comment: capturedComment({ login: scope.pr.authorLogin, cents: saved.cents, by: saved.forfeitedBy }) });
  } else {
    const because = 'it reached the limit for how long a hold can stay open';
    await record(deps, scope, saved, 'voided', { paypalId: saved.authorizationId, note: because });
    await tell(deps, scope, { check: CHECK.released, comment: releasedComment(scope.pr.authorLogin, saved.cents, because) });
  }
}

// Run on a schedule. It only finishes what a maintainer started, or releases a hold.
export async function runDue(deps: HoldDeps, now = new Date()): Promise<void> {
  const rows = await deps.db
    .select({ hold: holds, pr: pullRequests, project: projects })
    .from(holds)
    .innerJoin(pullRequests, eq(holds.pullRequestId, pullRequests.id))
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(inArray(holds.state, [...OPEN]));
  for (const { hold, pr, project } of rows) {
    try {
      await settleDue(deps, { pr, project }, hold, now);
    } catch (error) {
      console.error('Hold run failed', hold.id, error instanceof Error ? error.message : 'unknown error');
    }
  }
}

const KIND = { voided: 'voided', captured: 'captured', refunded: 'refunded' } as const;

export async function onPayPalEvent(deps: HoldDeps, event: PayPalEvent): Promise<void> {
  const confirmation = readConfirmation(event);
  if (!confirmation) return;
  const ids = [
    'authorizationId' in confirmation && confirmation.authorizationId ? eq(holds.authorizationId, confirmation.authorizationId) : undefined,
    'captureId' in confirmation ? eq(holds.captureId, confirmation.captureId) : undefined,
  ].filter((clause) => clause !== undefined);
  if (!ids.length) return;

  const [found] = await deps.db
    .select({ hold: holds, pr: pullRequests, project: projects })
    .from(holds)
    .innerJoin(pullRequests, eq(holds.pullRequestId, pullRequests.id))
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(or(...ids));
  const hold = found && toHold(found.hold);
  if (!found || !hold) return;

  const kind = KIND[confirmation.confirmed];
  const next = applyConfirmed(hold, confirmation.confirmed);
  if (next.state === hold.state) {
    // This app's own action came back, so PayPal has now confirmed the ledger row.
    await deps.db
      .update(ledgerEvents)
      .set({ reconciledAt: new Date() })
      .where(and(eq(ledgerEvents.holdId, found.hold.id), eq(ledgerEvents.kind, kind)));
    return;
  }

  // PayPal moved the hold without this app, for example from the dashboard.
  const paypalId = confirmation.confirmed === 'voided' ? confirmation.authorizationId : confirmation.confirmed === 'captured' ? confirmation.captureId : confirmation.refundId;
  const [saved] = await deps.db
    .update(holds)
    .set({
      state: next.state,
      appealEndsAt: null,
      updatedAt: new Date(),
      ...(confirmation.confirmed === 'captured' ? { captureId: confirmation.captureId } : {}),
      ...(confirmation.confirmed === 'refunded' ? { refundId: confirmation.refundId } : {}),
    })
    .where(and(eq(holds.id, found.hold.id), eq(holds.state, found.hold.state)))
    .returning();
  if (!saved) return;
  const scope = { pr: found.pr, project: found.project };
  await record(deps, scope, saved, kind, { paypalId, actor: 'PayPal', note: 'changed outside this app', reconciled: true });
  const check = kind === 'voided' ? CHECK.released : kind === 'captured' ? CHECK.captured : CHECK.refunded;
  await tell(deps, scope, { check, comment: changedOnPayPalComment(next.state) });
}
