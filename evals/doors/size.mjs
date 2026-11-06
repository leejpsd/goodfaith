#!/usr/bin/env node
// Sizes every newcomer pull request a bot closed within an hour, with the product's own prompt,
// and asks whether the same person had a pull request merged there later. Read-only on GitHub.
// Writes bands and counts to data/, never a username.
//   node --experimental-strip-types --no-warnings evals/doors/size.mjs
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkedIssueNumber, runTriage } from '../../src/lib/triage/triage.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'data');
process.loadEnvFile(join(here, '../../.env.local'));
const token = process.env.DEMO_CONTRIBUTOR_TOKEN;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function get(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  return r.ok ? r.json() : null;
}

async function count(query) {
  const r = await fetch('https://api.github.com/graphql', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: `query { s: search(query: ${JSON.stringify(query)}, type: ISSUE, first: 1) { issueCount } }` }), signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => null);
  return j?.data?.s?.issueCount ?? null;
}

async function size(repo, number) {
  const pull = await get(`/repos/${repo}/pulls/${number}`);
  if (!pull?.user) return { dropped: 'pull' };
  const commits = await get(`/repos/${repo}/pulls/${number}/commits?per_page=100`);
  const opened = Date.parse(pull.created_at);
  const atOpen = (commits ?? []).filter((c) => Date.parse(c.commit.committer?.date ?? c.commit.author?.date ?? '') <= opened).at(-1);
  if (!atOpen) return { dropped: 'no commit at open' };
  const diff = await get(`/repos/${repo}/compare/${pull.base.sha}...${atOpen.sha}`);
  const user = await get(`/users/${pull.user.login}`);
  if (!diff || !user) return { dropped: 'unreadable' };
  const description = pull.body ?? '';
  const issueNumber = linkedIssueNumber(description);
  const issue = issueNumber ? await get(`/repos/${repo}/issues/${issueNumber}`) : null;
  const day = pull.created_at.slice(0, 10);
  const earlier = await count(`is:pr is:merged author:${pull.user.login} merged:<${day}`);
  const later = await count(`repo:${repo} is:pr is:merged author:${pull.user.login} created:>${day}`);
  const triage = await runTriage({
    title: pull.title,
    description,
    files: (diff.files ?? []).map(({ filename, additions, deletions, patch }) => ({ filename, additions, deletions, patch })),
    linkedIssue: issue ? { title: issue.title, body: issue.body ?? '' } : null,
    accountAgeDays: Math.floor((opened - Date.parse(user.created_at)) / 864e5),
    earlierPublicMerges: earlier ?? 0,
  });
  if (!triage) return { dropped: 'model' };
  return { band: triage.band, flagged: Boolean(triage.instructions_to_ai), laterMerged: later === null ? null : later > 0, model: triage.model };
}

const file = join(out, 'sized.jsonl');
const seen = new Set(readLines(file).map((r) => `${r.repo}#${r.number}`));
const todo = readLines(join(out, 'doors.jsonl')).flatMap((r) => r.botClosed.map((c) => ({ repo: r.repo, number: c.number, createdAt: c.createdAt }))).filter((c) => !seen.has(`${c.repo}#${c.number}`));
console.log(`${todo.length} to size`);
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < todo.length) {
      const c = todo[next++];
      const result = await size(c.repo, c.number).catch((error) => ({ dropped: error instanceof Error ? error.message.slice(0, 60) : 'error' }));
      appendFileSync(file, `${JSON.stringify({ ...c, ...result })}\n`);
    }
  }),
);

const rows = readLines(file);
const sized = rows.filter((r) => r.band);
const by = (band) => sized.filter((r) => r.band === band).length;
const summary = {
  botClosed: rows.length,
  sized: sized.length,
  dropped: rows.length - sized.length,
  low: by('low'),
  medium: by('medium'),
  high: by('high'),
  laterMerged: sized.filter((r) => r.laterMerged).length,
  laterMergedByBand: { low: sized.filter((r) => r.laterMerged && r.band === 'low').length, medium: sized.filter((r) => r.laterMerged && r.band === 'medium').length, high: sized.filter((r) => r.laterMerged && r.band === 'high').length },
  flagged: sized.filter((r) => r.flagged).length,
};
writeFileSync(join(out, 'sized-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
