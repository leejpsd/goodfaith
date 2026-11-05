import { linkedIssueNumber, type OpenTimeFacts } from '@/lib/triage/triage';
import type { ListedPull } from './replay';

// Reads public data with the demo's read token. Nothing in this file can write to GitHub: it only
// makes GET requests, plus one read-only GraphQL search.
const API = 'https://api.github.com';

function token(): string {
  const value = process.env.DEMO_CONTRIBUTOR_TOKEN;
  if (!value) throw new Error('DEMO_CONTRIBUTOR_TOKEN is not set');
  return value;
}

const headers = () => ({ Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });

async function get<T>(path: string): Promise<{ status: number; json: T | null }> {
  const r = await fetch(`${API}${path}`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
  return { status: r.status, json: r.ok ? ((await r.json()) as T) : null };
}

export async function isPublicRepo(repo: string): Promise<boolean> {
  const { json } = await get<{ private: boolean }>(`/repos/${repo}`);
  return json !== null && !json.private;
}

interface ApiPull {
  number: number;
  title: string;
  html_url: string;
  user: { login: string; type: string } | null;
  author_association: string;
  created_at: string;
  state: string;
  merged_at: string | null;
}

export async function listRecentPulls(repo: string): Promise<ListedPull[]> {
  const { json } = await get<ApiPull[]>(`/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`);
  return (json ?? []).flatMap((pull) =>
    pull.user
      ? [{ number: pull.number, title: pull.title, url: pull.html_url, author: pull.user.login, authorType: pull.user.type, association: pull.author_association, createdAt: pull.created_at, state: pull.state, mergedAt: pull.merged_at }]
      : [],
  );
}

// Counts search results, in batches, since the REST search allows only 30 requests a minute.
export async function searchCounts(queries: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let i = 0; i < queries.length; i += 25) {
    const batch = queries.slice(i, i + 25);
    const query = `query { ${batch.map((q, n) => `q${n}: search(query: ${JSON.stringify(q)}, type: ISSUE, first: 1) { issueCount }`).join(' ')} }`;
    const r = await fetch(`${API}/graphql`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(60_000) });
    const j = (await r.json().catch(() => null)) as { data?: Record<string, { issueCount: number }> } | null;
    if (!j?.data) throw new Error(`GitHub search returned ${r.status}`);
    batch.forEach((q, n) => counts.set(q, j.data![`q${n}`]?.issueCount ?? 0));
  }
  return counts;
}

// What was public when the pull request opened, the same way the published evaluation reads it.
export async function factsAtOpen(repo: string, pull: ListedPull, earlierPublicMerges: number): Promise<OpenTimeFacts | null> {
  const detail = await get<{ body: string | null; base: { sha: string } }>(`/repos/${repo}/pulls/${pull.number}`);
  const commits = await get<{ sha: string; commit: { committer?: { date?: string }; author?: { date?: string } } }[]>(`/repos/${repo}/pulls/${pull.number}/commits?per_page=100`);
  if (!detail.json || !commits.json) return null;
  const opened = Date.parse(pull.createdAt);
  const atOpen = commits.json.filter((c) => Date.parse(c.commit.committer?.date ?? c.commit.author?.date ?? '') <= opened).at(-1);
  if (!atOpen) return null;
  const diff = await get<{ files?: { filename: string; additions: number; deletions: number; patch?: string }[] }>(`/repos/${repo}/compare/${detail.json.base.sha}...${atOpen.sha}`);
  const user = await get<{ created_at: string }>(`/users/${pull.author}`);
  if (!diff.json || !user.json) return null;
  const description = detail.json.body ?? '';
  const issueNumber = linkedIssueNumber(description);
  const issue = issueNumber ? await get<{ title: string; body: string | null }>(`/repos/${repo}/issues/${issueNumber}`) : null;
  return {
    title: pull.title,
    description,
    files: (diff.json.files ?? []).map(({ filename, additions, deletions, patch }) => ({ filename, additions, deletions, patch })),
    linkedIssue: issue?.json ? { title: issue.json.title, body: issue.json.body ?? '' } : null,
    accountAgeDays: Math.floor((opened - Date.parse(user.json.created_at)) / 864e5),
    earlierPublicMerges,
  };
}
