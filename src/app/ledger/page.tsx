import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ledgerEvents, pullRequests } from '@/db/schema';
import { toPayPalValue } from '@/lib/hold';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Public ledger' };

export default async function LedgerPage() {
  const rows = await db()
    .select({ event: ledgerEvents, pr: pullRequests })
    .from(ledgerEvents)
    .innerJoin(pullRequests, eq(ledgerEvents.pullRequestId, pullRequests.id))
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(200);

  return (
    <main>
      <h1>Public ledger</h1>
      <p>Every vouch and every hold event. This demo uses PayPal sandbox money and test accounts.</p>
      <table>
        <thead>
          <tr><th>When</th><th>Event</th><th>Amount</th><th>Pull request</th><th>By</th><th>PayPal ID</th></tr>
        </thead>
        <tbody>
          {rows.map(({ event, pr }) => (
            <tr key={event.id}>
              <td>{event.createdAt.toISOString()}</td>
              <td>{event.kind}</td>
              <td>${toPayPalValue(event.cents)}</td>
              <td><a href={pr.htmlUrl}>#{pr.number}</a></td>
              <td>{event.actor}</td>
              <td>{event.paypalId ?? 'none'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
