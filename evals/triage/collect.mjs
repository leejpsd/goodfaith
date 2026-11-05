#!/usr/bin/env node
// Collects the evaluation's pull requests from public GitHub data. Read-only: it never
// comments on, labels or contacts any project. Every stage appends to a file and skips what
// is already there, so it can stop at a rate limit and carry on. See RULES.md.
//   GH_TOKEN=... node evals/triage/collect.mjs search     low-effort candidates, by label and month
//   GH_TOKEN=... node evals/triage/collect.mjs stars      star counts for the candidates' repos
//   GH_TOKEN=... node evals/triage/collect.mjs summary    counts after the filters
//   GH_TOKEN=... node evals/triage/collect.mjs select     draws the low-effort set
//   GH_TOKEN=... node evals/triage/collect.mjs control    draws the control set
//   GH_TOKEN=... node evals/triage/collect.mjs unclear    draws the unclear set
//   GH_TOKEN=... node evals/triage/collect.mjs facts [tuning]   open-time facts for each pull request
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, 'data');
mkdirSync(data, { recursive: true });
const token = process.env.GH_TOKEN;
if (!token) throw new Error('GH_TOKEN is not set');

const LABELS = ['ai slop', 'ai-slop', 'slop', 'spam'];
const START = '2025-06-01';
const END = '2026-11-05';
const OUTSIDE = new Set(['NONE', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN']);
const SEED = 'goodfaith-2026-11-05';
const MIN_STARS = 1000;
const PER_REPO = 50;
const LOW_EFFORT = 1000;
const UNCLEAR = 200;
const UNCLEAR_PER_REPO = 5;

const sha = (text) => createHash('sha256').update(text).digest();
const shuffled = (items, key) => [...items].sort((a, b) => Buffer.compare(sha(SEED + key(a)), sha(SEED + key(b))));
const isTuning = (url) => sha(url)[0] < 51;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

async function get(path) {
  for (;;) {
    const r = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'goodfaith-eval' },
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (!r) {
      await sleep(5000);
      continue;
    }
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset') ?? 0) * 1000;
      const wait = Number(r.headers.get('retry-after') ?? 0) * 1000 || Math.max(reset - Date.now(), 0) + 1000 || 60_000;
      console.error(`rate limited, waiting ${Math.ceil(wait / 1000)}s`);
      await sleep(Math.min(wait, 3_600_000));
      continue;
    }
    if (r.status >= 500) {
      await sleep(5000);
      continue;
    }
    return { status: r.status, json: await r.json().catch(() => null) };
  }
}

function months() {
  const out = [];
  let from = new Date(`${START}T00:00:00Z`);
  const end = new Date(`${END}T00:00:00Z`);
  while (from < end) {
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    out.push([from.toISOString().slice(0, 10), new Date(Math.min(to.getTime(), end.getTime()) - 864e5).toISOString().slice(0, 10)]);
    from = to;
  }
  return out;
}

async function search() {
  const file = join(data, 'candidates.jsonl');
  const doneFile = join(data, 'candidates.done.jsonl');
  const done = new Set(readLines(doneFile).map((d) => d.key));
  const seen = new Set(readLines(file).map((c) => c.url));
  for (const label of LABELS) {
    for (const [from, to] of months()) {
      const key = `${label}|${from}`;
      if (done.has(key)) continue;
      const q = encodeURIComponent(`is:pr is:closed is:unmerged archived:false label:"${label}" created:${from}..${to}`);
      let total = 0;
      for (let page = 1; page <= 10; page++) {
        const { json } = await get(`/search/issues?q=${q}&per_page=100&page=${page}`);
        const items = json?.items ?? [];
        total = json?.total_count ?? total;
        for (const item of items) {
          if (seen.has(item.html_url)) continue;
          seen.add(item.html_url);
          appendFileSync(
            file,
            `${JSON.stringify({
              url: item.html_url,
              repo: item.repository_url.replace('https://api.github.com/repos/', ''),
              number: item.number,
              label,
              author: item.user?.login ?? null,
              authorType: item.user?.type ?? null,
              association: item.author_association,
              createdAt: item.created_at,
            })}\n`,
          );
        }
        await sleep(2100);
        if (items.length < 100) break;
      }
      appendFileSync(doneFile, `${JSON.stringify({ key, total })}\n`);
      console.error(key, total, 'candidates so far', seen.size);
    }
  }
}

async function stars() {
  const file = join(data, 'repos.jsonl');
  const known = new Set(readLines(file).map((r) => r.repo));
  const repos = [...new Set(readLines(join(data, 'candidates.jsonl')).map((c) => c.repo))].filter((r) => !known.has(r));
  console.error('repos to read', repos.length);
  for (const repo of repos) {
    const { status, json } = await get(`/repos/${repo}`);
    appendFileSync(file, `${JSON.stringify({ repo, status, stars: json?.stargazers_count ?? null, fork: json?.fork ?? null, archived: json?.archived ?? null })}\n`);
  }
}

function summary() {
  const candidates = readLines(join(data, 'candidates.jsonl'));
  const repos = new Map(readLines(join(data, 'repos.jsonl')).map((r) => [r.repo, r]));
  const outside = candidates.filter((c) => c.author && c.authorType === 'User' && OUTSIDE.has(c.association));
  console.log('candidates', candidates.length, 'from outsiders', outside.length, 'repos', new Set(candidates.map((c) => c.repo)).size);
  for (const label of LABELS) console.log(' label', label, candidates.filter((c) => c.label === label).length);
  const assoc = {};
  for (const c of candidates) assoc[c.association] = (assoc[c.association] ?? 0) + 1;
  console.log(' association', JSON.stringify(assoc));
  for (const min of [0, 10, 50, 100, 500, 1000]) {
    const kept = outside.filter((c) => (repos.get(c.repo)?.stars ?? -1) >= min && !repos.get(c.repo)?.fork);
    const perRepo = new Map();
    for (const c of kept) perRepo.set(c.repo, (perRepo.get(c.repo) ?? 0) + 1);
    const capped = [...perRepo.values()].reduce((sum, n) => sum + Math.min(n, 50), 0);
    const top = [...perRepo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${r}:${n}`).join(' ');
    console.log(`stars>=${min} kept ${kept.length}, repos ${perRepo.size}, after cap 50 per repo ${capped}, top ${top}`);
  }
}

function eligibleRepos() {
  return new Map(readLines(join(data, 'repos.jsonl')).filter((r) => r.status === 200 && r.stars >= MIN_STARS && !r.fork && !r.archived).map((r) => [r.repo, r]));
}

function select() {
  const repos = eligibleRepos();
  const outside = readLines(join(data, 'candidates.jsonl')).filter((c) => c.author && c.authorType === 'User' && OUTSIDE.has(c.association) && repos.has(c.repo));
  const taken = new Map();
  const capped = shuffled(outside, (c) => c.url).filter((c) => {
    const n = taken.get(c.repo) ?? 0;
    if (n >= PER_REPO) return false;
    taken.set(c.repo, n + 1);
    return true;
  });
  const drawn = capped.slice(0, LOW_EFFORT);
  writeFileSync(join(data, 'low-effort.jsonl'), drawn.map((c) => JSON.stringify({ ...c, set: 'low_effort' })).join('\n') + '\n');
  const perRepo = new Set(drawn.map((c) => c.repo)).size;
  console.log(JSON.stringify({ candidates: readLines(join(data, 'candidates.jsonl')).length, fromOutsidersInEligibleRepos: outside.length, afterCap: capped.length, drawn: drawn.length, repos: perRepo }));
}

// GraphQL search counts, in batches, since REST search allows only 30 requests a minute.
async function counts(queries) {
  const out = new Map();
  for (let i = 0; i < queries.length; i += 25) {
    const batch = queries.slice(i, i + 25);
    const query = `query { ${batch.map((q, n) => `q${n}: search(query: ${JSON.stringify(q)}, type: ISSUE, first: 1) { issueCount }`).join(' ')} }`;
    for (;;) {
      const r = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'goodfaith-eval' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(90_000),
      }).catch(() => null);
      const j = r?.ok ? await r.json().catch(() => null) : null;
      if (j?.data) {
        batch.forEach((q, n) => out.set(q, j.data[`q${n}`].issueCount));
        break;
      }
      console.error('graphql retry', r?.status, j?.errors?.[0]?.type ?? '');
      await sleep(30_000);
    }
    await sleep(1500);
  }
  return out;
}

const search100 = async (q, page) => {
  const { json } = await get(`/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
  await sleep(2100);
  return json?.items ?? [];
};

async function control() {
  const file = join(data, 'control.jsonl');
  const doneFile = join(data, 'control.done.jsonl');
  const done = new Set(readLines(doneFile).map((d) => d.repo));
  const quota = new Map();
  for (const c of readLines(join(data, 'low-effort.jsonl'))) quota.set(c.repo, (quota.get(c.repo) ?? 0) + 1);
  for (const [repo, want] of quota) {
    if (done.has(repo)) continue;
    const pool = [];
    for (let page = 1; page <= 3; page++) {
      const items = await search100(`repo:${repo} is:pr is:merged created:${START}..${END}`, page);
      for (const item of items) {
        if (!item.user || item.user.type !== 'User') continue;
        if (['OWNER', 'MEMBER', 'COLLABORATOR'].includes(item.author_association)) continue;
        pool.push({ url: item.html_url, repo, number: item.number, label: null, author: item.user.login, authorType: item.user.type, association: item.author_association, createdAt: item.created_at, set: 'control' });
      }
      if (items.length < 100) break;
    }
    // New to the repo means no merged pull request created before this one.
    const ordered = shuffled(pool, (c) => c.url);
    const q = (c) => `repo:${repo} is:pr is:merged author:${c.author} created:<${c.createdAt.slice(0, 10)}`;
    const seen = await counts([...new Set(ordered.slice(0, want * 3).map(q))]);
    const picked = ordered.slice(0, want * 3).filter((c) => seen.get(q(c)) === 0).slice(0, want);
    for (const c of picked) appendFileSync(file, `${JSON.stringify(c)}\n`);
    appendFileSync(doneFile, `${JSON.stringify({ repo, want, got: picked.length, pool: pool.length })}\n`);
    console.error(repo, 'want', want, 'got', picked.length, 'pool', pool.length);
  }
}

async function unclear() {
  const file = join(data, 'unclear.jsonl');
  const repos = shuffled([...new Set(readLines(join(data, 'low-effort.jsonl')).map((c) => c.repo))], (r) => r);
  let total = readLines(file).length;
  for (const repo of repos) {
    if (total >= UNCLEAR) break;
    const items = await search100(`repo:${repo} is:pr is:closed is:unmerged no:label created:${START}..${END}`, 1);
    const pool = items
      .filter((item) => item.user?.type === 'User' && OUTSIDE.has(item.author_association))
      .map((item) => ({ url: item.html_url, repo, number: item.number, label: null, author: item.user.login, authorType: item.user.type, association: item.author_association, createdAt: item.created_at, set: 'unclear' }));
    for (const c of shuffled(pool, (p) => p.url).slice(0, UNCLEAR_PER_REPO)) {
      if (total >= UNCLEAR) break;
      appendFileSync(file, `${JSON.stringify(c)}\n`);
      total++;
    }
    console.error(repo, 'unclear so far', total);
  }
}

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/i;

async function factsFor(c) {
  const base = `/repos/${c.repo}`;
  const pr = await get(`${base}/pulls/${c.number}`);
  if (pr.status !== 200) return { dropped: `pull ${pr.status}` };
  const commits = await get(`${base}/pulls/${c.number}/commits?per_page=100`);
  if (commits.status !== 200) return { dropped: `commits ${commits.status}` };
  const opened = Date.parse(c.createdAt);
  // A commit's date can be older than the pull request, and never newer unless it came later.
  const atOpen = commits.json.filter((k) => Date.parse(k.commit.committer?.date ?? k.commit.author?.date) <= opened).at(-1);
  if (!atOpen) return { dropped: 'no commit at open' };
  const diff = await get(`${base}/compare/${pr.json.base.sha}...${atOpen.sha}`);
  if (diff.status !== 200) return { dropped: `compare ${diff.status}` };
  const user = await get(`/users/${c.author}`);
  if (user.status !== 200) return { dropped: `user ${user.status}` };
  const description = pr.json.body ?? '';
  const issueNumber = description.match(CLOSING)?.[1];
  const issue = issueNumber ? await get(`${base}/issues/${issueNumber}`) : null;
  return {
    facts: {
      title: pr.json.title,
      description,
      files: (diff.json.files ?? []).map(({ filename, additions, deletions, patch }) => ({ filename, additions, deletions, patch })),
      linkedIssue: issue?.status === 200 ? { title: issue.json.title, body: issue.json.body ?? '' } : null,
      accountAgeDays: Math.floor((opened - Date.parse(user.json.created_at)) / 864e5),
    },
  };
}

async function facts(only) {
  const file = join(data, 'facts.jsonl');
  const done = new Set(readLines(file).map((f) => f.url));
  const everything = [...readLines(join(data, 'low-effort.jsonl')), ...readLines(join(data, 'control.jsonl')), ...readLines(join(data, 'unclear.jsonl'))];
  const todo = everything.filter((c) => !done.has(c.url) && (only !== 'tuning' || isTuning(c.url)));
  console.error('to read', todo.length);
  // Earlier public merges come as one batch, so a stop at a rate limit loses little.
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const q = (c) => `is:pr is:merged author:${c.author} merged:<${c.createdAt.slice(0, 10)}`;
    const merges = await counts(batch.map(q));
    for (const c of batch) {
      const result = await factsFor(c);
      const row = result.facts
        ? { url: c.url, set: c.set, label: c.label, tuning: isTuning(c.url), facts: { ...result.facts, earlierPublicMerges: merges.get(q(c)) ?? 0 } }
        : { url: c.url, set: c.set, label: c.label, tuning: isTuning(c.url), dropped: result.dropped };
      appendFileSync(file, `${JSON.stringify(row)}\n`);
    }
    console.error('read', Math.min(i + 25, todo.length), 'of', todo.length);
  }
}

const stage = process.argv[2];
if (stage === 'search') await search();
else if (stage === 'stars') await stars();
else if (stage === 'summary') summary();
else if (stage === 'select') select();
else if (stage === 'control') await control();
else if (stage === 'unclear') await unclear();
else if (stage === 'facts') await facts(process.argv[3]);
else throw new Error(`unknown stage ${stage}`);
