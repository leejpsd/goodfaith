import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { holds, projects, pullRequests } from '@/db/schema';
import { AUTHORIZATION_DAYS, toPayPalValue, VOID_BEFORE_EXPIRY_DAYS } from '@/lib/hold';
import { holdAmount } from '@/server/hold-flow';
import { HoldButton } from './hold-button';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Refundable hold' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (cents: number) => `$${toPayPalValue(cents)}`;

export default async function HoldPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [row] = await db()
    .select({ pr: pullRequests, project: projects, hold: holds })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .leftJoin(holds, eq(holds.pullRequestId, pullRequests.id))
    .where(eq(pullRequests.id, id));
  if (!row) notFound();
  const { pr, project, hold } = row;
  const placed = hold && hold.state !== 'awaiting_approval' ? hold : null;
  const cents = holdAmount({ pr, project });

  return (
    <main>
      <p className="muted">Goodfaith</p>
      <h1>{pr.title}</h1>
      <p className="muted">
        <a href={pr.htmlUrl}>Pull request #{pr.number}</a> on {project.owner}/{project.repo}, by @{pr.authorLogin}
      </p>

      {placed ? (
        <Placed hold={placed} prUrl={pr.htmlUrl} />
      ) : pr.status === 'waiting' ? (
        <>
          <section className="card">
            <h2>A vouch is free</h2>
            <p>
              You do not have to pay anything. <a href={pr.htmlUrl}>Comment on the pull request</a> with what it fixes and why, and a maintainer can reply <code>!vouch</code>.
            </p>
          </section>
          <section className="card">
            <h2>Or place a {money(cents)} refundable hold</h2>
            <ul>
              <li>It is a hold and not a charge. PayPal reserves the amount, and no money moves.</li>
              <li>Any good-faith review releases all of it, merged or not.</li>
              <li>Only a maintainer can forfeit it, with a stated reason, and you get {project.appealDays} days to appeal first. No model can.</li>
              <li>A hold nobody acts on is released after {AUTHORIZATION_DAYS - VOID_BEFORE_EXPIRY_DAYS} days.</li>
            </ul>
            <HoldButton pullRequestId={pr.id} clientId={process.env.PAYPAL_CLIENT_ID ?? ''} amount={toPayPalValue(cents)} />
          </section>
        </>
      ) : (
        <section className="card">
          {pr.status === 'blocked' ? (
            <>
              <h2>This pull request will not enter review</h2>
              <p>The author is on this project&apos;s denounced list, and a hold cannot change that. A maintainer can decide otherwise.</p>
            </>
          ) : (
            <>
              <h2>No hold is needed</h2>
              <p>This pull request is {pr.status === 'in_review' ? 'already in the review queue' : pr.status}, and no money was involved.</p>
            </>
          )}
        </section>
      )}

      <footer>
        This demo uses PayPal sandbox money and test accounts. Every vouch and hold event is on the <a href="/ledger">public ledger</a>.
      </footer>
    </main>
  );
}

function Placed({ hold, prUrl }: { hold: typeof holds.$inferSelect; prUrl: string }) {
  const amount = money(hold.cents);
  switch (hold.state) {
    case 'forfeit_pending':
      return (
        <section className="card">
          <h2>A maintainer moved to forfeit your {amount} hold</h2>
          <p>Reason given: {hold.forfeitReason}</p>
          <p>
            No money has moved.
            {hold.appealEndsAt && (
              <> You can <a href={prUrl}>reply on the pull request</a> with <code>!appeal &lt;reason&gt;</code> until {hold.appealEndsAt.toUTCString()}.</>
            )}
          </p>
        </section>
      );
    case 'appealed':
      return (
        <section className="card">
          <h2>Your appeal is with the maintainers</h2>
          <p>Your {amount} hold stays in place, and nothing can be captured until a maintainer answers. If nobody answers, it is released.</p>
        </section>
      );
    case 'captured':
      return (
        <section className="card">
          <h2>Your {amount} hold was captured</h2>
          <p>Reason given: {hold.forfeitReason ?? 'none recorded'}</p>
          <p className="muted">PayPal capture {hold.captureId}</p>
        </section>
      );
    case 'voided':
      return (
        <section className="card">
          <h2>Your {amount} hold was released</h2>
          <p>All of it is yours again, and no money moved.</p>
          <p className="muted">PayPal authorization {hold.authorizationId}</p>
        </section>
      );
    case 'refunded':
      return (
        <section className="card">
          <h2>Your {amount} was refunded</h2>
          <p className="muted">PayPal refund {hold.refundId}</p>
        </section>
      );
    default:
      return (
        <section className="card">
          <h2>Your {amount} hold is in place</h2>
          <p>Your pull request is in the review queue. Any good-faith review releases the hold, merged or not.</p>
          <p className="muted">PayPal authorization {hold.authorizationId}</p>
        </section>
      );
  }
}
