import { desc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { db } from '@/db/client';
import { holds, ledgerEvents, pullRequests } from '@/db/schema';
import { toHoldRow, type ConsoleData } from '@/lib/console/data';
import { ConsoleLoader } from './console-loader';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Maintainer console' };

const EVENT = { vouched: 'Vouched', held: 'Hold placed', voided: 'Hold released', forfeit_opened: 'Forfeit', appealed: 'Appealed', captured: 'Captured', paid_out: 'Paid out', refunded: 'Refunded' } as const;

async function load(): Promise<ConsoleData> {
  const rows = await db().select({ pr: pullRequests, hold: holds }).from(pullRequests).leftJoin(holds, eq(holds.pullRequestId, pullRequests.id)).orderBy(desc(pullRequests.number)).limit(500);
  const events = await db()
    .select({ event: ledgerEvents, number: pullRequests.number })
    .from(ledgerEvents)
    .innerJoin(pullRequests, eq(ledgerEvents.pullRequestId, pullRequests.id))
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(2000);
  return {
    pulls: rows.map(({ pr }) => ({
      number: pr.number,
      title: pr.title,
      url: pr.htmlUrl,
      status: pr.status,
      door: pr.door,
      band: pr.triage?.band ?? 'none',
      openedAt: pr.createdAt.toISOString().slice(0, 10),
    })),
    holds: rows.flatMap(({ pr, hold }) => {
      const row = hold && toHoldRow(hold, pr.number);
      return row ? [row] : [];
    }),
    ledger: events.map(({ event, number }) => ({
      pr: number,
      event: EVENT[event.kind],
      amount: event.cents / 100,
      by: event.actor ?? 'none',
      reason: event.note ?? 'none',
      paypalId: event.paypalId ?? 'none',
      confirmed: event.reconciledAt ? 'confirmed' : 'not yet',
      at: event.createdAt.toISOString().slice(0, 10),
    })),
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
