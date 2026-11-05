import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookDeliveries } from '@/db/schema';
import { githubFor } from '@/lib/github/client';
import { issueCommentEvent, pullRequestEvent, verifySignature } from '@/lib/github/webhook';
import { onIssueComment, onPullRequest } from '@/server/gate-flow';

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
  if (event !== 'pull_request' && event !== 'issue_comment') return Response.json({ ignored: event });

  const fresh = await db().insert(webhookDeliveries).values({ source: 'github', deliveryId: delivery }).onConflictDoNothing().returning();
  if (!fresh.length) return Response.json({ duplicate: true });

  try {
    const body: unknown = JSON.parse(raw);
    const appUrl = process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000';
    if (event === 'pull_request') {
      const parsed = pullRequestEvent.parse(body);
      await onPullRequest({ db: db(), github: githubFor(parsed.installation.id), appUrl }, parsed);
    } else {
      const parsed = issueCommentEvent.parse(body);
      await onIssueComment({ db: db(), github: githubFor(parsed.installation.id), appUrl }, parsed);
    }
    return Response.json({ ok: true });
  } catch (error) {
    // Forget the delivery, so a redelivery from GitHub's settings page can run it again.
    await db().delete(webhookDeliveries).where(and(eq(webhookDeliveries.source, 'github'), eq(webhookDeliveries.deliveryId, delivery)));
    console.error('GitHub webhook failed', delivery, error instanceof Error ? error.message : 'unknown error');
    return new Response('failed', { status: 500 });
  }
}
