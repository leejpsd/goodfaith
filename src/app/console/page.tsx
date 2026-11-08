import { desc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { db } from '@/db/client';
import { holds, ledgerEvents, projects, pullRequests } from '@/db/schema';
import { bandLabel, entryLabel, moneyEventLabel, prRef, statusLabel, toHoldRow, toQueueRow, type ConsoleData } from '@/lib/console/data';
import { LEDGER_LABEL, ledgerNote, webhookLabel } from '@/lib/ledger-labels';
import { ConsoleLoader } from './console-loader';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Maintainer console' };

async function load(): Promise<ConsoleData> {
  const rows = await db()
    .select({ pr: pullRequests, hold: holds, repo: projects.repo })
    .from(pullRequests)
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .leftJoin(holds, eq(holds.pullRequestId, pullRequests.id))
    .orderBy(desc(pullRequests.createdAt))
    .limit(500);
  const events = await db()
    .select({ event: ledgerEvents, number: pullRequests.number, repo: projects.repo })
    .from(ledgerEvents)
    .innerJoin(pullRequests, eq(ledgerEvents.pullRequestId, pullRequests.id))
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(2000);
  return {
    queue: rows
      .flatMap(({ pr, hold, repo }) => {
        const row = toQueueRow(pr, hold, prRef(repo, pr.number));
        return row ? [row] : [];
      })
      .sort((a, b) => a.rank - b.rank || a.dueAt - b.dueAt),
    pulls: rows.map(({ pr, hold, repo }) => ({
      pr: prRef(repo, pr.number),
      number: pr.number,
      title: pr.title,
      url: pr.htmlUrl,
      status: statusLabel(pr.status),
      entry: entryLabel({ door: pr.door, status: pr.status, held: Boolean(hold?.authorizedAt) }),
      band: bandLabel(pr.triage?.band ?? 'none'),
      openedAt: pr.createdAt.toISOString().slice(0, 10),
    })),
    holds: rows.flatMap(({ pr, hold, repo }) => {
      const row = hold && toHoldRow(hold, prRef(repo, pr.number), pr.htmlUrl);
      return row ? [row] : [];
    }),
    ledger: events.map(({ event, number, repo }) => ({
      pr: prRef(repo, number),
      event: LEDGER_LABEL[event.kind],
      amount: event.cents / 100,
      by: event.actor ?? 'none',
      reason: ledgerNote(event.kind, event.note),
      paypalId: event.paypalId ?? 'none',
      confirmed: webhookLabel(event.kind, Boolean(event.reconciledAt)),
      at: event.createdAt.toISOString().slice(0, 16).replace('T', ' '),
    })),
    money: events.flatMap(({ event }) => {
      const outcome = moneyEventLabel(event.kind);
      return outcome ? [{ outcome, amount: event.cents / 100 }] : [];
    }),
  };
}

export default async function ConsolePage() {
  const data = await load();
  return (
    <main className="console">
      <ConsoleLoader data={data} licenseKey={process.env.AG_STUDIO_LICENSE_KEY ?? ''} />
    </main>
  );
}
