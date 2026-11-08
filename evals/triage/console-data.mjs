#!/usr/bin/env node
// Builds the Evidence page's data from the scored results, so the page cannot drift from them.
// A link and the model's reasons appear only on the misses RESULTS.md already lists. Every other
// row keeps the repository, the label and the bands, with no number and no person.
//   node evals/triage/console-data.mjs gpt-6-luna
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanced, bestRule, loadResults, ruleFor } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const model = process.argv[2] ?? 'gpt-6-luna';
const clean = (text) => text.replace(/@[A-Za-z0-9-]+/g, '@[removed]').replace(/github\.com\/[A-Za-z0-9-]+(?=[\s/)]|$)/g, 'github.com/[removed]').replace(/\s+/g, ' ').trim();
const round = (x) => Math.round(x * 1000) / 10;
const shorten = (text, max = 260) => (text.length <= max ? text : `${text.slice(0, text.lastIndexOf(' ', max))}…`);

const { rows } = loadResults('heldout', model);
const { pair } = bestRule(loadResults('tuning', model).rows);
const isRule = ruleFor(pair);
const isMiss = (r) => (r.set === 'low_effort' && r.band === 'low') || (r.set === 'control' && r.band === 'high');
const repoOf = (url) => url.replace('https://github.com/', '').split('/pull/')[0];

const evaluation = rows.map((r) => {
  const miss = isMiss(r);
  return {
    repo: repoOf(r.url),
    set: r.set,
    label: r.set === 'low_effort' ? r.label : 'none',
    band: r.band,
    rule: isRule(r) ? 'high' : 'not_high',
    miss: miss ? 1 : 0,
    url: miss ? r.url : '',
    reason: miss ? shorten(clean(r.reasons.join(' '))) : '',
  };
});

const low = rows.filter((r) => r.set === 'low_effort');
const control = rows.filter((r) => r.set === 'control');
const scores = {
  model: round(balanced(rows, (r) => r.band === 'high')),
  rule: round(balanced(rows, isRule)),
  modelHighFirstTimers: control.filter((r) => r.band === 'high').length,
  ruleHighFirstTimers: control.filter(isRule).length,
  ruleAgeDays: pair[0],
  ruleMerges: pair[1],
};

const counts = new Map();
for (const r of low) counts.set(r.label, [...(counts.get(r.label) ?? []), r.band === 'high' ? 1 : 0]);
const labels = [...counts].filter(([, v]) => v.length >= 20).map(([label, v]) => ({ label, share: round(v.reduce((a, b) => a + b, 0) / v.length), pulls: v.length })).sort((a, b) => b.pulls - a.pulls);

const doors = readFileSync(join(here, '../doors/data/sized.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((r) => r.band).map((r) => ({ band: r.band, laterMerged: r.laterMerged ? 1 : 0 }));

// The published numbers. A rebuild that disagrees with RESULTS.md should stop here.
const expected = { model: 72.2, rule: 64.8, modelHighFirstTimers: 31, ruleHighFirstTimers: 127 };
for (const [key, value] of Object.entries(expected)) if (scores[key] !== value) throw new Error(`${key} is ${scores[key]}, RESULTS.md says ${value}`);
if (evaluation.length !== 1316 || evaluation.filter((r) => r.miss).length !== 220) throw new Error('row or miss count differs from RESULTS.md');

const out = join(here, '../../src/lib/console/evidence.json');
writeFileSync(out, `${JSON.stringify({ scores, labels, evaluation, doors })}\n`);
console.log(`wrote ${evaluation.length} rows, ${evaluation.filter((r) => r.miss).length} misses, ${labels.length} labels, ${doors.length} closed doors`);
console.log(JSON.stringify({ scores, labels }));
