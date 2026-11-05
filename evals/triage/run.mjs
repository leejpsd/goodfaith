#!/usr/bin/env node
// Runs the product's own prompt over the collected pull requests through OpenAI's Batch API,
// which costs half as much and can take up to a day. See RULES.md for what may run when.
//   node --experimental-strip-types evals/triage/run.mjs submit <tuning|heldout> <model> <max-dollars>
//   node --experimental-strip-types evals/triage/run.mjs status
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFacts, SCHEMA, SYSTEM } from '../../src/lib/triage/triage.ts';

const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, 'data');
process.loadEnvFile(join(here, '../../.env.local'));
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY is not set');

// Batch prices per million tokens, and an estimate of 3.5 characters a token. The real usage
// comes back with each result, and the score script reports it.
const PRICE = { 'gpt-6.1-sol': [1, 5], 'gpt-6-luna': [0.05, 0.25] };
const OUTPUT_TOKENS = 300;

const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const auth = { Authorization: `Bearer ${key}` };

async function submit(scope, model, maxDollars) {
  const price = PRICE[model];
  if (!price) throw new Error(`no price for ${model}`);
  const rows = readLines(join(data, 'facts.jsonl')).filter((r) => r.facts && (scope === 'tuning' ? r.tuning : !r.tuning));
  const lines = rows.map((r) =>
    JSON.stringify({
      custom_id: r.url,
      method: 'POST',
      url: '/v1/responses',
      body: { model, instructions: SYSTEM, input: renderFacts(r.facts), store: false, text: { format: { type: 'json_schema', name: 'triage', strict: true, schema: SCHEMA } } },
    }),
  );
  const chars = rows.reduce((sum, r) => sum + renderFacts(r.facts).length + SYSTEM.length, 0);
  const estimate = (chars / 3.5 / 1e6) * price[0] + ((rows.length * OUTPUT_TOKENS) / 1e6) * price[1];
  console.log(`${scope} ${model}: ${rows.length} pull requests, estimated $${estimate.toFixed(2)}`);
  if (estimate > maxDollars) throw new Error(`estimate is over the limit of $${maxDollars}`);

  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([`${lines.join('\n')}\n`], { type: 'application/jsonl' }), `${scope}-${model}.jsonl`);
  const file = await fetch('https://api.openai.com/v1/files', { method: 'POST', headers: auth, body: form });
  const fileJson = await file.json();
  if (!file.ok) throw new Error(`file upload returned ${file.status} ${fileJson.error?.code ?? ''} ${fileJson.error?.message ?? ''}`);
  const batch = await fetch('https://api.openai.com/v1/batches', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_file_id: fileJson.id, endpoint: '/v1/responses', completion_window: '24h' }),
  });
  const batchJson = await batch.json();
  if (!batch.ok) throw new Error(`batch returned ${batch.status} ${batchJson.error?.code ?? ''} ${batchJson.error?.message ?? ''}`);
  appendFileSync(join(data, 'batches.jsonl'), `${JSON.stringify({ id: batchJson.id, scope, model, count: rows.length, estimate, at: new Date().toISOString() })}\n`);
  console.log('submitted', batchJson.id, batchJson.status);
}

async function status() {
  for (const b of readLines(join(data, 'batches.jsonl'))) {
    const r = await fetch(`https://api.openai.com/v1/batches/${b.id}`, { headers: auth });
    const j = await r.json();
    console.log(b.scope, b.model, j.status, JSON.stringify(j.request_counts ?? {}), j.errors?.data?.[0]?.message ?? '');
    const out = join(data, `results-${b.scope}-${b.model}.jsonl`);
    if (j.output_file_id && !existsSync(out)) {
      const content = await fetch(`https://api.openai.com/v1/files/${j.output_file_id}/content`, { headers: auth });
      writeFileSync(out, await content.text());
      console.log(' saved', out.split('/').pop());
    }
  }
}

const [stage, scope, model, max] = process.argv.slice(2);
if (stage === 'submit') await submit(scope, model, Number(max));
else if (stage === 'status') await status();
else throw new Error(`unknown stage ${stage}`);
