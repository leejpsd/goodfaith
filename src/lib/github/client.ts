import { createSign } from 'node:crypto';

const API = 'https://api.github.com';

export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';
export type CheckState =
  | { status: 'in_progress'; title: string; summary: string }
  | { status: 'completed'; conclusion: 'success' | 'failure' | 'neutral'; title: string; summary: string };

// What the gate needs from GitHub. Tests replace this with a fake.
export interface GitHub {
  vouchFile(owner: string, repo: string): Promise<string | null>;
  permission(owner: string, repo: string, login: string): Promise<Permission>;
  comment(owner: string, repo: string, number: number, body: string): Promise<number>;
  createCheck(owner: string, repo: string, sha: string, state: CheckState): Promise<number>;
  updateCheck(owner: string, repo: string, id: number, state: CheckState): Promise<void>;
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
  const checkBody = (state: CheckState) => ({
    status: state.status,
    ...(state.status === 'completed' ? { conclusion: state.conclusion } : {}),
    output: { title: state.title, summary: state.summary },
  });

  return {
    async vouchFile(owner, repo) {
      const r = await call('GET', `/repos/${owner}/${repo}/contents/.github/VOUCHED.td`, undefined, 'application/vnd.github.raw+json');
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GitHub vouch file returned ${r.status}`);
      return r.text();
    },
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
  };
}
