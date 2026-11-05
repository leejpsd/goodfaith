import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { holds, ledgerEvents, projects, pullRequests } from '@/db/schema';
import * as schema from '@/db/schema';
import type { CheckState, GitHub, Permission } from '@/lib/github/client';
import type { IssueCommentEvent, PullRequestEvent, PullRequestReviewEvent } from '@/lib/github/webhook';
import { PayPalError, type PayPal } from '@/lib/paypal/client';
import type { PayPalEvent } from '@/lib/paypal/webhook';
import type { Deps, HoldDeps } from './deps';
import { onIssueComment, onPullRequest, onPullRequestReview } from './gate-flow';
import { beginHold, confirmHold, onPayPalEvent, reconcile, runDue } from './hold-flow';

const db = drizzle(new PGlite(), { schema });
const DAY = 864e5;
let repoCounter = 0;
let repo = '';

class FakeGitHub implements GitHub {
  comments: string[] = [];
  checks = new Map<number, CheckState>();
  permissions: Record<string, Permission> = { maintainer: 'write' };
  next = 100;
  failing = false;
  prFacts = async (): Promise<never> => {
    throw new Error('not used here');
  };
  settingsFile = async () => null;
  vouchFile = async () => null;
  permission = async (_o: string, _r: string, login: string) => this.permissions[login] ?? 'none';
  comment = async (_o: string, _r: string, _n: number, body: string) => {
    if (this.failing) throw new Error('GitHub is down');
    this.comments.push(body);
    return this.next++;
  };
  createCheck = async (_o: string, _r: string, _s: string, state: CheckState) => {
    const id = this.next++;
    this.checks.set(id, state);
    return id;
  };
  closed: number[] = [];
  closePullRequest = async (_o: string, _r: string, number: number) => {
    this.closed.push(number);
  };
  updateCheck = async (_o: string, _r: string, id: number, state: CheckState) => {
    if (this.failing) throw new Error('GitHub is down');
    this.checks.set(id, state);
  };
  get lastCheck() {
    return [...this.checks.values()].at(-1);
  }
}

class FakePayPal implements PayPal {
  calls: string[] = [];
  requestIds: string[] = [];
  declineAuthorize = false;
  captureError: PayPalError | null = null;
  orders = 0;
  createOrder = async () => `ORDER-${++this.orders}`;
  simulated: boolean[] = [];
  voidError: PayPalError | null = null;
  authorizeOrder = async (orderId: string, requestId: string, options?: { simulateDecline?: boolean }) => {
    this.calls.push(`authorize ${orderId}`);
    this.requestIds.push(requestId);
    this.simulated.push(options?.simulateDecline === true);
    if (this.declineAuthorize || options?.simulateDecline) throw new PayPalError('authorize order', 422, 'INSTRUMENT_DECLINED', 'debug');
    return { authorizationId: `AUTH-${orderId}`, status: 'CREATED' };
  };
  voidAuthorization = async (id: string, requestId: string) => {
    this.calls.push(`void ${id}`);
    this.requestIds.push(requestId);
    if (this.voidError) throw this.voidError;
  };
  reauthorize = async (id: string) => {
    this.calls.push(`reauthorize ${id}`);
    return `RE-${id}`;
  };
  capture = async (id: string, _c: number, requestId: string) => {
    this.calls.push(`capture ${id}`);
    this.requestIds.push(requestId);
    if (this.captureError) throw this.captureError;
    return { captureId: `CAP-${id}`, status: 'COMPLETED' };
  };
  refund = async (id: string) => {
    this.calls.push(`refund ${id}`);
    return `REF-${id}`;
  };
  verifyWebhook = async () => true;
  payoutError: PayPalError | null = null;
  payouts: { cents: number; receiver: string; senderId: string }[] = [];
  searchResults: string[] = [];
  payout = async (input: { cents: number; receiver: string; note: string; senderId: string }) => {
    this.calls.push(`payout ${input.receiver}`);
    if (this.payoutError) throw this.payoutError;
    this.payouts.push(input);
    return `BATCH-${input.senderId}`;
  };
  searchTransactions = async () => this.searchResults;
}

let github: FakeGitHub;
let paypal: FakePayPal;
let deps: Deps;
let hold: HoldDeps;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
  // The clock looks at every open hold, so holds from earlier tests must not linger.
  await db.delete(ledgerEvents);
  await db.delete(holds);
  github = new FakeGitHub();
  paypal = new FakePayPal();
  deps = { db, github, paypal, appUrl: 'https://app.test' };
  hold = { db, paypal, appUrl: 'https://app.test', githubFor: () => github };
  repo = `repo-${++repoCounter}`;
});

const where = { repository: () => ({ name: repo, owner: { login: 'owner' } }) };

function prEvent(action = 'opened', merged = false): PullRequestEvent {
  return {
    action,
    installation: { id: 1 },
    repository: where.repository(),
    pull_request: {
      number: 1,
      title: 'Fix a bug',
      html_url: `https://github.com/owner/${repo}/pull/1`,
      merged,
      head: { sha: 'sha1' },
      author_association: 'FIRST_TIME_CONTRIBUTOR',
      user: { login: 'new-person', type: 'User' },
    },
  };
}

const say = (body: string, login = 'maintainer'): IssueCommentEvent => ({
  action: 'created',
  installation: { id: 1 },
  repository: where.repository(),
  issue: { number: 1, pull_request: {} },
  comment: { body, user: { login, type: 'User' } },
});

const review = (login = 'maintainer', body: string | null = 'Looks fine', type = 'User'): PullRequestReviewEvent => ({
  action: 'submitted',
  installation: { id: 1 },
  repository: where.repository(),
  pull_request: { number: 1 },
  review: { body, user: { login, type } },
});

async function waitingPr() {
  await onPullRequest(deps, prEvent());
  const [row] = await db.select().from(pullRequests).where(eq(pullRequests.htmlUrl, `https://github.com/owner/${repo}/pull/1`));
  return row!;
}

async function placedHold() {
  const pr = await waitingPr();
  const begun = await beginHold(hold, pr.id);
  if (!('orderId' in begun)) throw new Error('no order');
  await confirmHold(hold, pr.id, begun.orderId);
  return pr;
}

const holdRow = async (pullRequestId: string) => (await db.select().from(holds).where(eq(holds.pullRequestId, pullRequestId)))[0]!;
const ledgerKinds = async (pullRequestId: string) =>
  (await db.select().from(ledgerEvents).where(eq(ledgerEvents.pullRequestId, pullRequestId)).orderBy(ledgerEvents.createdAt)).map((row) => row.kind);

describe('placing a hold', () => {
  it('authorizes, enters review and writes one ledger row', async () => {
    const pr = await placedHold();
    const row = await holdRow(pr.id);
    expect(row).toMatchObject({ state: 'held', cents: 500 });
    expect(row.authorizationId).toMatch(/^AUTH-/);
    expect((await db.select().from(pullRequests).where(eq(pullRequests.id, pr.id)))[0]!.status).toBe('in_review');
    expect(await ledgerKinds(pr.id)).toEqual(['held']);
    expect(github.lastCheck?.title).toBe('Refundable hold placed');
  });

  it('does not authorize twice when the approval repeats', async () => {
    const pr = await placedHold();
    const row = await holdRow(pr.id);
    expect(await confirmHold(hold, pr.id, row.orderId)).toEqual({ ok: true });
    expect(paypal.calls.filter((c) => c.startsWith('authorize'))).toHaveLength(1);
    expect(await ledgerKinds(pr.id)).toEqual(['held']);
  });

  it('reports a decline, holds nothing and allows another try', async () => {
    const pr = await waitingPr();
    const first = await beginHold(hold, pr.id);
    if (!('orderId' in first)) throw new Error('no order');
    paypal.declineAuthorize = true;
    expect(await confirmHold(hold, pr.id, first.orderId)).toEqual({ refused: 'declined' });
    expect((await holdRow(pr.id)).state).toBe('awaiting_approval');
    expect(await ledgerKinds(pr.id)).toEqual([]);

    paypal.declineAuthorize = false;
    const second = await beginHold(hold, pr.id);
    if (!('orderId' in second)) throw new Error('no order');
    expect(second.orderId).not.toBe(first.orderId);
    expect(await confirmHold(hold, pr.id, first.orderId)).toEqual({ refused: 'stale_order' });
    expect(await confirmHold(hold, pr.id, second.orderId)).toEqual({ ok: true });
  });

  it('holds nothing when a vouch arrives during the approval', async () => {
    const pr = await waitingPr();
    const begun = await beginHold(hold, pr.id);
    if (!('orderId' in begun)) throw new Error('no order');
    await onIssueComment(deps, say('!vouch'));
    expect(await confirmHold(hold, pr.id, begun.orderId)).toEqual({ refused: 'not_waiting' });
    expect(paypal.calls).toEqual([]);
    expect(await ledgerKinds(pr.id)).toEqual(['vouched']);
  });

  it('offers no order once the pull request has left the queue', async () => {
    const pr = await waitingPr();
    await onIssueComment(deps, say('!vouch'));
    expect(await beginHold(hold, pr.id)).toEqual({ refused: 'not_waiting' });
    expect(paypal.orders).toBe(0);
  });

  it('survives GitHub being down after the money moved', async () => {
    const pr = await waitingPr();
    const begun = await beginHold(hold, pr.id);
    if (!('orderId' in begun)) throw new Error('no order');
    github.failing = true;
    expect(await confirmHold(hold, pr.id, begun.orderId)).toEqual({ ok: true });
    expect((await holdRow(pr.id)).state).toBe('held');
    expect(await ledgerKinds(pr.id)).toEqual(['held']);
  });
});

describe('failures while placing a hold', () => {
  it('throws on a PayPal outage, so the page can say it was not a decline', async () => {
    const pr = await waitingPr();
    const begun = await beginHold(hold, pr.id);
    if (!('orderId' in begun)) throw new Error('no order');
    paypal.authorizeOrder = async () => {
      throw new PayPalError('authorize order', 503, undefined, 'debug');
    };
    await expect(confirmHold(hold, pr.id, begun.orderId)).rejects.toThrow('503');
    expect((await holdRow(pr.id)).state).toBe('awaiting_approval');
  });

  it('only lets the test account simulate a decline', async () => {
    const pr = await waitingPr();
    const begun = await beginHold(hold, pr.id);
    if (!('orderId' in begun)) throw new Error('no order');
    expect(await confirmHold(hold, pr.id, begun.orderId, { simulateDecline: true })).toEqual({ ok: true });
    expect(paypal.simulated).toEqual([false]);
  });

  it('voids the authorization if the app cannot record it', async () => {
    const pr = await waitingPr();
    const begun = await beginHold(hold, pr.id);
    if (!('orderId' in begun)) throw new Error('no order');
    const broken = {
      ...hold,
      db: new Proxy(db, {
        get(target, key, receiver) {
          if (key === 'update') {
            return () => {
              throw new Error('database is down');
            };
          }
          return Reflect.get(target, key, receiver);
        },
      }),
    };
    await expect(confirmHold(broken, pr.id, begun.orderId)).rejects.toThrow('database is down');
    expect(paypal.calls.some((c) => c.startsWith('void AUTH-'))).toBe(true);
  });
});

describe('a good-faith review', () => {
  it('voids the hold in full when a maintainer reviews', async () => {
    const pr = await placedHold();
    await onPullRequestReview(deps, review());
    expect((await holdRow(pr.id)).state).toBe('voided');
    expect(paypal.calls).toContain(`void ${(await holdRow(pr.id)).authorizationId}`);
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'voided']);
    expect(github.comments.at(-1)).toContain('released in full');
    expect(github.lastCheck?.title).toBe('Hold released');
  });

  it('voids once when the review repeats', async () => {
    const pr = await placedHold();
    await onPullRequestReview(deps, review());
    await onPullRequestReview(deps, review());
    expect(paypal.calls.filter((c) => c.startsWith('void'))).toHaveLength(1);
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'voided']);
  });

  it.each([
    ['the author', 'new-person', 'User'],
    ['someone without write access', 'passer-by', 'User'],
    ['a review bot', 'maintainer', 'Bot'],
  ])('ignores a review from %s', async (_who, login, type) => {
    const pr = await placedHold();
    await onPullRequestReview(deps, review(login, 'Great work', type));
    expect((await holdRow(pr.id)).state).toBe('held');
    expect(paypal.calls.some((c) => c.startsWith('void'))).toBe(false);
  });

  it('releases on merge and on a plain close', async () => {
    const pr = await placedHold();
    await onPullRequest(deps, prEvent('closed', true));
    expect((await holdRow(pr.id)).state).toBe('voided');
    expect(github.comments.at(-1)).toContain('merged');
  });

  it('releases when a maintainer vouches after the hold', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!vouch'));
    expect((await holdRow(pr.id)).state).toBe('voided');
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'voided']);
  });

  it('treats !forfeit in a review body as the forfeit and not as a review', async () => {
    const pr = await placedHold();
    await onPullRequestReview(deps, review('maintainer', '!forfeit generated spam'));
    expect((await holdRow(pr.id)).state).toBe('forfeit_pending');
    expect(paypal.calls.some((c) => c.startsWith('void'))).toBe(false);
  });

  it('keeps the hold when a review body has a broken command', async () => {
    const pr = await placedHold();
    await onPullRequestReview(deps, review('maintainer', '!forfeit'));
    expect((await holdRow(pr.id)).state).toBe('held');
    expect(github.comments.at(-1)).toContain('needs a reason');
  });
});

describe('a forfeit', () => {
  it('closes the pull request in the same comment', async () => {
    await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    expect(github.closed).toEqual([1]);
    expect(github.comments.at(-1)).toContain('closed this pull request');
  });

  it('keeps the forfeit open when that close comes back from GitHub', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    await onPullRequest(deps, prEvent('closed'));
    expect((await holdRow(pr.id)).state).toBe('forfeit_pending');
    expect(paypal.calls.some((c) => c.startsWith('void'))).toBe(false);
  });

  it('moves no money until the appeal window closes', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    const row = await holdRow(pr.id);
    expect(row).toMatchObject({ state: 'forfeit_pending', forfeitedBy: 'maintainer', forfeitReason: 'copied spam' });
    expect(paypal.calls.some((c) => c.startsWith('capture'))).toBe(false);
    await runDue(hold, new Date(row.appealEndsAt!.getTime() - 1000));
    expect(paypal.calls.some((c) => c.startsWith('capture'))).toBe(false);
    expect(github.comments.at(-1)).toContain('!appeal');
  });

  it('captures once the window closes, and never twice', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    const after = new Date((await holdRow(pr.id)).appealEndsAt!.getTime() + 1000);
    await runDue(hold, after);
    await runDue(hold, after);
    const row = await holdRow(pr.id);
    expect(row.state).toBe('captured');
    expect(row.captureId).toMatch(/^CAP-/);
    expect(paypal.calls.filter((c) => c.startsWith('capture'))).toHaveLength(1);
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'forfeit_opened', 'captured']);
  });

  it('never captures a hold nobody forfeited', async () => {
    const pr = await placedHold();
    await runDue(hold, new Date(Date.now() + 27 * DAY));
    expect((await holdRow(pr.id)).state).toBe('held');
    expect(paypal.calls.some((c) => c.startsWith('capture'))).toBe(false);
  });

  it('voids a forgotten hold before PayPal would expire it', async () => {
    const pr = await placedHold();
    await runDue(hold, new Date(Date.now() + 29 * DAY));
    expect((await holdRow(pr.id)).state).toBe('voided');
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'voided']);
  });

  it('refuses a forfeit from someone without write access', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit no reason at all', 'passer-by'));
    expect((await holdRow(pr.id)).state).toBe('held');
    expect(github.comments.at(-1)).toContain('only a maintainer');
  });

  it('refuses a forfeit after the hold was released', async () => {
    const pr = await placedHold();
    await onPullRequestReview(deps, review());
    await onIssueComment(deps, say('!forfeit too late'));
    expect((await holdRow(pr.id)).state).toBe('voided');
    expect(github.comments.at(-1)).toContain('nothing changed');
  });

  it('reports a pull request with no hold', async () => {
    await waitingPr();
    await onIssueComment(deps, say('!forfeit nothing to take'));
    expect(github.comments.at(-1)).toContain('no hold');
  });

  it('leaves the hold open when PayPal refuses the capture, and stops retrying', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    const after = new Date((await holdRow(pr.id)).appealEndsAt!.getTime() + 1000);
    paypal.captureError = new PayPalError('capture', 422, 'AUTHORIZATION_EXPIRED', 'debug');
    await runDue(hold, after);
    await runDue(hold, after);
    const row = await holdRow(pr.id);
    expect(row.state).toBe('forfeit_pending');
    expect(row.appealEndsAt).toBeNull();
    expect(paypal.calls.filter((c) => c.startsWith('capture'))).toHaveLength(1);
    expect(github.comments.at(-1)).toContain('no money moved');
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'forfeit_opened']);
  });

  it('retries with the same request ID when PayPal has an outage', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    const after = new Date((await holdRow(pr.id)).appealEndsAt!.getTime() + 1000);
    paypal.captureError = new PayPalError('capture', 503, undefined, 'debug');
    await runDue(hold, after);
    expect((await holdRow(pr.id)).appealEndsAt).not.toBeNull();
    paypal.captureError = null;
    await runDue(hold, after);
    expect((await holdRow(pr.id)).state).toBe('captured');
    const ids = paypal.requestIds.filter((id) => id.includes('-capture-'));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('reauthorizes first when the hold is past the honor period', async () => {
    const pr = await placedHold();
    await db.update(holds).set({ authorizedAt: new Date(Date.now() - 5 * DAY) }).where(eq(holds.pullRequestId, pr.id));
    await onIssueComment(deps, say('!forfeit copied spam'));
    const row = await holdRow(pr.id);
    await runDue(hold, new Date(row.appealEndsAt!.getTime() + 1000));
    const authorization = row.authorizationId!;
    expect(paypal.calls.slice(-2)).toEqual([`reauthorize ${authorization}`, `capture RE-${authorization}`]);
    expect((await holdRow(pr.id)).authorizationId).toBe(`RE-${authorization}`);
  });
});

describe('an appeal', () => {
  it('blocks the capture until a maintainer answers', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    const ends = (await holdRow(pr.id)).appealEndsAt!;
    await onIssueComment(deps, say('!appeal I wrote this myself', 'new-person'));
    expect(await holdRow(pr.id)).toMatchObject({ state: 'appealed', appealReason: 'I wrote this myself' });
    await runDue(hold, new Date(ends.getTime() + 1000));
    expect(paypal.calls.some((c) => c.startsWith('capture'))).toBe(false);
  });

  it('refuses an appeal from anyone but the hold owner', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    await onIssueComment(deps, say('!appeal not mine', 'passer-by'));
    expect((await holdRow(pr.id)).state).toBe('forfeit_pending');
  });

  it('releases on !release', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    await onIssueComment(deps, say('!appeal I wrote this myself', 'new-person'));
    await onIssueComment(deps, say('!release'));
    expect((await holdRow(pr.id)).state).toBe('voided');
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'forfeit_opened', 'appealed', 'voided']);
  });

  it('captures at once on !uphold, and !reverse refunds it', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    await onIssueComment(deps, say('!appeal I wrote this myself', 'new-person'));
    await onIssueComment(deps, say('!uphold'));
    expect((await holdRow(pr.id)).state).toBe('captured');
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'forfeit_opened', 'appealed', 'forfeit_opened', 'captured']);

    await onIssueComment(deps, say('!reverse the appeal was right'));
    const row = await holdRow(pr.id);
    expect(row.state).toBe('refunded');
    expect(row.refundId).toMatch(/^REF-/);
    expect(github.lastCheck?.title).toBe('Capture refunded');
  });
});

const event = (type: string, resource: PayPalEvent['resource']): PayPalEvent => ({ id: `WH-${Math.random()}`, event_type: type, resource });

describe('PayPal webhooks', () => {
  it('confirms this app\'s own void on the ledger row without a second one', async () => {
    const pr = await placedHold();
    await onPullRequestReview(deps, review());
    const row = await holdRow(pr.id);
    await onPayPalEvent(hold, event('PAYMENT.AUTHORIZATION.VOIDED', { id: row.authorizationId! }));
    const rows = await db.select().from(ledgerEvents).where(and(eq(ledgerEvents.pullRequestId, pr.id), eq(ledgerEvents.kind, 'voided')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reconciledAt).not.toBeNull();
  });

  it('treats a capture webhook that beats the save as this app\'s own capture', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    await db.update(holds).set({ appealEndsAt: new Date(Date.now() - 1000) }).where(eq(holds.pullRequestId, pr.id));
    const row = await holdRow(pr.id);
    await onPayPalEvent(hold, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-EARLY', supplementary_data: { related_ids: { authorization_id: row.authorizationId! } } }));
    const after = await holdRow(pr.id);
    expect(after).toMatchObject({ state: 'captured', captureId: 'CAP-EARLY' });
    expect(after.capturedAt).not.toBeNull();
    expect(github.comments.at(-1)).not.toContain('outside this app');
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'forfeit_opened', 'captured']);
  });

  it('treats a void PayPal says already happened as done', async () => {
    const pr = await placedHold();
    paypal.voidError = new PayPalError('void', 422, 'PREVIOUSLY_VOIDED', 'debug');
    await onPullRequestReview(deps, review());
    expect((await holdRow(pr.id)).state).toBe('voided');
  });

  it('records a void made on the PayPal dashboard', async () => {
    const pr = await placedHold();
    const row = await holdRow(pr.id);
    await onPayPalEvent(hold, event('PAYMENT.AUTHORIZATION.VOIDED', { id: row.authorizationId! }));
    expect((await holdRow(pr.id)).state).toBe('voided');
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'voided']);
    expect(github.comments.at(-1)).toContain('outside this app');
    expect(paypal.calls.some((c) => c.startsWith('void'))).toBe(false);
  });

  it('moves a captured hold to refunded when PayPal reports a refund', async () => {
    const pr = await placedHold();
    await onIssueComment(deps, say('!forfeit copied spam'));
    await runDue(hold, new Date((await holdRow(pr.id)).appealEndsAt!.getTime() + 1000));
    const captureId = (await holdRow(pr.id)).captureId!;
    await onPayPalEvent(
      hold,
      event('PAYMENT.CAPTURE.REFUNDED', { id: 'REFUND-1', links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] }),
    );
    expect(await holdRow(pr.id)).toMatchObject({ state: 'refunded', refundId: 'REFUND-1' });
    expect(github.lastCheck?.title).toBe('Capture refunded');
  });

  it('ignores an event for a hold it does not know', async () => {
    await placedHold();
    await expect(onPayPalEvent(hold, event('PAYMENT.AUTHORIZATION.VOIDED', { id: 'SOMEONE-ELSE' }))).resolves.toBeUndefined();
    expect(github.comments.at(-1)).not.toContain('outside this app');
  });

  it('confirms the held row when PayPal reports the authorization', async () => {
    const pr = await placedHold();
    await onPayPalEvent(hold, event('PAYMENT.AUTHORIZATION.CREATED', { id: (await holdRow(pr.id)).authorizationId! }));
    expect((await holdRow(pr.id)).state).toBe('held');
    const rows = await db.select().from(ledgerEvents).where(eq(ledgerEvents.pullRequestId, pr.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reconciledAt).not.toBeNull();
  });

  it('ignores event types it does not act on', async () => {
    const pr = await placedHold();
    await onPayPalEvent(hold, event('PAYMENT.CAPTURE.PENDING', { id: (await holdRow(pr.id)).authorizationId! }));
    expect((await holdRow(pr.id)).state).toBe('held');
  });
});

async function capturedHold(receiver: string | null = 'project@example.com') {
  const pr = await placedHold();
  await db.update(projects).set({ payoutReceiver: receiver }).where(eq(projects.id, pr.projectId));
  await onIssueComment(deps, say('!forfeit copied spam'));
  const ends = (await holdRow(pr.id)).appealEndsAt!;
  await runDue(hold, new Date(ends.getTime() + 1000));
  return { pr, capturedAt: (await holdRow(pr.id)).capturedAt! };
}

describe('a payout', () => {
  it('waits out the reversal window, then pays the project once', async () => {
    const { pr, capturedAt } = await capturedHold();
    await runDue(hold, new Date(capturedAt.getTime() + DAY - 1000));
    expect(paypal.payouts).toEqual([]);

    const after = new Date(capturedAt.getTime() + DAY + 1000);
    await runDue(hold, after);
    await runDue(hold, after);
    expect(paypal.payouts).toHaveLength(1);
    expect(paypal.payouts[0]).toMatchObject({ cents: 500, receiver: 'project@example.com' });
    const row = await holdRow(pr.id);
    expect(row.state).toBe('paid_out');
    expect(await ledgerKinds(pr.id)).toEqual(['held', 'forfeit_opened', 'captured', 'paid_out']);
    expect(github.lastCheck?.title).toBe('Paid out to the project');
  });

  it('never pays out a capture reversed in the window', async () => {
    const { pr, capturedAt } = await capturedHold();
    await onIssueComment(deps, say('!reverse the appeal was right'));
    await runDue(hold, new Date(capturedAt.getTime() + 2 * DAY));
    expect(paypal.payouts).toEqual([]);
    expect((await holdRow(pr.id)).state).toBe('refunded');
  });

  it('refuses a reversal after the payout', async () => {
    const { pr, capturedAt } = await capturedHold();
    await runDue(hold, new Date(capturedAt.getTime() + DAY + 1000));
    await onIssueComment(deps, say('!reverse too late'));
    expect((await holdRow(pr.id)).state).toBe('paid_out');
    expect(paypal.calls.some((c) => c.startsWith('refund'))).toBe(false);
    expect(github.comments.at(-1)).toContain('nothing changed');
  });

  it('holds the money when no receiver is set', async () => {
    const { pr, capturedAt } = await capturedHold(null);
    await runDue(hold, new Date(capturedAt.getTime() + 2 * DAY));
    expect(paypal.payouts).toEqual([]);
    expect((await holdRow(pr.id)).state).toBe('captured');
  });

  it('stops retrying and says so when PayPal refuses the payout', async () => {
    const { pr, capturedAt } = await capturedHold();
    paypal.payoutError = new PayPalError('payout', 422, 'RECEIVER_UNREGISTERED', 'debug');
    const after = new Date(capturedAt.getTime() + DAY + 1000);
    await runDue(hold, after);
    await runDue(hold, after);
    expect(paypal.calls.filter((c) => c.startsWith('payout'))).toHaveLength(1);
    expect((await holdRow(pr.id)).state).toBe('captured');
    expect(github.comments.at(-1)).toContain('could not pay out');
  });

  it('confirms the row on the success webhook and reports a failure', async () => {
    const { pr, capturedAt } = await capturedHold();
    await runDue(hold, new Date(capturedAt.getTime() + DAY + 1000));
    const batch = (await holdRow(pr.id)).payoutBatchId!;
    await onPayPalEvent(hold, event('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', { payout_batch_id: batch }));
    const [row] = await db.select().from(ledgerEvents).where(and(eq(ledgerEvents.pullRequestId, pr.id), eq(ledgerEvents.kind, 'paid_out')));
    expect(row!.reconciledAt).not.toBeNull();

    await onPayPalEvent(hold, event('PAYMENT.PAYOUTS-ITEM.UNCLAIMED', { payout_batch_id: batch }));
    expect(github.comments.at(-1)).toContain('could not pay out');
  });
});

describe('Transaction Search', () => {
  it('marks only what PayPal lists', async () => {
    const { pr } = await capturedHold();
    const captureId = (await holdRow(pr.id)).captureId!;
    await reconcile(hold);
    const before = await db.select().from(ledgerEvents).where(eq(ledgerEvents.kind, 'captured'));
    expect(before[0]!.searchedAt).toBeNull();

    paypal.searchResults = [captureId];
    await reconcile(hold);
    const after = await db.select().from(ledgerEvents).where(eq(ledgerEvents.kind, 'captured'));
    expect(after[0]!.searchedAt).not.toBeNull();
  });
});

describe('a new commit', () => {
  it('keeps the hold state on the new check', async () => {
    await placedHold();
    await onPullRequest(deps, prEvent('synchronize'));
    expect(github.lastCheck?.title).toBe('Refundable hold placed');
  });
});
