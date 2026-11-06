#!/usr/bin/env node
// Writes RESULTS.md from the held-out run, under RULES.md. Names no person: links only, and
// handles are removed from the model's text.
//   node evals/triage/report.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanced, bestRule, bootstrapDifference, loadResults, ruleFor } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = 'gpt-6-luna';
const DEMO_CENTS = { low: 200, medium: 500, high: 2500 };

const facts = readFileSync(join(here, 'data/facts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const { rows, input, output, failed } = loadResults('heldout', MODEL);
const tuning = loadResults('tuning', MODEL).rows;
const best = bestRule(tuning);
const isRule = ruleFor(best.pair);
const [from, to] = bootstrapDifference(rows, isRule);

const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;
const bySet = (set) => rows.filter((r) => r.set === set);
const low = bySet('low_effort');
const control = bySet('control');
const unclear = bySet('unclear');
const count = (list, band) => list.filter((r) => r.band === band).length;
const money = (list) => `$${(list.reduce((s, r) => s + DEMO_CENTS[r.band], 0) / list.length / 100).toFixed(2)}`;
const clean = (text) => text.replace(/@[A-Za-z0-9-]+/g, '@[removed]').replace(/github\.com\/[A-Za-z0-9-]+(?=[\s/)]|$)/g, 'github.com/[removed]').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const collected = (set) => facts.filter((f) => f.set === set);
const usable = (set) => collected(set).filter((f) => f.facts);
const steps = ['low_effort', 'control', 'unclear'].map((set) => {
  const all = collected(set);
  const reasons = {};
  for (const f of all.filter((f) => !f.facts)) reasons[f.dropped ?? 'unreadable'] = (reasons[f.dropped ?? 'unreadable'] ?? 0) + 1;
  const kept = usable(set);
  return `| ${set.replace('_', '-')} | ${all.length} | ${Object.entries(reasons).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'} | ${kept.filter((f) => f.tuning).length} | ${kept.filter((f) => !f.tuning).length} |`;
});

let repeat = 'The repeat run has not finished yet.';
const repeatFile = join(here, `data/results-repeat-${MODEL}.jsonl`);
if (existsSync(repeatFile)) {
  const again = loadResults('repeat', MODEL).rows;
  const first = new Map(rows.map((r) => [r.url, r.band]));
  const paired = again.filter((r) => first.has(r.url));
  const same = paired.filter((r) => first.get(r.url) === r.band).length;
  const highFlip = paired.filter((r) => (first.get(r.url) === 'high') !== (r.band === 'high')).length;
  repeat = `${same} of ${paired.length} pull requests got the same band the second time. ${highFlip} moved into or out of the high band.`;
}

const missLines = (list) => list.map((r) => `- ${r.url}: ${clean(r.reasons.join(' '))}`).join('\n');
const lowMisses = low.filter((r) => r.band === 'low');
const controlMisses = control.filter((r) => r.band === 'high');
const flaggedBySet = ['low_effort', 'control', 'unclear'].map((s) => `${bySet(s).filter((r) => r.flagged).length} ${s.replace('_', '-')}`).join(', ');
const labels = {};
for (const r of low) {
  labels[r.label] ??= { n: 0, high: 0 };
  labels[r.label].n++;
  if (r.band === 'high') labels[r.label].high++;
}

writeFileSync(join(here, 'RESULTS.md'), `# Triage evaluation results

Scored once on the held-out set under [RULES.md](RULES.md), whose SHA-256 was published in [a public gist](https://gist.github.com/leejpsd/b55b5aa7b3d4dccf9d0649bbc46010ba) before the first run. Model \`${MODEL}\`, through the product's own prompt and code.

## The answer

The model beats the plain rule, under the test fixed in advance.

| | Balanced accuracy of "high" |
|---|---|
| The model | **${(balanced(rows, (r) => r.band === 'high') * 100).toFixed(1)}%** |
| Plain rule: account younger than ${best.pair[0]} days, or at most ${best.pair[1]} earlier merges | ${(balanced(rows, isRule) * 100).toFixed(1)}% |
| Model minus rule, 95% interval from 1,000 paired bootstrap samples | ${(from * 100).toFixed(1)} to ${(to * 100).toFixed(1)} points |

It also misses a lot. It put ${pct(count(low, 'high'), low.length)} of maintainer-labelled low-effort pull requests in the high band, so nearly half got a medium or low hold. It kept ${pct(control.length - count(control, 'high'), control.length)} of merged first-timers out of the high band. Every miss is listed below.

## The table

| Band | Low-effort | Control (merged first-timers) | Unclear |
|---|---|---|---|
${['low', 'medium', 'high'].map((b) => `| ${b} | ${count(low, b)} | ${count(control, b)} | ${count(unclear, b)} |`).join('\n')}
| total | ${low.length} | ${control.length} | ${unclear.length} |

${failed} results failed to parse. Cost: ${input.toLocaleString('en-US')} input and ${output.toLocaleString('en-US')} output tokens, about $0.32 through the Batch API.

## Counts at each step

| Set | Collected | Dropped | Tuning | Held out |
|---|---|---|---|---|
${steps.join('\n')}

"no commit at open" means no commit was dated at or before the pull request was created, usually after a force push, so we could not rebuild what the model would have seen.

## How often the band repeats

${repeat}

## Limits

A label is one maintainer's view. Merged does not mean good. Titles and descriptions may have been edited after opening. A label like \`spam\` may be applied for reasons that are not about effort. This says nothing about pull requests with no label at all. All the sets come from repositories with 1,000 or more stars.

## Added after the rules were fixed

These readings were not in RULES.md, so treat them as exploration, not as tested claims.

- **Who the rule would overcharge.** The plain rule put ${control.filter(isRule).length} of ${control.length} merged first-timers in the high band, and the model ${count(control, 'high')}. Most first-timers have young accounts or few merges, so a rule built on those charges them the most.
- **What a hold would be,** at the demo repository's $2, $5 and $25: ${money(low)} on average for low-effort pull requests, and ${money(control)} for merged first-timers.
- **By label:** ${Object.entries(labels).map(([k, v]) => `\`${k}\` ${v.high} of ${v.n} high`).join(', ')}.
- **Text aimed at AI reviewers,** flagged with no injection added: ${flaggedBySet}. We have not checked these by hand.
- **Choosing the model.** On the tuning set, \`gpt-6.1-sol\` scored 69.3% and \`gpt-6-luna\` 71.7%, against 65.1% for the plain rule. The product switched to \`gpt-6-luna\` before the held-out run.
- **Timing.** The held-out batch took about 12 hours to start returning results, though the Batch API allows up to a day.

## Misses

Links only, with the model's reasons. Handles in its text are removed. A miss is not a judgement of the person who opened the pull request.

### Low-effort pull requests the model put in the low band (${lowMisses.length})

${missLines(lowMisses)}

### Merged first-timers the model put in the high band (${controlMisses.length})

${missLines(controlMisses)}
`);
console.log(`wrote RESULTS.md: ${lowMisses.length} + ${controlMisses.length} misses, repeat ${existsSync(repeatFile) ? 'included' : 'pending'}`);
