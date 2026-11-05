import { and, eq } from 'drizzle-orm';
import { projects, pullRequests } from '@/db/schema';
import type { PullRequestEvent } from '@/lib/github/webhook';
import { reviewerBriefComment } from '@/lib/messages';
import { bandCents, type OpenTimeFacts, type Triage } from '@/lib/triage/triage';
import type { Deps } from './deps';

export type RunTriage = (facts: OpenTimeFacts) => Promise<Triage | null>;

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

  const facts = await deps.github.prFacts(owner, repo, number, row.pr.authorLogin);
  const triage = await run(facts);
  if (!triage) return;
  await deps.db.update(pullRequests).set({ triage, updatedAt: new Date() }).where(eq(pullRequests.id, row.pr.id));
  await deps.github.comment(owner, repo, number, reviewerBriefComment(triage, bandCents(triage.band, row.project)));
}
