import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerEvents, pullRequests, vouches } from '@/db/schema';
import * as schema from '@/db/schema';
import type { CheckState, GitHub, Permission } from '@/lib/github/client';
import type { IssueCommentEvent, PullRequestEvent } from '@/lib/github/webhook';
import type { PayPal } from '@/lib/paypal/client';
import { onIssueComment, onPullRequest, type Deps } from './gate-flow';

const db = drizzle(new PGlite(), { schema });
let repoCounter = 0;
let repo = '';

class FakeGitHub implements GitHub {
  comments: string[] = [];
  checks = new Map<number, CheckState>();
  permissions: Record<string, Permission> = { maintainer: 'write' };
  file: string | null = null;
  next = 100;
  prFacts = async (): Promise<never> => {
    throw new Error('not used here');
  };
  settingsFile = async (): Promise<string | null> => null;
  isPrivate = async () => false;
  vouchFile = async () => this.file;
  permission = async (_o: string, _r: string, login: string) => this.permissions[login] ?? 'none';
  comment = async (_o: string, _r: string, _n: number, body: string) => {
    this.comments.push(body);
    return this.next++;
  };
  createCheck = async (_o: string, _r: string, _s: string, state: CheckState) => {
    const id = this.next++;
    this.checks.set(id, state);
    return id;
  };
  closed: number[] = [];
  labels: string[] = [];
  addLabel = async (_o: string, _r: string, _n: number, label: string) => {
    this.labels.push(`add ${label}`);
  };
  removeLabel = async (_o: string, _r: string, _n: number, label: string) => {
    this.labels.push(`remove ${label}`);
  };
  closePullRequest = async (_o: string, _r: string, number: number) => {
    this.closed.push(number);
  };
  updateCheck = async (_o: string, _r: string, id: number, state: CheckState) => {
    this.checks.set(id, state);
  };
}

// Nothing in this file has a hold, so no path here may reach PayPal.
class UnusedPayPal implements PayPal {
  private fail = async (): Promise<never> => {
    throw new Error('PayPal must not be called here');
  };
  createOrder = this.fail;
  authorizeOrder = this.fail;
  findAuthorization = this.fail;
  voidAuthorization = this.fail;
  reauthorize = this.fail;
  capture = this.fail;
  refund = this.fail;
  verifyWebhook = this.fail;
  payout = this.fail;
  searchTransactions = this.fail;
}

let github: FakeGitHub;
let deps: Deps;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
  // Earned trust reads merges at other projects, so merges from earlier tests must not linger.
  await db.update(pullRequests).set({ status: 'closed' }).where(eq(pullRequests.status, 'merged'));
  github = new FakeGitHub();
  deps = { db, github, paypal: new UnusedPayPal(), appUrl: 'https://app.test' };
  repo = `repo-${++repoCounter}`;
});

function prEvent(over: Partial<PullRequestEvent['pull_request']> & { number?: number } = {}, action = 'opened'): PullRequestEvent {
  return {
    action,
    installation: { id: 1 },
    repository: { name: repo, owner: { login: 'owner' } },
    pull_request: {
      number: 1,
      title: 'Fix a bug',
      html_url: 'https://github.com/owner/repo/pull/1',
      merged: false,
      head: { sha: 'sha1' },
      author_association: 'FIRST_TIME_CONTRIBUTOR',
      user: { login: 'new-person', type: 'User' },
      ...over,
    },
  };
}

function commentEvent(body: string, login = 'maintainer', over: Partial<IssueCommentEvent> = {}): IssueCommentEvent {
  return {
    action: 'created',
    installation: { id: 1 },
    repository: { name: repo, owner: { login: 'owner' } },
    issue: { number: 1, pull_request: {} },
    comment: { body, user: { login, type: 'User' } },
    ...over,
  };
}

async function prRow(number = 1) {
  const rows = await db.select({ pr: pullRequests }).from(pullRequests).innerJoin(schema.projects, eq(pullRequests.projectId, schema.projects.id)).where(and(eq(schema.projects.repo, repo), eq(pullRequests.number, number)));
  return rows[0]?.pr;
}

const onlyCheck = () => [...github.checks.values()].at(-1);

describe('a newcomer opens a pull request', () => {
  it('waits, with a pending check and a comment that offers the vouch first', async () => {
    await onPullRequest(deps, prEvent());
    const pr = await prRow();
    expect(pr).toMatchObject({ door: 'choose', status: 'waiting' });
    expect(onlyCheck()).toMatchObject({ status: 'in_progress' });
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.indexOf('vouch')).toBeLessThan(github.comments[0]!.indexOf('hold'));
    expect(github.comments[0]).toContain(`https://app.test/hold/${pr!.id}`);
  });

  it('does nothing twice when the event repeats', async () => {
    await onPullRequest(deps, prEvent());
    await onPullRequest(deps, prEvent());
    expect(github.comments).toHaveLength(1);
    expect(github.checks.size).toBe(1);
  });
});

describe('doors that skip the gate', () => {
  it('passes a past contributor with no comment', async () => {
    await onPullRequest(deps, prEvent({ author_association: 'CONTRIBUTOR' }));
    expect(await prRow()).toMatchObject({ door: 'known', status: 'in_review' });
    expect(github.comments).toHaveLength(0);
    expect(onlyCheck()).toMatchObject({ conclusion: 'success' });
  });

  it('passes a bot', async () => {
    await onPullRequest(deps, prEvent({ user: { login: 'dep-bot[bot]', type: 'Bot' }, author_association: 'NONE' }));
    expect(await prRow()).toMatchObject({ door: 'known' });
  });

  it('honors VOUCHED.td', async () => {
    github.file = '# list\nnew-person\n';
    await onPullRequest(deps, prEvent());
    expect(await prRow()).toMatchObject({ door: 'known', status: 'in_review' });
  });

  it('lets in an author whose gated pull request was merged at another project', async () => {
    const person = { login: 'returning-person', type: 'User' };
    await onPullRequest(deps, prEvent({ user: person }));
    await onPullRequest(deps, prEvent({ user: person, merged: true }, 'closed'));
    const first = repo;
    repo = `${first}-next`;
    github = new FakeGitHub();
    deps = { ...deps, github };
    await onPullRequest(deps, prEvent({ user: person }));
    expect(await prRow()).toMatchObject({ door: 'known', status: 'in_review' });
    expect(onlyCheck()).toMatchObject({ title: 'Trusted from another project' });
    expect(github.comments[0]).toContain(`owner/${first}#1 went through Goodfaith there and was merged`);
    const rows = await db.select().from(ledgerEvents).where(eq(ledgerEvents.actor, 'goodfaith'));
    expect(rows.at(-1)).toMatchObject({ kind: 'vouched', cents: 0, note: `earned: owner/${first}#1 was merged` });
  });

  it('keeps the gate where a project turns earned trust off', async () => {
    const person = { login: 'returning-elsewhere', type: 'User' };
    await onPullRequest(deps, prEvent({ user: person }));
    await onPullRequest(deps, prEvent({ user: person, merged: true }, 'closed'));
    repo = `${repo}-strict`;
    github = new FakeGitHub();
    github.settingsFile = async () => '{"trust_earned_elsewhere":false}';
    deps = { ...deps, github };
    await onPullRequest(deps, prEvent({ user: person }));
    expect(await prRow()).toMatchObject({ door: 'choose', status: 'waiting' });
  });

  it('blocks a denounced author and offers no hold', async () => {
    github.file = '-new-person\n';
    await onPullRequest(deps, prEvent());
    expect(await prRow()).toMatchObject({ door: 'closed', status: 'blocked' });
    expect(onlyCheck()).toMatchObject({ conclusion: 'failure' });
    expect(github.comments[0]).not.toContain('/hold/');
  });
});

describe('a maintainer vouches', () => {
  it('moves the pull request into review with a $0 ledger row and no money', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('Looks real.\n\n!vouch'));
    const pr = await prRow();
    expect(pr).toMatchObject({ status: 'in_review' });
    expect(onlyCheck()).toMatchObject({ conclusion: 'success', title: 'Vouched by a maintainer' });
    const rows = await db.select().from(ledgerEvents).where(eq(ledgerEvents.pullRequestId, pr!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'vouched', cents: 0, actor: 'maintainer', paypalId: null });
    expect(github.comments.at(-1)).toContain('no money was involved');
  });

  it('adds no second ledger row when repeated', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!vouch'));
    await onIssueComment(deps, commentEvent('!vouch'));
    const pr = await prRow();
    expect(await db.select().from(ledgerEvents).where(eq(ledgerEvents.pullRequestId, pr!.id))).toHaveLength(1);
  });

  it('lets a vouched person skip the gate next time', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!vouch'));
    const before = github.comments.length;
    await onPullRequest(deps, prEvent({ number: 2, html_url: 'https://github.com/owner/repo/pull/2' }));
    expect(await prRow(2)).toMatchObject({ door: 'known', status: 'in_review' });
    expect(github.comments).toHaveLength(before);
  });

  it('records a vouch for someone else without moving this pull request', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!vouch @other-person'));
    expect(await prRow()).toMatchObject({ status: 'waiting' });
    const pr = await prRow();
    const rows = await db.select().from(vouches).where(eq(vouches.projectId, pr!.projectId));
    expect(rows.map((r) => r.login)).toEqual(['other-person']);
  });
});

describe('the waiting label', () => {
  it('goes on at the gate and comes off with a vouch', async () => {
    await onPullRequest(deps, prEvent());
    expect(github.labels).toEqual(['add waiting for vouch or hold']);
    await onIssueComment(deps, commentEvent('!vouch'));
    expect(github.labels).toEqual(['add waiting for vouch or hold', 'remove waiting for vouch or hold']);
  });

  it('never goes on for a known contributor', async () => {
    await onPullRequest(deps, prEvent({ author_association: 'CONTRIBUTOR' }));
    expect(github.labels).toEqual([]);
  });
});

describe('a maintainer removes a vouch', () => {
  it('sends the next pull request through the gate and leaves this one in review', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!vouch'));
    await onIssueComment(deps, commentEvent('!unvouch'));
    expect(github.comments.at(-1)).toContain('removed the vouch');
    expect((await prRow())?.status).toBe('in_review');

    await onPullRequest(deps, prEvent({ number: 2 }));
    expect((await prRow(2))?.status).toBe('waiting');
  });

  it('refuses anyone without write access', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!vouch'));
    await onIssueComment(deps, commentEvent('!unvouch', 'new-person'));
    expect(github.comments.at(-1)).toContain('only a maintainer');
  });

  it('says so when there is nothing to remove', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!unvouch someone-else'));
    expect(github.comments.at(-1)).toContain('no vouch');
  });
});

describe('who may not vouch', () => {
  it('refuses the author vouching for themselves', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!vouch', 'new-person'));
    expect(await prRow()).toMatchObject({ status: 'waiting' });
    expect(github.comments.at(-1)).toContain('only a maintainer');
  });

  it('refuses read and triage access', async () => {
    github.permissions = { reader: 'read', triager: 'triage' };
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!vouch', 'reader'));
    await onIssueComment(deps, commentEvent('!vouch', 'triager'));
    expect(await prRow()).toMatchObject({ status: 'waiting' });
  });

  it('ignores bots, quoted commands and non pull request issues', async () => {
    await onPullRequest(deps, prEvent());
    const before = github.comments.length;
    await onIssueComment(deps, commentEvent('!vouch', 'maintainer', { comment: { body: '!vouch', user: { login: 'maintainer', type: 'Bot' } } }));
    await onIssueComment(deps, commentEvent('> !vouch'));
    await onIssueComment(deps, commentEvent('!vouch', 'maintainer', { issue: { number: 1 } }));
    expect(await prRow()).toMatchObject({ status: 'waiting' });
    expect(github.comments).toHaveLength(before);
  });

  it('ignores an edited comment', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!vouch', 'maintainer', { action: 'edited' }));
    expect(await prRow()).toMatchObject({ status: 'waiting' });
  });
});

describe('project settings', () => {
  it('reads the bounds from the repo when a pull request opens', async () => {
    github.settingsFile = async () => '{"min_cents":300,"max_cents":900,"default_cents":600,"appeal_days":2}';
    await onPullRequest(deps, prEvent());
    expect(github.comments[0]).toContain('$3.00 to $9.00');
  });

  it('keeps the defaults when the file is broken', async () => {
    github.settingsFile = async () => '{ not json';
    await onPullRequest(deps, prEvent());
    expect(github.comments[0]).toContain('$2.00 to $25.00');
  });
});

describe('later events', () => {
  it('adds a pending check to a new commit while waiting', async () => {
    await onPullRequest(deps, prEvent());
    await onPullRequest(deps, prEvent({ head: { sha: 'sha2' } }, 'synchronize'));
    expect(await prRow()).toMatchObject({ headSha: 'sha2', status: 'waiting' });
    expect(onlyCheck()).toMatchObject({ status: 'in_progress' });
    expect(github.checks.size).toBe(2);
  });

  it('keeps a vouched pull request green on a new commit', async () => {
    await onPullRequest(deps, prEvent());
    await onIssueComment(deps, commentEvent('!vouch'));
    await onPullRequest(deps, prEvent({ head: { sha: 'sha2' } }, 'synchronize'));
    expect(onlyCheck()).toMatchObject({ conclusion: 'success' });
  });

  it('keeps a known contributor and a vouched author in review when reopened', async () => {
    await onPullRequest(deps, prEvent({ author_association: 'CONTRIBUTOR' }));
    await onPullRequest(deps, prEvent({ author_association: 'CONTRIBUTOR' }, 'closed'));
    await onPullRequest(deps, prEvent({ author_association: 'CONTRIBUTOR' }, 'reopened'));
    expect(await prRow()).toMatchObject({ status: 'in_review' });
    await onPullRequest(deps, prEvent({ number: 2 }));
    await onIssueComment(deps, commentEvent('!vouch', 'maintainer', { issue: { number: 2, pull_request: {} } }));
    await onPullRequest(deps, prEvent({ number: 2 }, 'closed'));
    await onPullRequest(deps, prEvent({ number: 2 }, 'reopened'));
    expect(await prRow(2)).toMatchObject({ status: 'in_review' });
    expect(onlyCheck()).toMatchObject({ conclusion: 'success' });
  });

  it('records a merge and a close', async () => {
    await onPullRequest(deps, prEvent());
    await onPullRequest(deps, prEvent({ merged: true }, 'closed'));
    expect(await prRow()).toMatchObject({ status: 'merged' });
    await onPullRequest(deps, prEvent({ number: 2 }));
    await onPullRequest(deps, prEvent({ number: 2, merged: false }, 'closed'));
    expect(await prRow(2)).toMatchObject({ status: 'closed' });
  });
});
