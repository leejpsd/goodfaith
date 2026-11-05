import { randomUUID } from 'node:crypto';
import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  TransactionSearchController,
} from '@paypal/paypal-server-sdk';

// Sandbox only, on purpose. Nothing in this project can reach live PayPal.
const API = 'https://api-m.sandbox.paypal.com';
const ATTEMPTS = 3;

export class PayPalError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly issue: string | undefined;
  readonly debugId: string | undefined;

  constructor(operation: string, status: number, issue: string | undefined, debugId: string | undefined) {
    super(`PayPal ${operation} returned ${status}${issue ? ` ${issue}` : ''}${debugId ? ` [debug_id ${debugId}]` : ''}`);
    this.operation = operation;
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
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
  authorizeOrder(orderId: string, requestId: string, options?: { simulateDecline?: boolean }): Promise<{ authorizationId: string; status: string; payerId: string | null }>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<void>;
  reauthorize(authorizationId: string, cents: number, requestId: string): Promise<string>;
  capture(authorizationId: string, cents: number, requestId: string): Promise<{ captureId: string; status: string }>;
  refund(captureId: string, requestId: string): Promise<string>;
  payout(input: { cents: number; receiver: string; note: string; senderId: string }, requestId: string): Promise<string>;
  searchTransactions(start: Date, end: Date): Promise<string[]>;
  verifyWebhook(headers: WebhookHeaders, rawBody: string): Promise<boolean>;
}

const toValue = (cents: number) => (cents / 100).toFixed(2);
const usd = (cents: number) => ({ currencyCode: 'USD', value: toValue(cents) });
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

// The Server SDK covers orders, payments and transaction search. Its defaults are no retries
// and no timeout, so both are set here. POST is safe to retry because every money call carries
// a request ID, and a repeat of one returns the first result.
let sdk: Client | undefined;

function sdkClient(): Client {
  if (!sdk) {
    const { PAYPAL_CLIENT_ID: oAuthClientId, PAYPAL_CLIENT_SECRET: oAuthClientSecret } = process.env;
    if (!oAuthClientId || !oAuthClientSecret) throw new Error('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is not set');
    sdk = new Client({
      environment: Environment.Sandbox,
      clientCredentialsAuthCredentials: { oAuthClientId, oAuthClientSecret },
      timeout: 30_000,
      httpClientOptions: {
        timeout: 30_000,
        retryConfig: { maxNumberOfRetries: ATTEMPTS - 1, retryInterval: 1, backoffFactor: 2, maximumRetryWaitTime: 30, retryOnTimeout: true, httpStatusCodesToRetry: [429, 500, 502, 503, 504], httpMethodsToRetry: ['GET', 'POST'] },
      },
    });
  }
  return sdk;
}

function readBody(body: unknown): ErrorBody {
  return typeof body === 'string' ? parseError(body) : {};
}

// Every SDK failure becomes one PayPalError, so the rules above it never see the SDK's types.
async function viaSdk<T>(operation: string, run: () => Promise<{ result: T }>): Promise<T> {
  try {
    return (await run()).result;
  } catch (error) {
    if (!(error instanceof ApiError)) {
      const failure = new PayPalError(operation, 0, 'network', undefined);
      console.error(failure.message, error instanceof Error ? error.message : 'unknown error');
      throw failure;
    }
    const body = (error.result as ErrorBody | undefined) ?? readBody(error.body);
    const failure = new PayPalError(operation, error.statusCode, body.details?.[0]?.issue ?? body.name, body.debug_id ?? error.headers?.['paypal-debug-id']);
    console.error(failure.message);
    throw failure;
  }
}

const REPRESENTATION = 'return=representation';

// PayPal's own negative testing: the sandbox answers as if the payment method was declined.
const DECLINE = JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' });

export function paypalClient(): PayPal {
  const orders = () => new OrdersController(sdkClient());
  const payments = () => new PaymentsController(sdkClient());
  return {
    async createOrder({ cents, description, referenceId, returnUrl, cancelUrl }) {
      const order = await viaSdk('create order', () =>
        orders().createOrder({
          paypalRequestId: randomUUID(),
          prefer: REPRESENTATION,
          body: {
            intent: CheckoutPaymentIntent.Authorize,
            purchaseUnits: [{ referenceId, description, amount: usd(cents) }],
            paymentSource: {
              paypal: {
                experienceContext: {
                  brandName: 'Goodfaith',
                  shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                  userAction: PaypalExperienceUserAction.Continue,
                  returnUrl,
                  cancelUrl,
                },
              },
            },
          },
        }),
      );
      if (!order.id) throw new PayPalError('create order', 200, 'NO_ORDER_ID', undefined);
      return order.id;
    },
    async authorizeOrder(orderId, requestId, options) {
      const order = await viaSdk('authorize order', () =>
        orders().authorizeOrder({ id: orderId, paypalRequestId: requestId, prefer: REPRESENTATION, body: {}, ...(options?.simulateDecline ? { paypalMockResponse: DECLINE } : {}) }),
      );
      const authorization = order.purchaseUnits?.[0]?.payments?.authorizations?.[0];
      if (!authorization?.id) throw new PayPalError('authorize order', 200, 'NO_AUTHORIZATION', undefined);
      return { authorizationId: authorization.id, status: authorization.status ?? 'CREATED', payerId: order.paymentSource?.paypal?.accountId ?? order.payer?.payerId ?? null };
    },
    async voidAuthorization(authorizationId, requestId) {
      await viaSdk('void', () => payments().voidPayment({ authorizationId, paypalRequestId: requestId, prefer: REPRESENTATION }));
    },
    async reauthorize(authorizationId, cents, requestId) {
      const authorization = await viaSdk('reauthorize', () => payments().reauthorizePayment({ authorizationId, paypalRequestId: requestId, prefer: REPRESENTATION, body: { amount: usd(cents) } }));
      if (!authorization.id) throw new PayPalError('reauthorize', 200, 'NO_AUTHORIZATION', undefined);
      return authorization.id;
    },
    async capture(authorizationId, cents, requestId) {
      const capture = await viaSdk('capture', () =>
        payments().captureAuthorizedPayment({ authorizationId, paypalRequestId: requestId, prefer: REPRESENTATION, body: { amount: usd(cents), finalCapture: true } }),
      );
      if (!capture.id) throw new PayPalError('capture', 200, 'NO_CAPTURE_ID', undefined);
      return { captureId: capture.id, status: capture.status ?? 'COMPLETED' };
    },
    async refund(captureId, requestId) {
      const refund = await viaSdk('refund', () => payments().refundCapturedPayment({ captureId, paypalRequestId: requestId, prefer: REPRESENTATION, body: {} }));
      if (!refund.id) throw new PayPalError('refund', 200, 'NO_REFUND_ID', undefined);
      return refund.id;
    },
    // One page of 500 is plenty for this demo's volume, and each run looks at a short range.
    async searchTransactions(start, end) {
      const found = await viaSdk('transaction search', () =>
        new TransactionSearchController(sdkClient()).searchTransactions({
          startDate: `${start.toISOString().slice(0, 19)}Z`,
          endDate: `${end.toISOString().slice(0, 19)}Z`,
          fields: 'transaction_info',
          pageSize: 500,
        }),
      );
      return (found.transactionDetails ?? []).flatMap((detail) => (detail.transactionInfo?.transactionId ? [detail.transactionInfo.transactionId] : []));
    },
    // The SDK has no Payouts or webhook verification, so these two stay on REST.
    async payout({ cents, receiver, note, senderId }, requestId) {
      const j = await call<{ batch_header: { payout_batch_id: string } }>(
        'payout',
        '/v1/payments/payouts',
        JSON.stringify({
          sender_batch_header: { sender_batch_id: senderId, email_subject: 'A forfeited Goodfaith hold', email_message: note },
          items: [{ recipient_type: 'EMAIL', amount: { value: toValue(cents), currency: 'USD' }, receiver, note, sender_item_id: senderId }],
        }),
        requestId,
      );
      return j.batch_header.payout_batch_id;
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
