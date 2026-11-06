import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { holds, ledgerEvents, projects, pullRequests, type LedgerKind } from '@/db/schema';
import type { Command } from '@/lib/commands';
import type { CheckState } from '@/lib/github/client';
import { applyConfirmed, decide, dueEffects, holdCents, type Effect, type Hold, type HoldEvent } from '@/lib/hold';
import {
  appealComment,
  capturedComment,
  paidOutComment,
  payoutFailedComment,
  captureFailedComment,
  changedOnPayPalComment,
  CHECK,
  forfeitComment,
  heldComment,
  disputeOpenedComment,
  disputeResolvedComment,
  noHoldComment,
  WAITING_LABEL,
  refundedComment,
  refusedComment,
  releasedComment,
  upheldComment,
} from '@/lib/messages';
import { DEMO, FIRST_TRY_NUMBER } from '@/lib/demo/constants';
import { PayPalError } from '@/lib/paypal/client';
import { readConfirmation, readDispute, readPayout, readRefusedCapture, type PayPalEvent } from '@/lib/paypal/webhook';
import { bandCents } from '@/lib/triage/triage';
import type { HoldDeps } from './deps';

type HoldRow = typeof holds.$inferSelect;
export interface Scope {
  pr: typeof pullRequests.$inferSelect;
  project: typeof projects.$inferSelect;
}

const OPEN = ['held', 'forfeit_pending', 'appealed'] as const;

function toHold(row: HoldRow): Hold | null {
  if (row.state === 'awaiting_approval' || !row.authorizedAt) return null;
  return { state: row.state, authorizedAt: row.authorizedAt, reauthorized: row.reauthorized, appealEndsAt: row.appealEndsAt ?? undefined, capturedAt: row.capturedAt ?? undefined };
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

async function removeWaitingLabel(deps: HoldDeps, { pr, project }: Scope) {
  try {
    await deps.githubFor(project.installationId).removeLabel(project.owner, project.repo, pr.number, WAITING_LABEL);
  } catch (error) {
    console.error('Removing the waiting label failed', pr.id, error instanceof Error ? error.message : 'unknown error');
  }
}

async function closePullRequest(deps: HoldDeps, { pr, project }: Scope) {
  try {
    await deps.githubFor(project.installationId).closePullRequest(project.owner, project.repo, pr.number);
  } catch (error) {
    console.error('Closing the pull request failed', pr.id, error instanceof Error ? error.message : 'unknown error');
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

// The model's band picks a point inside the maintainer's bounds. With no triage, the default.
export function holdAmount({ pr, project }: Scope): number {
  return holdCents(pr.triage ? bandCents(pr.triage.band, project) : null, project);
}

export type Refusal = 'not_found' | 'not_waiting' | 'stale_order' | 'declined' | 'too_many_holds';

// GitHub's own cap works per repository, so someone spraying many projects passes under it. A
// hold ties up real funds, and PayPal's account ID follows the same person across all of them.
export const MAX_OPEN_HOLDS_PER_ACCOUNT = 5;

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

export async function confirmHold(deps: HoldDeps, pullRequestId: string, orderId: string, options: { simulateDecline?: boolean } = {}): Promise<{ ok: true } | { refused: Refusal }> {
  const scope = await scopeOf(deps, pullRequestId);
  const row = await holdOf(deps, pullRequestId);
  if (!scope || !row) return { refused: 'not_found' };
  if (row.orderId !== orderId) return { refused: 'stale_order' };
  if (row.state !== 'awaiting_approval') return { ok: true };
  // A vouch or a close can arrive while the buyer is on PayPal. Nothing is held in that case.
  if (scope.pr.status !== 'waiting') return { refused: 'not_waiting' };

  // Only the demo's test account may ask PayPal's sandbox to act out a decline.
  const simulateDecline = options.simulateDecline === true && scope.pr.authorLogin === DEMO.contributor;
  let authorization;
  try {
    authorization = await deps.paypal.authorizeOrder(orderId, `hold-${row.id}-authorize-${orderId}`, { simulateDecline });
  } catch (error) {
    if (error instanceof PayPalError && error.status === 422) return { refused: 'declined' };
    throw error;
  }
  if (authorization.status === 'DENIED') return { refused: 'declined' };

  if (authorization.payerId) {
    const [open] = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(holds)
      .where(and(eq(holds.payerId, authorization.payerId), inArray(holds.state, [...OPEN])));
    if ((open?.count ?? 0) >= MAX_OPEN_HOLDS_PER_ACCOUNT) {
      await deps.paypal.voidAuthorization(authorization.authorizationId, `hold-${row.id}-void-${authorization.authorizationId}`);
      return { refused: 'too_many_holds' };
    }
  }

  let saved: HoldRow | undefined;
  try {
    [saved] = await deps.db
      .update(holds)
      .set({ state: 'held', authorizationId: authorization.authorizationId, payerId: authorization.payerId, authorizedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(holds.id, row.id), eq(holds.state, 'awaiting_approval')))
      .returning();
  } catch (error) {
    // PayPal holds the money and this app has no record of it, so give the money back before
    // telling the buyer that nothing was held.
    await deps.paypal.voidAuthorization(authorization.authorizationId, `hold-${row.id}-void-${authorization.authorizationId}`);
    throw error;
  }
  if (!saved) return { ok: true };

  await deps.db.update(pullRequests).set({ status: 'in_review', updatedAt: new Date() }).where(eq(pullRequests.id, pullRequestId));
  await removeWaitingLabel(deps, scope);
  await record(deps, scope, saved, 'held', { paypalId: authorization.authorizationId, actor: scope.pr.authorLogin });
  await tell(deps, scope, { check: CHECK.held, comment: heldComment(scope.pr.authorLogin, saved.cents) });
  return { ok: true };
}

async function runEffects(deps: HoldDeps, { pr, project }: Scope, row: HoldRow, effects: Effect[]) {
  const result: { captureId?: string; capturedAt?: Date; refundId?: string; payoutBatchId?: string } = {};
  let authorizationId = row.authorizationId!;
  for (const effect of effects) {
    switch (effect) {
      case 'void':
        try {
          await deps.paypal.voidAuthorization(authorizationId, `hold-${row.id}-void-${authorizationId}`);
        } catch (error) {
          // Already released, by a repeat or on PayPal's dashboard, which is the wanted result.
          if (!(error instanceof PayPalError) || error.issue !== 'PREVIOUSLY_VOIDED') throw error;
        }
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
        result.capturedAt = new Date();
        break;
      }
      case 'refund':
        result.refundId = await deps.paypal.refund(row.captureId!, `hold-${row.id}-refund-${row.captureId}`);
        break;
      case 'payout':
        result.payoutBatchId = await deps.paypal.payout(
          {
            cents: row.cents,
            receiver: project.payoutReceiver!,
            note: `Forfeited hold on ${project.owner}/${project.repo} pull request #${pr.number}`,
            senderId: `hold-${row.id}`,
          },
          `hold-${row.id}-payout`,
        );
        break;
    }
  }
  return result;
}

// Runs the effects, then stores the next state only if nothing else moved the hold first.
// Returns null when something did, so the caller adds no second ledger row or comment.
async function settle(deps: HoldDeps, scope: Scope, row: HoldRow, next: Hold, effects: Effect[], extra: Partial<HoldRow> = {}): Promise<HoldRow | null> {
  const result = await runEffects(deps, scope, row, effects);
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
  const saved = await settle(deps, scope, row, decision.next, decision.effects);
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
      const saved = await settle(deps, scope, row, decision.next, decision.effects, { forfeitedBy: actor, forfeitReason: command.reason });
      if (!saved) return;
      await record(deps, scope, saved, 'forfeit_opened', { paypalId: saved.authorizationId, actor, note: command.reason });
      await tell(deps, scope, {
        check: CHECK.forfeitPending,
        comment: forfeitComment({ login, by: actor, cents: saved.cents, reason: command.reason, appealEndsAt: saved.appealEndsAt! }),
      });
      // One comment deals with the pull request. An open forfeit survives the close.
      await closePullRequest(deps, scope);
      return;
    }
    case 'appeal': {
      const saved = await settle(deps, scope, row, decision.next, decision.effects, { appealReason: command.reason });
      if (!saved) return;
      await record(deps, scope, saved, 'appealed', { paypalId: saved.authorizationId, actor, note: command.reason });
      await tell(deps, scope, { comment: appealComment(actor) });
      return;
    }
    case 'release': {
      const saved = await settle(deps, scope, row, decision.next, decision.effects);
      if (!saved) return;
      await record(deps, scope, saved, 'voided', { paypalId: saved.authorizationId, actor, note: 'released by a maintainer' });
      await tell(deps, scope, { check: CHECK.released, comment: releasedComment(login, saved.cents, `@${actor} released it`) });
      return;
    }
    case 'uphold': {
      const saved = await settle(deps, scope, row, decision.next, decision.effects);
      if (!saved) return;
      await record(deps, scope, saved, 'upheld', { paypalId: saved.authorizationId, actor });
      await tell(deps, scope, { comment: upheldComment(actor) });
      // The appeal window is over, so the capture does not need to wait for the clock.
      await settleDue(deps, scope, saved, new Date());
      return;
    }
    case 'reverse': {
      const saved = await settle(deps, scope, row, decision.next, decision.effects);
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
  const payingOut = decision.effects.includes('payout');
  // With no receiver set, the capture stays where it is and can still be reversed.
  if (payingOut && !scope.project.payoutReceiver) return;

  let saved: HoldRow | null;
  try {
    saved = await settle(deps, scope, row, decision.next, decision.effects);
  } catch (error) {
    if (error instanceof PayPalError && !error.retryable && payingOut) {
      // Stops the retries. The hold stays captured and reversible, and a person has to look.
      await deps.db.update(holds).set({ capturedAt: null, updatedAt: new Date() }).where(eq(holds.id, row.id));
      await tell(deps, scope, { comment: payoutFailedComment(row.cents) });
      return;
    }
    if (!capturing || !(error instanceof PayPalError) || error.retryable) throw error;
    // Clearing the time stops the retries. The hold stays open, and the void deadline or a
    // maintainer's release still ends it, so a refused capture never strands the money.
    await deps.db.update(holds).set({ appealEndsAt: null, updatedAt: new Date() }).where(eq(holds.id, row.id));
    await tell(deps, scope, { comment: captureFailedComment(row.cents) });
    return;
  }
  if (!saved) return;

  if (payingOut) {
    await record(deps, scope, saved, 'paid_out', { paypalId: saved.payoutBatchId, note: scope.project.payoutReceiver ?? undefined });
    await tell(deps, scope, { check: CHECK.paidOut, comment: paidOutComment(saved.cents) });
  } else if (capturing) {
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
    .where(inArray(holds.state, [...OPEN, 'captured']));
  for (const { hold, pr, project } of rows) {
    try {
      await settleDue(deps, { pr, project }, hold, now);
    } catch (error) {
      console.error('Hold run failed', hold.id, error instanceof Error ? error.message : 'unknown error');
    }
  }
}

// PayPal's Transaction Search lags by up to three hours, so this looks back over two days
// and marks only what it can see. Only captures and refunds have an ID it reports.
export async function reconcile(deps: HoldDeps, now = new Date()): Promise<void> {
  const open = await deps.db
    .select({ id: ledgerEvents.id, paypalId: ledgerEvents.paypalId })
    .from(ledgerEvents)
    .where(and(inArray(ledgerEvents.kind, ['captured', 'refunded']), isNull(ledgerEvents.searchedAt), isNotNull(ledgerEvents.paypalId)));
  if (!open.length) return;
  const seen = new Set(await deps.paypal.searchTransactions(new Date(now.getTime() - 2 * 864e5), now));
  const found = open.filter((row) => seen.has(row.paypalId!)).map((row) => row.id);
  if (found.length) await deps.db.update(ledgerEvents).set({ searchedAt: now }).where(inArray(ledgerEvents.id, found));
}

// Demo pull requests from the try page close themselves after a day, which releases any hold, so
// the shared sandbox buyer never reaches the limit on open holds.
const DEMO_LIFETIME_MS = 864e5;

export async function closeOldDemoPulls(deps: HoldDeps, now = new Date()): Promise<void> {
  const rows = await deps.db
    .select({ pr: pullRequests, project: projects })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(and(eq(projects.owner, DEMO.owner), eq(projects.repo, DEMO.repo), eq(pullRequests.authorLogin, DEMO.contributor), inArray(pullRequests.status, ['waiting', 'in_review']), gte(pullRequests.number, FIRST_TRY_NUMBER), lte(pullRequests.createdAt, new Date(now.getTime() - DEMO_LIFETIME_MS))));
  for (const scope of rows) await closePullRequest(deps, scope);
}

const KIND = { voided: 'voided', captured: 'captured', refunded: 'refunded' } as const;

async function onDisputeEvent(deps: HoldDeps, dispute: NonNullable<ReturnType<typeof readDispute>>) {
  const [found] = await deps.db
    .select({ hold: holds, pr: pullRequests, project: projects })
    .from(holds)
    .innerJoin(pullRequests, eq(holds.pullRequestId, pullRequests.id))
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(eq(holds.captureId, dispute.captureId));
  if (!found) return;
  const scope = { pr: found.pr, project: found.project };

  if (dispute.phase === 'opened') {
    // No payout while PayPal decides. A hold already paid out stays paid, and the ledger says so.
    if (found.hold.state === 'captured') await deps.db.update(holds).set({ capturedAt: null, updatedAt: new Date() }).where(eq(holds.id, found.hold.id));
    await record(deps, scope, found.hold, 'disputed', { paypalId: dispute.disputeId, actor: 'PayPal', note: `the ${found.hold.state === 'paid_out' ? 'payout had already gone out' : 'payout is stopped'}`, reconciled: true });
    await tell(deps, scope, { comment: disputeOpenedComment(found.hold.cents) });
    return;
  }

  const outcome = dispute.outcome ?? 'no outcome reported';
  // In the project's favour, the day of reversal starts again and the payout follows. In the
  // contributor's favour, PayPal's own reversal event moves the hold to refunded.
  if (found.hold.state === 'captured' && dispute.outcome === 'RESOLVED_SELLER_FAVOUR') {
    await deps.db.update(holds).set({ capturedAt: new Date(), updatedAt: new Date() }).where(eq(holds.id, found.hold.id));
  }
  await record(deps, scope, found.hold, 'dispute_resolved', { paypalId: dispute.disputeId, actor: 'PayPal', note: outcome, reconciled: true });
  await tell(deps, scope, { comment: disputeResolvedComment(outcome) });
}

async function onPayoutEvent(deps: HoldDeps, payout: NonNullable<ReturnType<typeof readPayout>>) {
  const [found] = await deps.db
    .select({ hold: holds, pr: pullRequests, project: projects })
    .from(holds)
    .innerJoin(pullRequests, eq(holds.pullRequestId, pullRequests.id))
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(eq(holds.payoutBatchId, payout.batchId));
  if (!found) return;
  if (payout.outcome === 'succeeded') {
    await deps.db.update(ledgerEvents).set({ reconciledAt: new Date() }).where(and(eq(ledgerEvents.holdId, found.hold.id), eq(ledgerEvents.kind, 'paid_out')));
  } else {
    await tell(deps, { pr: found.pr, project: found.project }, { comment: payoutFailedComment(found.hold.cents) });
  }
}

export async function onPayPalEvent(deps: HoldDeps, event: PayPalEvent): Promise<void> {
  // The hold is already recorded by the time PayPal reports it, so this only confirms the row.
  if (event.event_type === 'PAYMENT.AUTHORIZATION.CREATED' && event.resource.id) {
    const [held] = await deps.db.select({ id: holds.id }).from(holds).where(eq(holds.authorizationId, event.resource.id));
    if (held) {
      await deps.db.update(ledgerEvents).set({ reconciledAt: new Date() }).where(and(eq(ledgerEvents.holdId, held.id), eq(ledgerEvents.kind, 'held')));
    }
    return;
  }

  const payout = readPayout(event);
  if (payout) {
    await onPayoutEvent(deps, payout);
    return;
  }

  const dispute = readDispute(event);
  if (dispute) {
    await onDisputeEvent(deps, dispute);
    return;
  }

  const refused = readRefusedCapture(event);
  if (refused) {
    const [found] = await deps.db
      .select({ hold: holds, pr: pullRequests, project: projects })
      .from(holds)
      .innerJoin(pullRequests, eq(holds.pullRequestId, pullRequests.id))
      .innerJoin(projects, eq(pullRequests.projectId, projects.id))
      .where(eq(holds.captureId, refused));
    if (found) {
      // Clearing the capture time stops the payout, since nothing arrived to pay out.
      await deps.db.update(holds).set({ capturedAt: null, updatedAt: new Date() }).where(eq(holds.id, found.hold.id));
      await tell(deps, { pr: found.pr, project: found.project }, { comment: captureFailedComment(found.hold.cents) });
    }
    return;
  }

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

  // A capture this app asked for can report back before its own save. The window has closed and
  // a maintainer forfeited, so this is that capture finishing, and the payout must still follow.
  const ours = confirmation.confirmed === 'captured' && found.hold.state === 'forfeit_pending' && found.hold.appealEndsAt !== null && found.hold.appealEndsAt <= new Date();

  // Otherwise PayPal moved the hold without this app, for example from the dashboard.
  const paypalId = confirmation.confirmed === 'voided' ? confirmation.authorizationId : confirmation.confirmed === 'captured' ? confirmation.captureId : confirmation.refundId;
  const [saved] = await deps.db
    .update(holds)
    .set({
      state: next.state,
      appealEndsAt: null,
      updatedAt: new Date(),
      ...(confirmation.confirmed === 'captured' ? { captureId: confirmation.captureId, capturedAt: new Date() } : {}),
      ...(confirmation.confirmed === 'refunded' ? { refundId: confirmation.refundId } : {}),
    })
    .where(and(eq(holds.id, found.hold.id), eq(holds.state, found.hold.state)))
    .returning();
  if (!saved) return;
  const scope = { pr: found.pr, project: found.project };
  if (ours) {
    await record(deps, scope, saved, 'captured', { paypalId, actor: saved.forfeitedBy, note: saved.forfeitReason ?? undefined, reconciled: true });
    await tell(deps, scope, { check: CHECK.captured, comment: capturedComment({ login: scope.pr.authorLogin, cents: saved.cents, by: saved.forfeitedBy }) });
    return;
  }
  await record(deps, scope, saved, kind, { paypalId, actor: 'PayPal', note: 'changed outside this app', reconciled: true });
  const check = kind === 'voided' ? CHECK.released : kind === 'captured' ? CHECK.captured : CHECK.refunded;
  await tell(deps, scope, { check, comment: changedOnPayPalComment(next.state) });
}
