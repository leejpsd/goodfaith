import { createSign } from 'node:crypto';
import { linkedIssueNumber, type OpenTimeFacts } from '@/lib/triage/triage';

const API = 'https://api.github.com';

export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';
export type CheckState =
  | { status: 'in_progress'; title: string; summary: string }
  | { status: 'completed'; conclusion: 'success' | 'failure' | 'neutral'; title: string; summary: string };

// What the gate needs from GitHub. Tests replace this with a fake.
export interface GitHub {
  vouchFile(owner: string, repo: string): Promise<string | null>;
  settingsFile(owner: string, repo: string): Promise<string | null>;
  permission(owner: string, repo: string, login: string): Promise<Permission>;
  comment(owner: string, repo: string, number: number, body: string): Promise<number>;
  createCheck(owner: string, repo: string, sha: string, state: CheckState): Promise<number>;
  updateCheck(owner: string, repo: string, id: number, state: CheckState): Promise<void>;
  closePullRequest(owner: string, repo: string, number: number): Promise<void>;
  addLabel(owner: string, repo: string, number: number, label: string): Promise<void>;
  removeLabel(owner: string, repo: string, number: number, label: string): Promise<void>;
  prFacts(owner: string, repo: string, number: number, login: string): Promise<OpenTimeFacts>;
}

const base64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

export function appJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // GitHub allows ten minutes, and the backdated start absorbs clock drift.
  const body = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${base64url(signature)}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const tokens = new Map<number, { token: string; expiresAt: number }>();

async function installationToken(installationId: number): Promise<string> {
  const cached = tokens.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const pem = Buffer.from(required('GITHUB_APP_PRIVATE_KEY_B64'), 'base64').toString();
  const r = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appJwt(required('GITHUB_APP_ID'), pem)}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GitHub refused an installation token: ${r.status}`);
  const j = (await r.json()) as { token: string; expires_at: string };
  tokens.set(installationId, { token: j.token, expiresAt: Date.parse(j.expires_at) });
  return j.token;
}

export function githubFor(installationId: number): GitHub {
  async function call(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json') {
    return fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await installationToken(installationId)}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  }
  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await call(method, path, body);
    if (!r.ok) throw new Error(`GitHub ${method} ${path} returned ${r.status}`);
    return (await r.json()) as T;
  }
  async function rawFile(owner: string, repo: string, path: string): Promise<string | null> {
    const r = await call('GET', `/repos/${owner}/${repo}/contents/${path}`, undefined, 'application/vnd.github.raw+json');
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${path} returned ${r.status}`);
    return r.text();
  }
  const checkBody = (state: CheckState) => ({
    status: state.status,
    ...(state.status === 'completed' ? { conclusion: state.conclusion } : {}),
    output: { title: state.title, summary: state.summary },
  });

  return {
    vouchFile: (owner, repo) => rawFile(owner, repo, '.github/VOUCHED.td'),
    settingsFile: (owner, repo) => rawFile(owner, repo, '.github/goodfaith.json'),
    async permission(owner, repo, login) {
      const j = await json<{ permission: Permission }>('GET', `/repos/${owner}/${repo}/collaborators/${login}/permission`);
      return j.permission;
    },
    async comment(owner, repo, number, body) {
      return (await json<{ id: number }>('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body })).id;
    },
    async createCheck(owner, repo, sha, state) {
      return (await json<{ id: number }>('POST', `/repos/${owner}/${repo}/check-runs`, { name: 'Goodfaith gate', head_sha: sha, ...checkBody(state) })).id;
    },
    async updateCheck(owner, repo, id, state) {
      await json('PATCH', `/repos/${owner}/${repo}/check-runs/${id}`, checkBody(state));
    },
    async closePullRequest(owner, repo, number) {
      await json('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { state: 'closed' });
    },
    async addLabel(owner, repo, number, label) {
      await json('POST', `/repos/${owner}/${repo}/issues/${number}/labels`, { labels: [label] });
    },
    async removeLabel(owner, repo, number, label) {
      const r = await call('DELETE', `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
      // Already gone is the wanted result.
      if (!r.ok && r.status !== 404) throw new Error(`GitHub remove label returned ${r.status}`);
    },
    async prFacts(owner, repo, number, login) {
      const pr = await json<{ title: string; body: string | null }>('GET', `/repos/${owner}/${repo}/pulls/${number}`);
      const files = await json<{ filename: string; additions: number; deletions: number; patch?: string }[]>('GET', `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`);
      const account = await json<{ created_at: string }>('GET', `/users/${login}`);
      const merges = await json<{ total_count: number }>('GET', `/search/issues?q=${encodeURIComponent(`is:pr is:merged author:${login}`)}&per_page=1`);
      const description = pr.body ?? '';
      const issueNumber = linkedIssueNumber(description);
      const issue = issueNumber ? await call('GET', `/repos/${owner}/${repo}/issues/${issueNumber}`) : null;
      const linked = issue?.ok ? ((await issue.json()) as { title: string; body: string | null }) : null;
      return {
        title: pr.title,
        description,
        files: files.map(({ filename, additions, deletions, patch }) => ({ filename, additions, deletions, patch })),
        linkedIssue: linked && { title: linked.title, body: linked.body ?? '' },
        accountAgeDays: Math.floor((Date.now() - Date.parse(account.created_at)) / 864e5),
        earlierPublicMerges: merges.total_count,
      };
    },
  };
}
