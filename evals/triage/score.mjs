#!/usr/bin/env node
// Scores a batch's results under RULES.md. The plain rule's pair is chosen on the tuning set
// and then fixed. Prints counts only, and names no person.
//   node evals/triage/score.mjs tuning gpt-6.1-sol
//   node evals/triage/score.mjs heldout gpt-6.1-sol
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const data = join(dirname(fileURLToPath(import.meta.url)), 'data');
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const BANDS = ['low', 'medium', 'high'];
const AGES = [7, 30, 90, 365];
const MERGES = [0, 1, 5, 20];
// Batch prices per million tokens, input then output.
const PRICE = { 'gpt-6.1-sol': [1, 5], 'gpt-6-luna': [0.05, 0.25] };

export function loadResults(scope, model) {
  const facts = new Map(readLines(join(data, 'facts.jsonl')).filter((r) => r.facts).map((r) => [r.url, r]));
  let input = 0;
  let output = 0;
  let failed = 0;
  const rows = [];
  for (const line of readLines(join(data, `results-${scope}-${model}.jsonl`))) {
    const fact = facts.get(line.custom_id);
    const body = line.response?.body;
    input += body?.usage?.input_tokens ?? 0;
    output += body?.usage?.output_tokens ?? 0;
    const text = body?.output?.flatMap((item) => item.content ?? []).find((part) => part.type === 'output_text')?.text;
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!fact || !parsed || !BANDS.includes(parsed.band)) {
      failed++;
      continue;
    }
    rows.push({ url: line.custom_id, set: fact.set, label: fact.label, age: fact.facts.accountAgeDays, merges: fact.facts.earlierPublicMerges, band: parsed.band, reasons: parsed.reasons, flagged: parsed.instructions_to_ai });
  }
  return { rows, input, output, failed };
}

export const balanced = (rows, isHigh) => {
  const low = rows.filter((r) => r.set === 'low_effort');
  const control = rows.filter((r) => r.set === 'control');
  if (!low.length || !control.length) return NaN;
  return (low.filter(isHigh).length / low.length + control.filter((r) => !isHigh(r)).length / control.length) / 2;
};

export const ruleFor = ([a, m]) => (r) => r.age < a || r.merges <= m;

export function bestRule(rows) {
  let best = null;
  for (const a of AGES) {
    for (const m of MERGES) {
      const score = balanced(rows, ruleFor([a, m]));
      if (!best || score > best.score) best = { pair: [a, m], score };
    }
  }
  return best;
}

// A small seeded generator, so the interval repeats exactly.
function generator(seed) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapDifference(rows, isRule, samples = 1000) {
  const random = generator('goodfaith-2026-11-05');
  const diffs = [];
  const isModel = (r) => r.band === 'high';
  for (let i = 0; i < samples; i++) {
    const draw = rows.map(() => rows[Math.floor(random() * rows.length)]);
    diffs.push(balanced(draw, isModel) - balanced(draw, isRule));
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(samples * 0.025)], diffs[Math.floor(samples * 0.975)]];
}

const percent = (x) => `${(x * 100).toFixed(1)}%`;

function report(scope, model) {
  const { rows, input, output, failed } = loadResults(scope, model);
  const price = PRICE[model] ?? [0, 0];
  console.log(`${scope} ${model}: ${rows.length} scored, ${failed} failed, ${input} input and ${output} output tokens, $${((input / 1e6) * price[0] + (output / 1e6) * price[1]).toFixed(2)}`);
  console.log('band      low_effort  control  unclear');
  for (const band of BANDS) {
    const count = (set) => rows.filter((r) => r.set === set && r.band === band).length;
    console.log(band.padEnd(10), String(count('low_effort')).padEnd(11), String(count('control')).padEnd(8), count('unclear'));
  }
  const low = rows.filter((r) => r.set === 'low_effort');
  const control = rows.filter((r) => r.set === 'control');
  console.log(`low-effort placed high ${percent(low.filter((r) => r.band === 'high').length / low.length)}, control not placed high ${percent(control.filter((r) => r.band !== 'high').length / control.length)}`);
  const model_ = balanced(rows, (r) => r.band === 'high');
  console.log(`balanced accuracy, model ${percent(model_)}`);
  const tuning = loadResults('tuning', model).rows;
  const best = bestRule(tuning);
  const isRule = ruleFor(best.pair);
  console.log(`plain rule from the tuning set: younger than ${best.pair[0]} days or at most ${best.pair[1]} merges, balanced accuracy here ${percent(balanced(rows, isRule))}`);
  const [from, to] = bootstrapDifference(rows, isRule);
  console.log(`model minus rule, 95% interval ${(from * 100).toFixed(1)} to ${(to * 100).toFixed(1)} points. ${from > 0 ? 'The model beats the rule.' : 'The model does not clearly beat the rule.'}`);
  console.log(`misses: ${low.filter((r) => r.band === 'low').length} low-effort in the low band, ${control.filter((r) => r.band === 'high').length} control in the high band`);
  console.log(`flagged text aimed at AI: ${rows.filter((r) => r.flagged).length}`);
  const labels = {};
  for (const r of low) {
    labels[r.label] ??= { n: 0, high: 0 };
    labels[r.label].n++;
    if (r.band === 'high') labels[r.label].high++;
  }
  console.log('by label', Object.entries(labels).map(([k, v]) => `${k}: ${v.high}/${v.n} high`).join(', '));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) report(process.argv[2], process.argv[3]);
