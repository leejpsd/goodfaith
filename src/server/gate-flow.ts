import { and, eq, ne, sql } from 'drizzle-orm';
import { holds, ledgerEvents, projects, pullRequests, vouches, type PullRequestStatus, type StoredHoldState } from '@/db/schema';
import { mayUse, parseCommand, type Command } from '@/lib/commands';
import { DEMO } from '@/lib/demo/constants';
import { chooseDoor } from '@/lib/gate';
import type { CheckState } from '@/lib/github/client';
import { readSettings } from '@/lib/github/config';
import type { IssueCommentEvent, PullRequestEvent, PullRequestReviewEvent } from '@/lib/github/webhook';
import { CHECK, closedDoorComment, earnedComment, gateComment, invalidCommandComment, onlyMaintainersComment, reopenedComment, unvouchedComment, vouchedComment, WAITING_LABEL } from '@/lib/messages';
import { listStatus, parseVouchList } from '@/lib/vouch';
import type { Deps, HoldDeps } from './deps';
import { onHoldCommand, releaseForReview, releaseForVouch, type Scope } from './hold-flow';

export type { Deps };

const holdDeps = (deps: Deps): HoldDeps => ({ ...deps, githubFor: () => deps.github });

async function projectFor(deps: Deps, owner: string, repo: string, installationId: number) {
  const [row] = await deps.db
    .insert(projects)
    .values({ owner, repo, installationId })
    .onConflictDoUpdate({ target: [projects.owner, projects.repo], set: { installationId } })
    .returning();
  return row!;
}

const isBot = (user: { type: string }) => user.type === 'Bot';
const WRITE_ACCESS = new Set(['admin', 'maintain', 'write']);

function checkFor(pr: Scope['pr'], hold: StoredHoldState | undefined): CheckState {
  if (pr.status === 'waiting') return CHECK.waiting;
  if (pr.status === 'blocked') return CHECK.closed;
  if (pr.door === 'known') return CHECK.known;
  switch (hold) {
    case 'held':
      return CHECK.held;
    case 'forfeit_pending':
    case 'appealed':
      return CHECK.forfeitPending;
    case 'captured':
      return CHECK.captured;
    case 'paid_out':
      return CHECK.paidOut;
    case 'voided':
      return CHECK.released;
    case 'refunded':
      return CHECK.refunded;
    default:
      return CHECK.vouched;
  }
}

const CLOSED_WITHOUT_FORFEIT = 'this pull request was closed without a forfeit';
const OPEN_HOLD: StoredHoldState[] = ['held', 'forfeit_pending', 'appealed'];

// Closing releases a hold, so closing and reopening would otherwise walk past the gate with
// nothing held. A reopened pull request keeps its place only if what let it in still stands: a
// known author, a vouch, an open hold, or a hold that ended some other way than by the close.
async function backToTheGate(deps: Deps, scope: Scope, headSha: string): Promise<void> {
  const { pr, project } = scope;
  const { owner, repo } = project;
  const [hold] = await deps.db.select().from(holds).where(eq(holds.pullRequestId, pr.id));
  const [vouch] = await deps.db.select().from(vouches).where(and(eq(vouches.projectId, project.id), eq(vouches.login, pr.authorLogin.toLowerCase())));
  const [byClosing] = await deps.db
    .select({ id: ledgerEvents.id })
    .from(ledgerEvents)
    .where(and(eq(ledgerEvents.pullRequestId, pr.id), eq(ledgerEvents.kind, 'voided'), eq(ledgerEvents.note, CLOSED_WITHOUT_FORFEIT)));
  const heldItsPlace = Boolean(hold?.authorizedAt) && (OPEN_HOLD.includes(hold!.state) || !byClosing);
  const status: PullRequestStatus = pr.door === 'closed' ? 'blocked' : pr.door === 'known' || vouch || heldItsPlace ? 'in_review' : 'waiting';

  const checkRunId = await deps.github.createCheck(owner, repo, headSha, checkFor({ ...pr, status }, vouch ? undefined : hold?.state));
  await deps.db.update(pullRequests).set({ status, headSha, checkRunId, updatedAt: new Date() }).where(eq(pullRequests.id, pr.id));
  if (status !== 'waiting') return;
  await deps.github.addLabel(owner, repo, pr.number, WAITING_LABEL).catch((error: unknown) => console.error('Adding the waiting label failed', error instanceof Error ? error.message : 'unknown error'));
  // One hold per pull request. Where one was placed and released, the vouch is the door left.
  await deps.github.comment(owner, repo, pr.number, reopenedComment({ login: pr.authorLogin, holdUrl: hold?.authorizedAt ? null : `${deps.appUrl}/hold/${pr.id}` }));
}

export async function onPullRequest(deps: Deps, event: PullRequestEvent): Promise<void> {
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const pr = event.pull_request;
  let project = await projectFor(deps, owner, repo, event.installation.id);
  if (event.action === 'opened') {
    const [updated] = await deps.db
      .update(projects)
      .set(readSettings(await deps.github.settingsFile(owner, repo), project))
      .where(eq(projects.id, project.id))
      .returning();
    project = updated ?? project;
  }
  const [existing] = await deps.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.projectId, project.id), eq(pullRequests.number, pr.number)));

  if (event.action === 'closed') {
    if (existing) {
      const status: PullRequestStatus = pr.merged ? 'merged' : 'closed';
      await deps.db.update(pullRequests).set({ status, updatedAt: new Date() }).where(eq(pullRequests.id, existing.id));
      // Closing without a forfeit releases the hold too. A forfeit already opened stays open.
      const because = pr.merged ? 'this pull request was merged' : CLOSED_WITHOUT_FORFEIT;
      await releaseForReview(holdDeps(deps), { pr: existing, project }, null, because);
    }
    return;
  }

  // A new commit needs a new check, because a check belongs to one commit.
  if (event.action === 'synchronize' && existing) {
    const [hold] = await deps.db.select({ state: holds.state }).from(holds).where(eq(holds.pullRequestId, existing.id));
    const checkRunId = await deps.github.createCheck(owner, repo, pr.head.sha, checkFor(existing, hold?.state));
    await deps.db.update(pullRequests).set({ headSha: pr.head.sha, checkRunId, updatedAt: new Date() }).where(eq(pullRequests.id, existing.id));
    return;
  }

  if (event.action === 'reopened' && existing) {
    await backToTheGate(deps, { pr: existing, project }, pr.head.sha);
    return;
  }

  if ((event.action !== 'opened' && event.action !== 'reopened') || existing) return;

  const login = pr.user.login.toLowerCase();
  const [vouch] = await deps.db.select().from(vouches).where(and(eq(vouches.projectId, project.id), eq(vouches.login, login)));
  const list = parseVouchList((await deps.github.vouchFile(owner, repo)) ?? '');
  const earned = project.trustEarned ? await earnedAt(deps, project.id, login) : null;
  const decision = chooseDoor({
    isBot: isBot(pr.user),
    association: pr.author_association,
    listStatus: vouch && listStatus(list, login) !== 'denounced' ? 'vouched' : listStatus(list, login),
    earned: earned !== null,
  });

  const status: PullRequestStatus = decision.door === 'known' ? 'in_review' : decision.door === 'closed' ? 'blocked' : 'waiting';
  const [row] = await deps.db
    .insert(pullRequests)
    .values({
      projectId: project.id,
      number: pr.number,
      authorLogin: pr.user.login,
      authorAssociation: pr.author_association,
      title: pr.title,
      htmlUrl: pr.html_url,
      headSha: pr.head.sha,
      door: decision.door,
      status,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return;

  const earnedDoor = decision.door === 'known' && decision.reason === 'earned' && earned !== null;
  const state = earnedDoor ? CHECK.earned : decision.door === 'known' ? CHECK.known : decision.door === 'closed' ? CHECK.closed : CHECK.waiting;
  const checkRunId = await deps.github.createCheck(owner, repo, pr.head.sha, state);
  let gateCommentId: number | null = null;
  if (decision.door === 'choose') {
    await deps.github.addLabel(owner, repo, pr.number, WAITING_LABEL).catch((error: unknown) => console.error('Adding the waiting label failed', error instanceof Error ? error.message : 'unknown error'));
    gateCommentId = await deps.github.comment(
      owner,
      repo,
      pr.number,
      gateComment({ login: pr.user.login, holdUrl: `${deps.appUrl}/hold/${row.id}`, minCents: project.minCents, maxCents: project.maxCents, sandbox: owner !== DEMO.owner }),
    );
  } else if (decision.door === 'closed') {
    gateCommentId = await deps.github.comment(owner, repo, pr.number, closedDoorComment(pr.user.login));
  } else if (earnedDoor) {
    // The free door, opened by a merge elsewhere, goes on the ledger like any vouch, at $0.
    await deps.db.insert(ledgerEvents).values({ projectId: project.id, pullRequestId: row.id, kind: 'vouched', cents: 0, actor: 'goodfaith', note: `earned: ${earned} was merged` });
    gateCommentId = await deps.github.comment(owner, repo, pr.number, earnedComment({ login: pr.user.login, from: earned }));
  }
  await deps.db.update(pullRequests).set({ checkRunId, gateCommentId }).where(eq(pullRequests.id, row.id));
}

// A pull request by the same person that faced the gate at another project and was merged.
async function earnedAt(deps: Deps, projectId: string, login: string): Promise<string | null> {
  const [merged] = await deps.db
    .select({ owner: projects.owner, repo: projects.repo, number: pullRequests.number })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(and(sql`lower(${pullRequests.authorLogin}) = ${login}`, eq(pullRequests.door, 'choose'), eq(pullRequests.status, 'merged'), ne(pullRequests.projectId, projectId)))
    .limit(1);
  return merged ? `${merged.owner}/${merged.repo}#${merged.number}` : null;
}

async function scopeFor(deps: Deps, owner: string, repo: string, number: number): Promise<Scope | undefined> {
  const [row] = await deps.db
    .select({ pr: pullRequests, project: projects })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(and(eq(projects.owner, owner), eq(projects.repo, repo), eq(pullRequests.number, number)));
  return row;
}

async function runCommand(deps: Deps, row: Scope, command: Command, actor: string): Promise<void> {
  const { owner, repo } = row.project;
  const number = row.pr.number;
  const isMaintainer = WRITE_ACCESS.has(await deps.github.permission(owner, repo, actor));
  const isHoldOwner = actor.toLowerCase() === row.pr.authorLogin.toLowerCase();
  if (!mayUse(command, { isMaintainer, isHoldOwner })) {
    await deps.github.comment(owner, repo, number, onlyMaintainersComment(actor));
    return;
  }
  if (command.name === 'unvouch') {
    const target = command.target ?? row.pr.authorLogin;
    const removed = await deps.db
      .delete(vouches)
      .where(and(eq(vouches.projectId, row.project.id), eq(vouches.login, target.toLowerCase())))
      .returning();
    await deps.github.comment(owner, repo, number, unvouchedComment(target, actor, removed.length > 0));
    return;
  }
  if (command.name !== 'vouch') {
    await onHoldCommand(holdDeps(deps), row, command, actor);
    return;
  }

  // A plain `!vouch` is for this pull request's author. Vouching for someone else is
  // recorded for their future pull requests and leaves this one where it is.
  const target = command.target ?? row.pr.authorLogin;
  await deps.db
    .insert(vouches)
    .values({ projectId: row.project.id, login: target.toLowerCase(), vouchedBy: actor, pullRequestId: row.pr.id })
    .onConflictDoNothing();
  if (target.toLowerCase() !== row.pr.authorLogin.toLowerCase()) return;
  if (row.pr.status !== 'waiting') {
    // The free door stays open after a hold, and using it gives the money back.
    await releaseForVouch(holdDeps(deps), row, actor);
    return;
  }

  const [moved] = await deps.db
    .update(pullRequests)
    .set({ status: 'in_review', updatedAt: new Date() })
    .where(and(eq(pullRequests.id, row.pr.id), eq(pullRequests.status, 'waiting')))
    .returning();
  // A repeat of the same comment finds the pull request already moved, and adds nothing.
  if (!moved) return;
  // Each pull request a vouch admits gets its row, even if this person was vouched for before.
  await deps.db.insert(ledgerEvents).values({ projectId: row.project.id, pullRequestId: row.pr.id, kind: 'vouched', cents: 0, actor });
  await deps.github.removeLabel(owner, repo, number, WAITING_LABEL).catch((error: unknown) => console.error('Removing the waiting label failed', error instanceof Error ? error.message : 'unknown error'));
  if (row.pr.checkRunId) await deps.github.updateCheck(owner, repo, row.pr.checkRunId, CHECK.vouched);
  await deps.github.comment(owner, repo, number, vouchedComment(row.pr.authorLogin, actor));
}

export async function onIssueComment(deps: Deps, event: IssueCommentEvent): Promise<void> {
  if (event.action !== 'created' || !event.issue.pull_request || isBot(event.comment.user)) return;
  const command = parseCommand(event.comment.body ?? '');
  if (!command) return;
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const actor = event.comment.user.login;
  const row = await scopeFor(deps, owner, repo, event.issue.number);
  if (!row) return;
  if (command.name === 'invalid') {
    await deps.github.comment(owner, repo, event.issue.number, invalidCommandComment(actor, command.command, command.problem));
    return;
  }
  await runCommand(deps, row, command, actor);
}

export async function onPullRequestReview(deps: Deps, event: PullRequestReviewEvent): Promise<void> {
  if (event.action !== 'submitted' || isBot(event.review.user)) return;
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const actor = event.review.user.login;
  const row = await scopeFor(deps, owner, repo, event.pull_request.number);
  if (!row) return;

  // A command in a review body is that command. `!forfeit` written there must not count as
  // the good-faith review that would release the hold it asks to forfeit.
  const command = parseCommand(event.review.body ?? '');
  if (command?.name === 'invalid') {
    await deps.github.comment(owner, repo, row.pr.number, invalidCommandComment(actor, command.command, command.problem));
    return;
  }
  if (command) {
    await runCommand(deps, row, command, actor);
    return;
  }

  if (actor.toLowerCase() === row.pr.authorLogin.toLowerCase()) return;
  if (!WRITE_ACCESS.has(await deps.github.permission(owner, repo, actor))) return;
  await releaseForReview(holdDeps(deps), row, actor, `@${actor} reviewed this pull request`);
}
