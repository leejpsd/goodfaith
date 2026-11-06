#!/usr/bin/env node
// Writes RESULTS.md from the survey and the sizing run. Counts and project names only.
//   node evals/doors/report.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lines = (f) => readFileSync(join(here, 'data', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const doors = lines('doors.jsonl');
const sized = lines('sized.jsonl');
const sum = (list, key) => list.reduce((s, r) => s + r[key], 0);
const fast = sum(doors, 'closedFast');
const bot = sum(doors, 'byBot');
const person = sum(doors, 'byPerson');
const author = sum(doors, 'byAuthor');
const banded = sized.filter((r) => r.band);
const n = (list, band) => list.filter((r) => r.band === band).length;
const pct = (a, b) => `${Math.round((a / b) * 100)}%`;
const projects = [...new Set(banded.map((r) => r.repo))]
  .map((repo) => ({ repo, rows: banded.filter((r) => r.repo === repo) }))
  .sort((a, b) => b.rows.length - a.rows.length);
const windows = doors.filter((r) => r.from).map((r) => r.from.slice(0, 10)).sort();

writeFileSync(join(here, 'RESULTS.md'), `# Closed doors

Who closes a newcomer's pull request within an hour of opening, and what a refundable hold would have been instead. Read-only, collected on 2026-11-06.

## What we looked at

The ${doors.length} repositories with 1,000 or more stars from the [triage evaluation](../triage/RULES.md), and the latest 100 pull requests in each, so the window differs by project and mostly covers October and early November 2026. A newcomer is an author who is not an owner, member or collaborator and is not a bot, as GitHub reports it today. A pull request counts as closed fast when it was closed unmerged within an hour, and the closer is the account GitHub records as having closed it.

## Who closed them

| | Pull requests |
|---|---|
| From newcomers | ${sum(doors, 'outside').toLocaleString('en-US')} |
| Closed unmerged within an hour | ${fast.toLocaleString('en-US')} |
| ... by the author | ${author} |
| ... by a person in the project | ${person} |
| ... **by a bot** | **${bot}** |
| ... closer not recorded | ${fast - bot - person - author} |

Bots closed newcomers' pull requests at ${doors.filter((r) => r.byBot > 0).length} projects, and at ${doors.filter((r) => r.byBot >= 5).length} of them five or more times. Reading one bot message at each of those, the reasons were spam or slop detection (juice-shop, scrapy, RSSHub), a no-AI policy (yt-dlp), an application to contribute (postiz), process rules such as being assigned to the issue first (Nettacker, mastg, scikit-learn, uptime-kuma), and a submission checklist (flathub). Some of these are exactly right for those projects. One reply on such a pull request said a spam workflow had closed "a legitimate performance optimization".

## What a hold would have been

We ran the product's own prompt and model (\`${banded[0]?.model ?? 'gpt-6-luna'}\`) on ${banded.length} of the ${sized.length} bot-closed pull requests, reading only what was public when each opened. ${sized.length - banded.length} could not be read. At the demo repository's amounts:

| Band | Hold | Pull requests |
|---|---|---|
| low | $2.00 | ${n(banded, 'low')} |
| medium | $5.00 | ${n(banded, 'medium')} |
| high | $25.00 | ${n(banded, 'high')} |

So ${n(banded, 'low') + n(banded, 'medium')} of ${banded.length} (${pct(n(banded, 'low') + n(banded, 'medium'), banded.length)}) could have reached a reviewer for $5 or less, and any review returns the whole hold. ${banded.filter((r) => r.laterMerged).length} of these authors had a pull request merged in the same project later. ${banded.filter((r) => r.flagged).length} contained text aimed at AI reviewers.

The model and the bots disagree a lot, and that is the point of a second door. At juice-shop it agreed with the spam detector and put most at the maximum. At scrapy it read most of what the spam workflow closed as careful. Either could be wrong. A hold lets a maintainer find out, at no cost to a newcomer acting in good faith.

| Project | Sized | $2 | $5 | $25 | Merged later |
|---|---|---|---|---|---|
${projects.map(({ repo, rows }) => `| ${repo} | ${rows.length} | ${n(rows, 'low')} | ${n(rows, 'medium')} | ${n(rows, 'high')} | ${rows.filter((r) => r.laterMerged).length} |`).join('\n')}

## What this does not show

- A low band is not proof of good work. The model [misses tidy AI slop](../triage/RESULTS.md), placing 29% to 39% of pull requests labelled as AI slop in the high band.
- A bot may be right, and a project may want its door closed. This counts doors, it does not judge them.
- One page per project means different windows, from ${windows[0]} at the earliest, and \`author_association\` reflects today rather than the day the pull request opened.
- Nothing here measures whether a hold would stop slop.

## Reproduce

\`node evals/doors/survey.mjs\`, then \`node --experimental-strip-types evals/doors/size.mjs\`, then \`node evals/doors/report.mjs\`. GET requests only, and nothing is posted to any project. The sizing cost about $0.10.
`);
console.log('wrote RESULTS.md');
