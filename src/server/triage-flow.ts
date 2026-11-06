import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { projects, pullRequests } from '@/db/schema';
import { DEMO } from '@/lib/demo/constants';
import type { PullRequestEvent } from '@/lib/github/webhook';
import { reviewerBriefComment } from '@/lib/messages';
import { bandCents, type OpenTimeFacts, type Triage } from '@/lib/triage/triage';
import type { Deps } from './deps';

export type RunTriage = (facts: OpenTimeFacts) => Promise<Triage | null>;

// Anyone can install the hosted app, and each stranger's pull request costs a model call, so
// a day has a ceiling per project and in all. Past it, the project's default amount applies.
// The demo repository has its own ceiling on the try page.
export const PROJECT_DAILY_TRIAGE = 25;
export const ALL_DAILY_TRIAGE = 200;

// Runs after the delivery is answered, since GitHub allows ten seconds and the model can
// take longer. A failure leaves the project's default amount in place.
export async function triageOpened(deps: Deps, event: PullRequestEvent, run: RunTriage): Promise<void> {
  if (event.action !== 'opened') return;
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const number = event.pull_request.number;
  const [row] = await deps.db
    .select({ pr: pullRequests, project: projects })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(and(eq(projects.owner, owner), eq(projects.repo, repo), eq(pullRequests.number, number)));
  if (!row || row.pr.door !== 'choose' || row.pr.triage) return;

  const [today] = await deps.db
    .select({ project: sql<number>`count(*) filter (where ${pullRequests.projectId} = ${row.project.id})::int`, all: sql<number>`count(*)::int` })
    .from(pullRequests)
    .where(and(isNotNull(pullRequests.triage), gte(pullRequests.createdAt, new Date(Date.now() - 864e5))));
  const demo = row.project.owner === DEMO.owner;
  if ((today?.all ?? 0) >= ALL_DAILY_TRIAGE || (!demo && (today?.project ?? 0) >= PROJECT_DAILY_TRIAGE)) return;

  const facts = await deps.github.prFacts(owner, repo, number, row.pr.authorLogin);
  const triage = await run(facts);
  if (!triage) return;
  await deps.db.update(pullRequests).set({ triage, updatedAt: new Date() }).where(eq(pullRequests.id, row.pr.id));
  await deps.github.comment(owner, repo, number, reviewerBriefComment(triage, bandCents(triage.band, row.project)));
}
