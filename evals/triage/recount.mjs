#!/usr/bin/env node
// Re-derives the published numbers from what this repository carries, with no key and no
// network. The raw results hold third-party pull request text, so they stay out of the
// repository. src/lib/console/evidence.json keeps one row per held-out pull request: its
// repository, set, label, the model's band, and whether the plain rule would have charged most.
//   node evals/triage/recount.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanced, bootstrapDifference } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { evaluation, doors } = JSON.parse(readFileSync(join(here, '../../src/lib/console/evidence.json'), 'utf8'));
const percent = (x) => `${(x * 100).toFixed(1)}%`;
const isModel = (r) => r.band === 'high';
const isRule = (r) => r.rule === 'high';
const of = (set) => evaluation.filter((r) => r.set === set);
const [low, control, unclear] = [of('low_effort'), of('control'), of('unclear')];
const [from, to] = bootstrapDifference(evaluation, isRule);

console.log(`held-out pull requests: ${evaluation.length} (${low.length} labelled low effort, ${control.length} merged first-timers, ${unclear.length} unclear)`);
console.log(`balanced accuracy on the ${low.length + control.length} with a clear outcome: model ${percent(balanced(evaluation, isModel))}, plain rule ${percent(balanced(evaluation, isRule))}`);
console.log(`95% interval for the difference: ${(from * 100).toFixed(1)} to ${(to * 100).toFixed(1)} points`);
console.log(`labelled low effort in the high band: ${low.filter(isModel).length} of ${low.length} (${percent(low.filter(isModel).length / low.length)})`);
console.log(`merged first-timers charged most: model ${control.filter(isModel).length}, plain rule ${control.filter(isRule).length}, of ${control.length}`);
console.log(`misses listed: ${evaluation.filter((r) => r.miss).length}`);
const band = (name) => doors.filter((r) => r.band === name).length;
console.log(`closed by a bot and sized: ${doors.length} (low ${band('low')}, medium ${band('medium')}, high ${band('high')}), later merged ${doors.filter((r) => r.laterMerged).length}`);
