import { and, eq } from 'drizzle-orm';
import { holds, ledgerEvents, projects, pullRequests, vouches, type PullRequestStatus, type StoredHoldState } from '@/db/schema';
import { mayUse, parseCommand, type Command } from '@/lib/commands';
import { chooseDoor } from '@/lib/gate';
import type { CheckState } from '@/lib/github/client';
import type { IssueCommentEvent, PullRequestEvent, PullRequestReviewEvent } from '@/lib/github/webhook';
import { CHECK, closedDoorComment, gateComment, invalidCommandComment, onlyMaintainersComment, vouchedComment } from '@/lib/messages';
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
    case 'voided':
      return CHECK.released;
    case 'refunded':
      return CHECK.refunded;
    default:
      return CHECK.vouched;
  }
}

export async function onPullRequest(deps: Deps, event: PullRequestEvent): Promise<void> {
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const pr = event.pull_request;
  const project = await projectFor(deps, owner, repo, event.installation.id);
  const [existing] = await deps.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.projectId, project.id), eq(pullRequests.number, pr.number)));

  if (event.action === 'closed') {
    if (existing) {
      const status: PullRequestStatus = pr.merged ? 'merged' : 'closed';
      await deps.db.update(pullRequests).set({ status, updatedAt: new Date() }).where(eq(pullRequests.id, existing.id));
      // Closing without a forfeit releases the hold too. A forfeit already opened stays open.
      const because = pr.merged ? 'this pull request was merged' : 'this pull request was closed without a forfeit';
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

  if ((event.action !== 'opened' && event.action !== 'reopened') || existing) return;

  const login = pr.user.login.toLowerCase();
  const [vouch] = await deps.db.select().from(vouches).where(and(eq(vouches.projectId, project.id), eq(vouches.login, login)));
  const list = parseVouchList((await deps.github.vouchFile(owner, repo)) ?? '');
  const decision = chooseDoor({
    isBot: isBot(pr.user),
    association: pr.author_association,
    listStatus: vouch && listStatus(list, login) !== 'denounced' ? 'vouched' : listStatus(list, login),
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

  const state = decision.door === 'known' ? CHECK.known : decision.door === 'closed' ? CHECK.closed : CHECK.waiting;
  const checkRunId = await deps.github.createCheck(owner, repo, pr.head.sha, state);
  let gateCommentId: number | null = null;
  if (decision.door === 'choose') {
    gateCommentId = await deps.github.comment(
      owner,
      repo,
      pr.number,
      gateComment({ login: pr.user.login, holdUrl: `${deps.appUrl}/hold/${row.id}`, minCents: project.minCents, maxCents: project.maxCents }),
    );
  } else if (decision.door === 'closed') {
    gateCommentId = await deps.github.comment(owner, repo, pr.number, closedDoorComment(pr.user.login));
  }
  await deps.db.update(pullRequests).set({ checkRunId, gateCommentId }).where(eq(pullRequests.id, row.id));
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
  if (command.name !== 'vouch') {
    await onHoldCommand(holdDeps(deps), row, command, actor);
    return;
  }

  // A plain `!vouch` is for this pull request's author. Vouching for someone else is
  // recorded for their future pull requests and leaves this one where it is.
  const target = command.target ?? row.pr.authorLogin;
  const inserted = await deps.db
    .insert(vouches)
    .values({ projectId: row.project.id, login: target.toLowerCase(), vouchedBy: actor, pullRequestId: row.pr.id })
    .onConflictDoNothing()
    .returning();
  if (target.toLowerCase() !== row.pr.authorLogin.toLowerCase()) return;
  if (row.pr.status !== 'waiting') {
    // The free door stays open after a hold, and using it gives the money back.
    await releaseForVouch(holdDeps(deps), row, actor);
    return;
  }

  await deps.db.update(pullRequests).set({ status: 'in_review', updatedAt: new Date() }).where(eq(pullRequests.id, row.pr.id));
  if (inserted.length) {
    await deps.db.insert(ledgerEvents).values({ projectId: row.project.id, pullRequestId: row.pr.id, kind: 'vouched', cents: 0, actor });
  }
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
