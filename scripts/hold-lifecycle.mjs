#!/usr/bin/env node
// Tests a hold's lifecycle against the real PayPal sandbox, using four small holds, with the
// same calls the app makes. The late checks need real elapsed days, so the state file keeps
// every timestamp. Sandbox only: the base URL cannot point at live. Prints no token or secret.
// Our own run, with its IDs and dates, is in docs/hold-lifecycle.md.
//   node scripts/hold-lifecycle.mjs <command>, with PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local
//   start      creates the orders and prints one approval link each
//   authorize  turns approved orders into holds
//   now        void, capture retry, double capture, refund, early reauthorize
//   late       capture and reauthorize after the 3-day honor period (--force to try early)
//   events     lists the webhook event names for authorizations, captures and payouts
//   status     shows every hold as PayPal reports it
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const override = process.env.PAYPAL_PROBE_BASE_URL;
if (override && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override)) {
  console.error('PAYPAL_PROBE_BASE_URL may only point at localhost.');
  process.exit(2);
}
const BASE = override || SANDBOX;
const HOLDS = ['late-capture', 'reauthorize', 'void', 'refund'];
const HONOR_MS = 3 * 864e5;

// Kept out of git, so a run with your own sandbox account starts fresh.
const statePath = join(root, override ? '.hold-lifecycle.mock.json' : '.hold-lifecycle.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { runId: randomUUID().slice(0, 8), holds: {}, log: [] };
const save = () => {
  mkdirSync(dirname(statePath), { recursive: true });
  const times = Object.values(state.holds).map((h) => h.authorizedAt).filter(Boolean).map(Date.parse);
  if (times.length) state.lateDueAt = new Date(Math.max(...times) + HONOR_MS + 36e5).toISOString();
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
};
const record = (status, check, detail = '', debugId) => {
  state.log.push({ at: new Date().toISOString(), status, check, detail, ...(debugId ? { debugId } : {}) });
  console.log(`${status.padEnd(8)} ${check}${detail ? ` - ${detail}` : ''}${debugId ? ` [debug_id ${debugId}]` : ''}`);
};

const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET. Put sandbox credentials in .env.local.');
  process.exit(2);
}

let token;
async function auth() {
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    console.error(`OAuth failed: ${r.status} ${j.error ?? ''}`);
    process.exit(1);
  }
  token = j.access_token;
}

async function call(method, path, { body, requestId } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(method === 'POST' ? { 'PayPal-Request-Id': requestId ?? randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* empty 204 or non-JSON error page */ }
  return { status: r.status, ok: r.status < 300, json, debugId: json.debug_id || r.headers.get('paypal-debug-id') || undefined };
}
const reason = (r) => [r.status, r.json.name, r.json.details?.[0]?.issue].filter(Boolean).join(' ');
const days = (ms) => (ms / 864e5).toFixed(2);

function requireHold(key) {
  const h = state.holds[key];
  if (!h?.authorizationId) {
    record('SKIP', `${key} hold`, 'no authorization yet, run start and authorize first');
    return null;
  }
  return h;
}

async function start() {
  for (const key of HOLDS) {
    if (state.holds[key]) {
      console.log(`EXISTS   ${key} order ${state.holds[key].orderId}${state.holds[key].approveUrl ? ` ${state.holds[key].approveUrl}` : ''}`);
      continue;
    }
    const r = await call('POST', '/v2/checkout/orders', {
      requestId: `lifecycle-${state.runId}-${key}-order`,
      body: {
        intent: 'AUTHORIZE',
        purchase_units: [{ reference_id: key, description: `Hold test: ${key}`, amount: { currency_code: 'USD', value: '5.00' } }],
        payment_source: { paypal: { experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
      },
    });
    const approveUrl = r.json.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (!r.ok || !approveUrl) {
      record('FAIL', `${key} order, intent AUTHORIZE`, reason(r), r.debugId);
      continue;
    }
    state.holds[key] = { orderId: r.json.id, approveUrl, createdAt: new Date().toISOString() };
    record('OK', `${key} order, intent AUTHORIZE`, r.json.id);
    console.log(`         Approve with the sandbox Personal account: ${approveUrl}`);
  }
}

async function authorize() {
  for (const key of HOLDS) {
    const h = state.holds[key];
    if (!h) { record('SKIP', `${key} hold`, 'no order, run start first'); continue; }
    if (h.authorizationId) { console.log(`EXISTS   ${key} authorization ${h.authorizationId}`); continue; }
    const order = await call('GET', `/v2/checkout/orders/${h.orderId}`);
    if (order.json.status !== 'APPROVED') {
      record('WAIT', `${key} approval`, `order is ${order.json.status ?? reason(order)}: ${h.approveUrl}`);
      continue;
    }
    const r = await call('POST', `/v2/checkout/orders/${h.orderId}/authorize`, { requestId: `lifecycle-${state.runId}-${key}-authorize`, body: {} });
    const a = r.json.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!r.ok || !a) {
      record('FAIL', `${key} authorize`, reason(r), r.debugId);
      continue;
    }
    Object.assign(h, { authorizationId: a.id, authorizedAt: new Date().toISOString(), expirationTime: a.expiration_time });
    record('OK', `${key} authorize`, `${a.id} ${a.status}, expires ${a.expiration_time}`);
  }
}

async function now() {
  const v = requireHold('void');
  if (v && !v.voided) {
    const r = await call('POST', `/v2/payments/authorizations/${v.authorizationId}/void`);
    if (r.ok) { v.voided = true; record('OK', 'void a hold', 'the good-faith path'); }
    else record('FAIL', 'void a hold', reason(r), r.debugId);
  }
  if (v?.voided) {
    const r = await call('POST', `/v2/payments/authorizations/${v.authorizationId}/capture`, { body: { final_capture: true } });
    if (r.ok) record('FAIL', 'capture after void is refused', 'PayPal accepted it, the design must change');
    else record('OK', 'capture after void is refused', reason(r));
  }

  const f = requireHold('refund');
  if (f) {
    const requestId = `lifecycle-${state.runId}-refund-capture`;
    const first = await call('POST', `/v2/payments/authorizations/${f.authorizationId}/capture`, { requestId, body: { final_capture: true } });
    if (!first.ok) {
      record('FAIL', 'capture a fresh hold', reason(first), first.debugId);
    } else {
      f.captureId = first.json.id;
      record('OK', 'capture a fresh hold', first.json.id);
      const retry = await call('POST', `/v2/payments/authorizations/${f.authorizationId}/capture`, { requestId, body: { final_capture: true } });
      if (retry.ok && retry.json.id === first.json.id) record('OK', 'retry with the same PayPal-Request-Id', 'same capture id, no double charge');
      else record('FAIL', 'retry with the same PayPal-Request-Id', `${reason(retry)} id ${retry.json.id ?? 'none'}`, retry.debugId);
      const second = await call('POST', `/v2/payments/authorizations/${f.authorizationId}/capture`, { body: { final_capture: true } });
      if (second.ok) record('FAIL', 'second capture with a new id is refused', `PayPal accepted it: ${second.json.id}`);
      else record('OK', 'second capture with a new id is refused', reason(second));
    }
  }
  if (f?.captureId && !f.refundId) {
    const r = await call('POST', `/v2/payments/captures/${f.captureId}/refund`, { requestId: `lifecycle-${state.runId}-refund`, body: {} });
    if (r.ok) { f.refundId = r.json.id; record('OK', 'refund a reversed forfeit', `${r.json.id} ${r.json.status}`); }
    else record('FAIL', 'refund a reversed forfeit', reason(r), r.debugId);
  }

  const e = requireHold('reauthorize');
  if (e && !e.reauthorizedId) {
    const r = await call('POST', `/v2/payments/authorizations/${e.authorizationId}/reauthorize`, { body: {} });
    if (r.ok) {
      e.reauthorizedId = r.json.id;
      record('NOTE', 'reauthorize inside the honor period', `PayPal accepted it: ${r.json.id}. The late test now captures this id`);
    } else record('NOTE', 'reauthorize inside the honor period', `refused, as the guides describe: ${reason(r)}`);
  }
}

async function late() {
  const force = process.argv.includes('--force');
  for (const key of ['late-capture', 'reauthorize']) {
    const h = requireHold(key);
    if (!h) continue;
    const elapsed = Date.now() - Date.parse(h.authorizedAt);
    if (elapsed < HONOR_MS && !force) {
      record('WAIT', `${key} late test`, `${days(elapsed)} days elapsed, due at ${new Date(Date.parse(h.authorizedAt) + HONOR_MS + 36e5).toISOString()}`);
      continue;
    }
    if (key === 'reauthorize' && !h.reauthorizedId) {
      const r = await call('POST', `/v2/payments/authorizations/${h.authorizationId}/reauthorize`, { requestId: `lifecycle-${state.runId}-reauthorize`, body: {} });
      if (r.ok) { h.reauthorizedId = r.json.id; h.reauthorizedAt = new Date().toISOString(); record('OK', `reauthorize at ${days(elapsed)} days`, `new id ${r.json.id}, expires ${r.json.expiration_time}`); }
      else { record('FAIL', `reauthorize at ${days(elapsed)} days`, reason(r), r.debugId); continue; }
    }
    if (h.lateCaptureId) { console.log(`EXISTS   ${key} capture ${h.lateCaptureId}`); continue; }
    const target = key === 'reauthorize' ? h.reauthorizedId : h.authorizationId;
    const r = await call('POST', `/v2/payments/authorizations/${target}/capture`, { requestId: `lifecycle-${state.runId}-${key}-late`, body: { final_capture: true } });
    if (r.ok) { h.lateCaptureId = r.json.id; record('OK', `${key}: capture at ${days(elapsed)} days`, `${r.json.id} ${r.json.status}`); }
    else record('FAIL', `${key}: capture at ${days(elapsed)} days`, reason(r), r.debugId);
  }
}

async function events() {
  const r = await call('GET', '/v1/notifications/webhooks-event-types');
  if (!r.ok) return record('FAIL', 'webhook event types', reason(r), r.debugId);
  const names = (r.json.event_types ?? []).map((e) => e.name).filter((n) => /AUTHORIZATION|CAPTURE|PAYOUTS/.test(n)).sort();
  state.webhookEvents = names;
  record('OK', 'webhook event types', `${names.length} match`);
  names.forEach((n) => console.log(`         ${n}`));
}

async function status() {
  for (const key of HOLDS) {
    const h = state.holds[key];
    if (!h?.authorizationId) { console.log(`${key.padEnd(13)} ${h ? 'order only' : 'not started'}`); continue; }
    const ids = [h.authorizationId, h.reauthorizedId].filter(Boolean);
    for (const aid of ids) {
      const r = await call('GET', `/v2/payments/authorizations/${aid}`);
      console.log(`${key.padEnd(13)} ${aid} ${r.ok ? r.json.status : reason(r)}, ${days(Date.now() - Date.parse(h.authorizedAt))} days since authorize`);
    }
  }
  if (state.lateDueAt) console.log(`Late test due at ${state.lateDueAt}`);
}

const commands = { start, authorize, now, late, events, status };
const command = commands[process.argv[2]];
if (!command) {
  console.error(`usage: hold-lifecycle.mjs ${Object.keys(commands).join('|')} [--force]`);
  process.exit(2);
}
await auth();
await command();
save();
const failed = state.log.filter((l) => l.status === 'FAIL').length;
console.log(`\nSaved ${statePath.replace(`${root}/`, '')}. ${failed} failed checks so far.`);
process.exit(failed ? 1 : 0);
