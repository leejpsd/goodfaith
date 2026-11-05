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
  voidAuthorization = this.fail;
  reauthorize = this.fail;
  capture = this.fail;
  refund = this.fail;
  verifyWebhook = this.fail;
}

let github: FakeGitHub;
let deps: Deps;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(() => {
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

  it('records a merge and a close', async () => {
    await onPullRequest(deps, prEvent());
    await onPullRequest(deps, prEvent({ merged: true }, 'closed'));
    expect(await prRow()).toMatchObject({ status: 'merged' });
    await onPullRequest(deps, prEvent({ number: 2 }));
    await onPullRequest(deps, prEvent({ number: 2, merged: false }, 'closed'));
    expect(await prRow(2)).toMatchObject({ status: 'closed' });
  });
});
