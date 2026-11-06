#!/usr/bin/env node
// Counts how often projects close a newcomer's pull request within an hour, and who closed it.
// Read-only: GET requests only, on the repositories the triage evaluation collected. Writes
// counts and pull request numbers to data/, and never a username.
//   node evals/doors/survey.mjs
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const triageData = join(here, '../triage/data');
const out = join(here, 'data');
process.loadEnvFile(join(here, '../../.env.local'));
const token = process.env.DEMO_CONTRIBUTOR_TOKEN;
if (!token) throw new Error('DEMO_CONTRIBUTOR_TOKEN is not set');

const HOUR = 3_600_000;
const INSIDE = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const isBot = (user) => !user || user.type === 'Bot' || user.login.endsWith('[bot]');

async function get(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset') ?? 0) * 1000;
      await new Promise((done) => setTimeout(done, Math.max(5_000, reset - Date.now() + 1_000)));
      continue;
    }
    return r.ok ? r.json() : null;
  }
  return null;
}

const repos = readLines(join(triageData, 'repos.jsonl')).filter((r) => r.status === 200 && r.stars >= 1000 && !r.fork && !r.archived).map((r) => r.repo);
const file = join(out, 'doors.jsonl');
const done = new Set(readLines(file).map((r) => r.repo));
const todo = repos.filter((repo) => !done.has(repo));
console.log(`${repos.length} repositories, ${todo.length} to survey`);

let next = 0;
await Promise.all(
  Array.from({ length: 5 }, async () => {
    while (next < todo.length) {
      const repo = todo[next++];
      const pulls = (await get(`/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`)) ?? [];
      const outside = pulls.filter((p) => !isBot(p.user) && !INSIDE.has(p.author_association));
      const fast = outside.filter((p) => !p.merged_at && p.closed_at && Date.parse(p.closed_at) - Date.parse(p.created_at) < HOUR);
      const closers = [];
      for (const p of fast) {
        const issue = await get(`/repos/${repo}/issues/${p.number}`);
        const by = issue?.closed_by;
        closers.push({ number: p.number, createdAt: p.created_at, minutes: Math.round((Date.parse(p.closed_at) - Date.parse(p.created_at)) / 60_000), closer: !by ? 'unknown' : isBot(by) ? 'bot' : by.login === p.user.login ? 'author' : 'person' });
      }
      const row = {
        repo,
        pulls: pulls.length,
        from: pulls.at(-1)?.created_at ?? null,
        to: pulls[0]?.created_at ?? null,
        outside: outside.length,
        closedFast: fast.length,
        byBot: closers.filter((c) => c.closer === 'bot').length,
        byPerson: closers.filter((c) => c.closer === 'person').length,
        byAuthor: closers.filter((c) => c.closer === 'author').length,
        botClosed: closers.filter((c) => c.closer === 'bot').map(({ number, createdAt, minutes }) => ({ number, createdAt, minutes })),
      };
      appendFileSync(file, `${JSON.stringify(row)}\n`);
    }
  }),
);

const rows = readLines(file);
const doors = rows.filter((r) => r.byBot >= 5);
const sum = (list, key) => list.reduce((s, r) => s + r[key], 0);
const summary = {
  surveyed: rows.length,
  newcomerPullRequests: sum(rows, 'outside'),
  closedWithinAnHour: sum(rows, 'closedFast'),
  closedWithinAnHourByBot: sum(rows, 'byBot'),
  closedWithinAnHourByPerson: sum(rows, 'byPerson'),
  closedWithinAnHourByAuthor: sum(rows, 'byAuthor'),
  reposWithBotClosing: rows.filter((r) => r.byBot > 0).length,
  closedDoors: doors.length,
  closedDoorRepos: doors.sort((a, b) => b.byBot - a.byBot).map((r) => ({ repo: r.repo, byBot: r.byBot, outside: r.outside, from: r.from?.slice(0, 10), to: r.to?.slice(0, 10) })),
};
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, closedDoorRepos: summary.closedDoorRepos.slice(0, 15) }, null, 2));
