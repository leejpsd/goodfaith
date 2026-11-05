#!/usr/bin/env node
// Collects the evaluation's pull requests from public GitHub data. Read-only: it never
// comments on, labels or contacts any project. Every stage appends to a file and skips what
// is already there, so it can stop at a rate limit and carry on. See RULES.md.
//   GH_TOKEN=... node evals/triage/collect.mjs search     low-effort candidates, by label and month
//   GH_TOKEN=... node evals/triage/collect.mjs stars      star counts for the candidates' repos
//   GH_TOKEN=... node evals/triage/collect.mjs summary    counts after the filters
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

const stage = process.argv[2];
if (stage === 'search') await search();
else if (stage === 'stars') await stars();
else if (stage === 'summary') summary();
else throw new Error(`unknown stage ${stage}`);
