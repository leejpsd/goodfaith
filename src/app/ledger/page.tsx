import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ledgerEvents, projects, pullRequests, type LedgerKind } from '@/db/schema';
import { LEDGER_LABEL, ledgerAmount, NO_PAYPAL_EVENT } from '@/lib/ledger-labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Public ledger' };

// PayPal's Transaction Search lags by up to three hours, so "not yet" is normal at first.
const SEARCHABLE: readonly LedgerKind[] = ['captured', 'refunded'];

export default async function LedgerPage() {
  const rows = await db()
    .select({ event: ledgerEvents, pr: pullRequests, repo: projects.repo })
    .from(ledgerEvents)
    .innerJoin(pullRequests, eq(ledgerEvents.pullRequestId, pullRequests.id))
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(200);

  return (
    <main className="page wide">
      <h1>Public ledger</h1>
      <p>Every vouch and every hold event. This demo uses PayPal sandbox money and test accounts.</p>
      <div className="scroll">
      <table>
        <thead>
          <tr><th>When</th><th>Event</th><th>Amount</th><th>Pull request</th><th>By</th><th>Reason</th><th>PayPal ID</th><th>PayPal webhook</th><th>Transaction Search</th></tr>
        </thead>
        <tbody>
          {rows.map(({ event, pr, repo }) => (
            <tr key={event.id}>
              <td>{event.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</td>
              <td>{LEDGER_LABEL[event.kind]}</td>
              <td>{ledgerAmount(event.kind, event.cents)}</td>
              <td><a href={pr.htmlUrl}>{repo}#{pr.number}</a></td>
              <td>{event.actor ?? 'none'}</td>
              <td className="note">{event.note ?? 'none'}</td>
              <td>{event.paypalId ?? 'none'}</td>
              <td>{NO_PAYPAL_EVENT.includes(event.kind) ? 'none' : event.reconciledAt ? 'confirmed' : 'not yet'}</td>
              <td>{SEARCHABLE.includes(event.kind) ? (event.searchedAt ? 'found' : 'not yet') : 'none'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </main>
  );
}
