import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { holds, ledgerEvents, projects, pullRequests, vouches } from '@/db/schema';
import { ACTIONS, availableActions, type TryAction } from '@/lib/demo/actions';
import { FIRST_TRY_NUMBER, KEPT_WAITING_NUMBER } from '@/lib/demo/constants';
import { commentAs, DEMO, demoEnabled, openTestPullRequest, reviewAs, type PullRequestKind } from '@/lib/demo/github';

// Each new pull request costs a model call, so the page has a daily ceiling.
const DAILY_LIMIT = 40;

export async function startTry(kind: PullRequestKind): Promise<{ number: number } | { refused: 'disabled' | 'limit' }> {
  if (!demoEnabled()) return { refused: 'disabled' };
  const [project] = await db().select().from(projects).where(and(eq(projects.owner, DEMO.owner), eq(projects.repo, DEMO.repo)));
  if (project) {
    const since = new Date(Date.now() - 864e5);
    const [opened] = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(pullRequests)
      .where(and(eq(pullRequests.projectId, project.id), eq(pullRequests.authorLogin, DEMO.contributor), gte(pullRequests.createdAt, since)));
    if ((opened?.count ?? 0) >= DAILY_LIMIT) return { refused: 'limit' };
    // The test account has to arrive as a stranger each time, or the gate would wave it through.
    await db().delete(vouches).where(and(eq(vouches.projectId, project.id), eq(vouches.login, DEMO.contributor)));
  }
  return { number: await openTestPullRequest(kind) };
}

export async function tryState(number: number) {
  if (number < FIRST_TRY_NUMBER || number === KEPT_WAITING_NUMBER) return null;
  const [row] = await db()
    .select({ pr: pullRequests, hold: holds })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .leftJoin(holds, eq(holds.pullRequestId, pullRequests.id))
    .where(and(eq(projects.owner, DEMO.owner), eq(projects.repo, DEMO.repo), eq(pullRequests.number, number), eq(pullRequests.authorLogin, DEMO.contributor)));
  if (!row) return null;
  const { pr, hold } = row;
  const events = await db().select().from(ledgerEvents).where(eq(ledgerEvents.pullRequestId, pr.id)).orderBy(desc(ledgerEvents.createdAt));
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.htmlUrl,
    status: pr.status,
    triage: pr.triage,
    hold: hold && {
      state: hold.state,
      cents: hold.cents,
      authorizationId: hold.authorizationId,
      captureId: hold.captureId,
      refundId: hold.refundId,
      appealEndsAt: hold.appealEndsAt,
    },
    events: events.map((event) => ({ id: event.id, kind: event.kind, cents: event.cents, paypalId: event.paypalId, at: event.createdAt, confirmed: Boolean(event.reconciledAt) })),
    actions: availableActions(pr.status, hold?.state ?? null),
  };
}

export type TryState = NonNullable<Awaited<ReturnType<typeof tryState>>>;

export async function runTryAction(number: number, action: TryAction): Promise<'ok' | 'not_found' | 'not_now'> {
  const state = await tryState(number);
  if (!state) return 'not_found';
  if (!state.actions.includes(action)) return 'not_now';
  const step = ACTIONS[action];
  if ('review' in step) await reviewAs(step.role, number, step.review);
  else await commentAs(step.role, number, step.comment);
  return 'ok';
}
