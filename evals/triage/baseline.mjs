#!/usr/bin/env node
// A harder baseline than the plain rule, added after the rules were fixed: a logistic regression
// on nine facts that need no reading of the text, fitted on the tuning set only. The features were
// chosen before its held-out score was seen. It ran twice, and both results are reported: first
// with a 0.5 threshold, then with the threshold that scores best on the tuning set, which is how
// the plain rule's pair was chosen and is the fair one for a set that is two thirds low effort.
//   node evals/triage/baseline.mjs gpt-6-luna
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { balanced, bootstrapDifference, loadResults } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DOCS = /(^|\/)docs?\/|\.(md|mdx|rst|txt|adoc)$/i;
const TESTS = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+$/i;

function features(facts) {
  const files = facts.files ?? [];
  const changed = files.reduce((sum, f) => sum + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  return [
    Math.log1p(Math.max(0, facts.accountAgeDays ?? 0)),
    Math.log1p(facts.earlierPublicMerges ?? 0),
    Math.log1p((facts.description ?? '').length),
    Math.log1p((facts.title ?? '').length),
    Math.log1p(changed),
    Math.log1p(files.length),
    facts.linkedIssue ? 1 : 0,
    files.length ? files.filter((f) => DOCS.test(f.filename)).length / files.length : 0,
    files.some((f) => TESTS.test(f.filename)) ? 1 : 0,
  ];
}

// Plain gradient descent on standardized features, with a light L2 penalty. No random start.
function fit(xs, ys, { steps = 20000, rate = 0.1, penalty = 0.01 } = {}) {
  const width = xs[0].length;
  const mean = Array.from({ length: width }, (_, j) => xs.reduce((s, x) => s + x[j], 0) / xs.length);
  const spread = mean.map((m, j) => Math.sqrt(xs.reduce((s, x) => s + (x[j] - m) ** 2, 0) / xs.length) || 1);
  const scale = (x) => x.map((v, j) => (v - mean[j]) / spread[j]);
  const zs = xs.map(scale);
  const weights = new Array(width).fill(0);
  let bias = 0;
  for (let step = 0; step < steps; step++) {
    const slope = new Array(width).fill(0);
    let lean = 0;
    for (let i = 0; i < zs.length; i++) {
      const error = 1 / (1 + Math.exp(-(bias + zs[i].reduce((s, v, j) => s + v * weights[j], 0)))) - ys[i];
      lean += error;
      for (let j = 0; j < width; j++) slope[j] += error * zs[i][j];
    }
    bias -= (rate * lean) / zs.length;
    for (let j = 0; j < width; j++) weights[j] -= rate * (slope[j] / zs.length + penalty * weights[j]);
  }
  return (x) => bias + scale(x).reduce((s, v, j) => s + v * weights[j], 0);
}

export function metadataBaseline(model) {
  const facts = new Map(readFileSync(join(here, 'data/facts.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((r) => r.facts).map((r) => [r.url, r.facts]));
  const clear = (rows) => rows.filter((r) => r.set !== 'unclear');
  const tuning = clear(loadResults('tuning', model).rows);
  const heldout = loadResults('heldout', model).rows;
  const score = fit(tuning.map((r) => features(facts.get(r.url))), tuning.map((r) => (r.set === 'low_effort' ? 1 : 0)));
  const scores = new Map(heldout.map((r) => [r.url, score(features(facts.get(r.url)))]));
  const onTuning = new Map(tuning.map((r) => [r.url, score(features(facts.get(r.url)))]));
  let threshold = 0;
  let best = -1;
  for (const candidate of [...onTuning.values()].sort((a, b) => a - b)) {
    const reached = balanced(tuning, (r) => onTuning.get(r.url) >= candidate);
    if (reached > best) [threshold, best] = [candidate, reached];
  }
  const isBaseline = (r) => scores.get(r.url) >= threshold;
  const atHalf = (r) => scores.get(r.url) >= 0;
  const isModel = (r) => r.band === 'high';
  const low = heldout.filter((r) => r.set === 'low_effort');
  const control = heldout.filter((r) => r.set === 'control');
  // The same share of merged first-timers the model charges most, to compare the strict end.
  const modelFlags = control.filter(isModel).length;
  const cut = control.map((r) => scores.get(r.url)).sort((a, b) => b - a)[modelFlags - 1];
  const atModelRate = (r) => scores.get(r.url) >= cut;
  // What a maintainer meets by reading the model's low band first, against the same number of
  // pull requests taken from the bottom of this baseline's order.
  const count = (rows, set) => rows.filter((r) => r.set === set).length;
  const lowBand = heldout.filter((r) => r.band === 'low');
  const baselineFirst = [...heldout].sort((a, b) => scores.get(a.url) - scores.get(b.url)).slice(0, lowBand.length);
  return {
    readFirst: {
      size: lowBand.length,
      of: heldout.length,
      model: { control: count(lowBand, 'control'), low: count(lowBand, 'low_effort') },
      baseline: { control: count(baselineFirst, 'control'), low: count(baselineFirst, 'low_effort') },
    },
    trainedOn: tuning.length,
    baseline: balanced(heldout, isBaseline),
    baselineAtHalf: balanced(heldout, atHalf),
    intervalAtHalf: bootstrapDifference(heldout, atHalf),
    model: balanced(heldout, isModel),
    interval: bootstrapDifference(heldout, isBaseline),
    baselineHighControl: control.filter(isBaseline).length,
    modelHighControl: modelFlags,
    control: control.length,
    low: low.length,
    modelCaught: low.filter(isModel).length,
    baselineCaughtAtModelRate: low.filter(atModelRate).length,
    baselineFlagsAtModelRate: control.filter(atModelRate).length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(metadataBaseline(process.argv[2] ?? 'gpt-6-luna'), null, 1));
