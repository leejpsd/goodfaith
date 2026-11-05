import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookDeliveries } from '@/db/schema';
import { githubFor } from '@/lib/github/client';
import { issueCommentEvent, pullRequestEvent, pullRequestReviewEvent, verifySignature } from '@/lib/github/webhook';
import { paypalClient } from '@/lib/paypal/client';
import { onIssueComment, onPullRequest, onPullRequestReview } from '@/server/gate-flow';
import { appUrl } from '@/server/live';
import { runTriage } from '@/lib/triage/triage';
import { triageOpened } from '@/server/triage-flow';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const raw = await request.text();
  if (!secret || !verifySignature(secret, raw, request.headers.get('x-hub-signature-256'))) {
    return new Response('bad signature', { status: 401 });
  }
  const delivery = request.headers.get('x-github-delivery');
  if (!delivery) return new Response('no delivery id', { status: 400 });

  const event = request.headers.get('x-github-event');
  if (event !== 'pull_request' && event !== 'issue_comment' && event !== 'pull_request_review') return Response.json({ ignored: event });

  const fresh = await db().insert(webhookDeliveries).values({ source: 'github', deliveryId: delivery }).onConflictDoNothing().returning();
  if (!fresh.length) return Response.json({ duplicate: true });

  try {
    const body: unknown = JSON.parse(raw);
    const deps = (installationId: number) => ({ db: db(), github: githubFor(installationId), paypal: paypalClient(), appUrl: appUrl() });
    if (event === 'pull_request') {
      const parsed = pullRequestEvent.parse(body);
      await onPullRequest(deps(parsed.installation.id), parsed);
      void triageOpened(deps(parsed.installation.id), parsed, runTriage).catch((error: unknown) =>
        console.error('Triage flow failed', error instanceof Error ? error.message : 'unknown error'),
      );
    } else if (event === 'pull_request_review') {
      const parsed = pullRequestReviewEvent.parse(body);
      await onPullRequestReview(deps(parsed.installation.id), parsed);
    } else {
      const parsed = issueCommentEvent.parse(body);
      await onIssueComment(deps(parsed.installation.id), parsed);
    }
    return Response.json({ ok: true });
  } catch (error) {
    // Forget the delivery, so a redelivery from GitHub's settings page can run it again.
    await db().delete(webhookDeliveries).where(and(eq(webhookDeliveries.source, 'github'), eq(webhookDeliveries.deliveryId, delivery)));
    console.error('GitHub webhook failed', delivery, error instanceof Error ? error.message : 'unknown error');
    return new Response('failed', { status: 500 });
  }
}
