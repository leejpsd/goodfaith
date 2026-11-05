import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { ledgerEvents, projects, pullRequests, vouches, type PullRequestStatus } from '@/db/schema';
import type * as schema from '@/db/schema';
import { mayUse, parseCommand } from '@/lib/commands';
import { chooseDoor } from '@/lib/gate';
import type { GitHub } from '@/lib/github/client';
import type { IssueCommentEvent, PullRequestEvent } from '@/lib/github/webhook';
import { CHECK, closedDoorComment, gateComment, onlyMaintainersComment, vouchedComment } from '@/lib/messages';
import { listStatus, parseVouchList } from '@/lib/vouch';

export interface Deps {
  db: PgDatabase<PgQueryResultHKT, typeof schema>;
  github: GitHub;
  appUrl: string;
}

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
    }
    return;
  }

  // A new commit needs a new check, because a check belongs to one commit.
  if (event.action === 'synchronize' && existing) {
    const state = existing.status === 'waiting' ? CHECK.waiting : existing.status === 'blocked' ? CHECK.closed : existing.door === 'known' ? CHECK.known : CHECK.vouched;
    const checkRunId = await deps.github.createCheck(owner, repo, pr.head.sha, state);
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

export async function onIssueComment(deps: Deps, event: IssueCommentEvent): Promise<void> {
  if (event.action !== 'created' || !event.issue.pull_request || isBot(event.comment.user)) return;
  const command = parseCommand(event.comment.body ?? '');
  if (!command || command.name === 'invalid') return;

  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const actor = event.comment.user.login;
  const [row] = await deps.db
    .select({ pr: pullRequests, project: projects })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(and(eq(projects.owner, owner), eq(projects.repo, repo), eq(pullRequests.number, event.issue.number)));
  if (!row) return;

  const isMaintainer = WRITE_ACCESS.has(await deps.github.permission(owner, repo, actor));
  const isHoldOwner = actor.toLowerCase() === row.pr.authorLogin.toLowerCase();
  if (!mayUse(command, { isMaintainer, isHoldOwner })) {
    await deps.github.comment(owner, repo, event.issue.number, onlyMaintainersComment(actor));
    return;
  }
  if (command.name !== 'vouch') return;

  // A plain `!vouch` is for this pull request's author. Vouching for someone else is
  // recorded for their future pull requests and leaves this one where it is.
  const target = command.target ?? row.pr.authorLogin;
  const inserted = await deps.db
    .insert(vouches)
    .values({ projectId: row.project.id, login: target.toLowerCase(), vouchedBy: actor, pullRequestId: row.pr.id })
    .onConflictDoNothing()
    .returning();
  if (target.toLowerCase() !== row.pr.authorLogin.toLowerCase() || row.pr.status !== 'waiting') return;

  await deps.db.update(pullRequests).set({ status: 'in_review', updatedAt: new Date() }).where(eq(pullRequests.id, row.pr.id));
  if (inserted.length) {
    await deps.db.insert(ledgerEvents).values({ projectId: row.project.id, pullRequestId: row.pr.id, kind: 'vouched', cents: 0, actor });
  }
  if (row.pr.checkRunId) await deps.github.updateCheck(owner, repo, row.pr.checkRunId, CHECK.vouched);
  await deps.github.comment(owner, repo, event.issue.number, vouchedComment(row.pr.authorLogin, actor));
}
