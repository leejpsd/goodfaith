import { randomUUID } from 'node:crypto';

// Sandbox only, on purpose. Nothing in this project can reach live PayPal.
const API = 'https://api-m.sandbox.paypal.com';
const ATTEMPTS = 3;

export class PayPalError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly issue: string | undefined,
    readonly debugId: string | undefined,
  ) {
    super(`PayPal ${operation} returned ${status}${issue ? ` ${issue}` : ''}${debugId ? ` [debug_id ${debugId}]` : ''}`);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export interface WebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

// What the hold needs from PayPal. Tests replace this with a fake. Every money call takes
// a request ID, so a retry returns the first result and cannot move money twice.
export interface PayPal {
  createOrder(input: { cents: number; description: string; referenceId: string; returnUrl: string; cancelUrl: string }): Promise<string>;
  authorizeOrder(orderId: string, requestId: string): Promise<{ authorizationId: string; status: string }>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<void>;
  reauthorize(authorizationId: string, cents: number, requestId: string): Promise<string>;
  capture(authorizationId: string, cents: number, requestId: string): Promise<{ captureId: string; status: string }>;
  refund(captureId: string, requestId: string): Promise<string>;
  payout(input: { cents: number; receiver: string; note: string; senderId: string }, requestId: string): Promise<string>;
  searchTransactions(start: Date, end: Date): Promise<string[]>;
  verifyWebhook(headers: WebhookHeaders, rawBody: string): Promise<boolean>;
}

const usd = (cents: number) => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function credentials() {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is not set');
  return Buffer.from(`${id}:${secret}`).toString('base64');
}

let cached: { token: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new PayPalError('token', r.status, undefined, r.headers.get('paypal-debug-id') ?? undefined);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

interface ErrorBody {
  name?: string;
  debug_id?: string;
  details?: { issue?: string }[];
}

// A gateway error can be an HTML page, which still has to reach the retry below.
function parseError(text: string): ErrorBody {
  try {
    return JSON.parse(text) as ErrorBody;
  } catch {
    return {};
  }
}

async function read<T>(operation: string, path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new PayPalError(operation, r.status, undefined, r.headers.get('paypal-debug-id') ?? undefined);
  return (await r.json()) as T;
}

async function call<T>(operation: string, path: string, body: string | undefined, requestId: string): Promise<T> {
  let failure: PayPalError | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await sleep(500 * 2 ** attempt);
    let r: Response;
    try {
      r = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          'PayPal-Request-Id': requestId,
        },
        body: body ?? '{}',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      failure = new PayPalError(operation, 0, 'network', undefined);
      continue;
    }
    if (r.status === 401) cached = undefined;
    const text = await r.text();
    if (r.ok) return (text ? JSON.parse(text) : {}) as T;

    const error = parseError(text);
    failure = new PayPalError(operation, r.status, error.details?.[0]?.issue ?? error.name, error.debug_id ?? r.headers.get('paypal-debug-id') ?? undefined);
    if (!failure.retryable && r.status !== 401) break;
  }
  console.error(failure!.message);
  throw failure;
}

export function paypalClient(): PayPal {
  return {
    async createOrder({ cents, description, referenceId, returnUrl, cancelUrl }) {
      const order = await call<{ id: string }>(
        'create order',
        '/v2/checkout/orders',
        JSON.stringify({
          intent: 'AUTHORIZE',
          purchase_units: [{ reference_id: referenceId, description, amount: usd(cents) }],
          payment_source: {
            paypal: {
              experience_context: { brand_name: 'Goodfaith', shipping_preference: 'NO_SHIPPING', user_action: 'CONTINUE', return_url: returnUrl, cancel_url: cancelUrl },
            },
          },
        }),
        randomUUID(),
      );
      return order.id;
    },
    async authorizeOrder(orderId, requestId) {
      const order = await call<{ purchase_units?: { payments?: { authorizations?: { id: string; status: string }[] } }[] }>(
        'authorize order',
        `/v2/checkout/orders/${orderId}/authorize`,
        undefined,
        requestId,
      );
      const authorization = order.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!authorization) throw new PayPalError('authorize order', 200, 'NO_AUTHORIZATION', undefined);
      return { authorizationId: authorization.id, status: authorization.status };
    },
    async voidAuthorization(authorizationId, requestId) {
      await call('void', `/v2/payments/authorizations/${authorizationId}/void`, undefined, requestId);
    },
    async reauthorize(authorizationId, cents, requestId) {
      const j = await call<{ id: string }>('reauthorize', `/v2/payments/authorizations/${authorizationId}/reauthorize`, JSON.stringify({ amount: usd(cents) }), requestId);
      return j.id;
    },
    async capture(authorizationId, cents, requestId) {
      const j = await call<{ id: string; status: string }>(
        'capture',
        `/v2/payments/authorizations/${authorizationId}/capture`,
        JSON.stringify({ amount: usd(cents), final_capture: true }),
        requestId,
      );
      return { captureId: j.id, status: j.status };
    },
    async refund(captureId, requestId) {
      return (await call<{ id: string }>('refund', `/v2/payments/captures/${captureId}/refund`, undefined, requestId)).id;
    },
    async payout({ cents, receiver, note, senderId }, requestId) {
      const j = await call<{ batch_header: { payout_batch_id: string } }>(
        'payout',
        '/v1/payments/payouts',
        JSON.stringify({
          sender_batch_header: { sender_batch_id: senderId, email_subject: 'A forfeited Goodfaith hold', email_message: note },
          items: [{ recipient_type: 'EMAIL', amount: { value: (cents / 100).toFixed(2), currency: 'USD' }, receiver, note, sender_item_id: senderId }],
        }),
        requestId,
      );
      return j.batch_header.payout_batch_id;
    },
    // One page of 500 is plenty for this demo's volume, and each run looks at a short range.
    async searchTransactions(start, end) {
      const range = `start_date=${start.toISOString().slice(0, 19)}Z&end_date=${end.toISOString().slice(0, 19)}Z`;
      const j = await read<{ transaction_details?: { transaction_info: { transaction_id: string } }[] }>(
        'transaction search',
        `/v1/reporting/transactions?${range}&fields=transaction_info&page_size=500`,
      );
      return (j.transaction_details ?? []).map((t) => t.transaction_info.transaction_id);
    },
    async verifyWebhook(headers, rawBody) {
      const webhookId = process.env.PAYPAL_WEBHOOK_ID;
      if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not set');
      // The event goes in as received. Parsing and re-serializing it would change the
      // bytes PayPal signed, and verification would fail.
      const envelope = JSON.stringify({
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: webhookId,
      });
      const body = `${envelope.slice(0, -1)},"webhook_event":${rawBody}}`;
      const j = await call<{ verification_status: string }>('verify webhook', '/v1/notifications/verify-webhook-signature', body, randomUUID());
      return j.verification_status === 'SUCCESS';
    },
  };
}
