import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it } from 'vitest';
import { holds, ledgerEvents, projects, pullRequests, vouches, webhookDeliveries } from './schema';

const db = drizzle(new PGlite());

beforeAll(async () => {
  await migrate(db, { migrationsFolder: 'drizzle' });
});

async function seed(number: number, repo = `repo-${number}`) {
  const [project] = await db.insert(projects).values({ owner: 'o', repo, installationId: 1 }).returning();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      projectId: project!.id,
      number,
      authorLogin: 'new-person',
      authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      title: 'Fix',
      htmlUrl: 'https://example.com',
      headSha: 'abc',
      door: 'choose',
      status: 'waiting',
    })
    .returning();
  return { project: project!, pr: pr! };
}

describe('schema', () => {
  it('applies the migrations and sets the default bounds', async () => {
    const { project } = await seed(1);
    expect(project).toMatchObject({ minCents: 200, maxCents: 2500, defaultCents: 500, appealDays: 7 });
  });

  it('keeps one row per pull request', async () => {
    const { project } = await seed(2);
    await expect(
      db.insert(pullRequests).values({
        projectId: project.id,
        number: 2,
        authorLogin: 'x',
        authorAssociation: 'NONE',
        title: 't',
        htmlUrl: 'u',
        headSha: 'abc',
        door: 'choose',
        status: 'waiting',
      }),
    ).rejects.toThrow();
  });

  it('keeps one hold per pull request', async () => {
    const { pr } = await seed(3);
    const values = { pullRequestId: pr.id, state: 'awaiting_approval' as const, cents: 500, orderId: 'O1' };
    await db.insert(holds).values(values);
    await expect(db.insert(holds).values({ ...values, orderId: 'O2' })).rejects.toThrow();
  });

  it('keeps one vouch per person per project', async () => {
    const { project } = await seed(4);
    const values = { projectId: project.id, login: 'new-person', vouchedBy: 'maintainer' };
    await db.insert(vouches).values(values);
    await expect(db.insert(vouches).values(values)).rejects.toThrow();
  });

  it('records a $0 vouch on the ledger', async () => {
    const { project, pr } = await seed(5);
    await db.insert(ledgerEvents).values({ projectId: project.id, pullRequestId: pr.id, kind: 'vouched', actor: 'maintainer' });
    const [row] = await db.select().from(ledgerEvents).where(eq(ledgerEvents.pullRequestId, pr.id));
    expect(row).toMatchObject({ kind: 'vouched', cents: 0, reconciledAt: null });
  });

  it('ignores a repeated webhook delivery', async () => {
    const delivery = { source: 'github' as const, deliveryId: 'abc' };
    const first = await db.insert(webhookDeliveries).values(delivery).onConflictDoNothing().returning();
    const second = await db.insert(webhookDeliveries).values(delivery).onConflictDoNothing().returning();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
