import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { replays } from '@/db/schema';
import { factsAtOpen, isPublicRepo, listRecentPulls, searchCounts } from '@/lib/replay/github';
import { CLOSED_DOOR_MIN, closedFast, outsideAuthors, REPLAY_SIZE, toRow, type ListedPull, type ReplayResult, type ReplayRow } from '@/lib/replay/replay';
import { runTriage, type Triage } from '@/lib/triage/triage';

// Each new repository costs model calls and GitHub requests, so the page has a daily ceiling. A
// result stays for a week, and looking at one again costs nothing.
const DAILY_LIMIT = 40;
const KEEP_MS = 7 * 864e5;
const STUCK_MS = 10 * 60_000;
const CONCURRENCY = 5;
const CANDIDATES = 50;

export type ReplayStart = { status: 'running' | 'done' } | { refused: 'not_found' | 'limit' };

export async function startReplay(repo: string): Promise<ReplayStart> {
  const [existing] = await db().select().from(replays).where(eq(replays.repo, repo));
  const age = existing ? Date.now() - existing.updatedAt.getTime() : Infinity;
  if (existing?.status === 'done' && age < KEEP_MS && existing.result?.strangersFound !== undefined) return { status: 'done' };
  if (existing?.status === 'running' && age < STUCK_MS) return { status: 'running' };

  const [today] = await db().select({ count: sql<number>`count(*)::int` }).from(replays).where(gte(replays.updatedAt, new Date(Date.now() - 864e5)));
  if ((today?.count ?? 0) >= DAILY_LIMIT) return { refused: 'limit' };
  if (!(await isPublicRepo(repo))) return { refused: 'not_found' };

  const now = new Date();
  await db().insert(replays).values({ repo, status: 'running', updatedAt: now }).onConflictDoUpdate({ target: replays.repo, set: { status: 'running', result: null, updatedAt: now } });
  void runReplay(repo).catch(async (error: unknown) => {
    console.error('Replay failed', repo, error instanceof Error ? error.message : 'unknown error');
    await db().update(replays).set({ status: 'failed', updatedAt: new Date() }).where(and(eq(replays.repo, repo), eq(replays.status, 'running')));
  });
  return { status: 'running' };
}

export async function readReplay(repo: string) {
  const [row] = await db().select().from(replays).where(eq(replays.repo, repo));
  return row ?? null;
}

async function runReplay(repo: string): Promise<void> {
  const pulls = await listRecentPulls(repo);
  const fast = outsideAuthors(pulls).filter(closedFast);
  const closedDoor = fast.length >= CLOSED_DOOR_MIN;
  const outside = (closedDoor ? fast : outsideAuthors(pulls)).slice(0, CANDIDATES);

  // Today's association cannot say who was new at the time, so this asks about the past directly.
  const inRepo = (pull: ListedPull) => `repo:${repo} is:pr is:merged author:${pull.author} created:<${pull.createdAt.slice(0, 10)}`;
  const anywhere = (pull: ListedPull) => `is:pr is:merged author:${pull.author} merged:<${pull.createdAt.slice(0, 10)}`;
  // On a closed door, whether the same person got in later, which says the first one was in good faith.
  const later = (pull: ListedPull) => `repo:${repo} is:pr is:merged author:${pull.author} created:>${pull.createdAt.slice(0, 10)}`;
  const counts = await searchCounts([...new Set(outside.flatMap((pull) => [inRepo(pull), anywhere(pull), ...(closedDoor ? [later(pull)] : [])]))]);
  const allStrangers = outside.filter((pull) => (counts.get(inRepo(pull)) ?? 0) === 0);
  const strangers = allStrangers.slice(0, REPLAY_SIZE);

  const rows: ReplayRow[] = [];
  let model: string | null = null;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < strangers.length) {
        const pull = strangers[next++]!;
        const facts = await factsAtOpen(repo, pull, counts.get(anywhere(pull)) ?? 0).catch(() => null);
        const triage: Triage | null = facts ? await runTriage(facts) : null;
        if (triage) model = triage.model;
        rows.push(toRow(pull, triage, closedDoor ? (counts.get(later(pull)) ?? 0) > 0 : null));
      }
    }),
  );

  const result: ReplayResult = { repo, at: new Date().toISOString(), model, looked: pulls.length, strangersFound: allStrangers.length, mode: closedDoor ? 'closed_door' : 'recent', rows: rows.sort((a, b) => b.number - a.number) };
  await db().update(replays).set({ status: 'done', result, updatedAt: new Date() }).where(eq(replays.repo, repo));
}
