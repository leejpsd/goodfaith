# What APIMatic's PayPal Context Plugin changed

Goodfaith's PayPal client was first written against the REST API by hand. On 2026-11-05 the coding agent (Claude Code) installed APIMatic's PayPal Context Plugin, following APIMatic's instructions, and read its TypeScript guidance before moving orders, payments and transaction search to `@paypal/paypal-server-sdk` 2.5.0. These are the changes that came from the plugin, all in [`src/lib/paypal/client.ts`](../src/lib/paypal/client.ts).

| What the plugin told us | What we did | Where |
|---|---|---|
| The SDK has no timeout by default | 30 seconds on the client and on each HTTP call | [line 135](../src/lib/paypal/client.ts#L135) |
| The SDK does not retry by default, and does not retry POST even when retries are on | Up to 3 attempts with backoff on 429 and 5xx, POST included. That is safe only because every money call carries a `PayPal-Request-Id`, so a repeat returns the first result | [line 147](../src/lib/paypal/client.ts#L147) |
| Failures arrive as `ApiError` with the status, body and headers | One `PayPalError` with the status, PayPal's issue code and its `debug_id`, so the money rules never see SDK types | [line 159](../src/lib/paypal/client.ts#L159) |
| Calls take a `prefer` header | `return=representation`, so an authorization returns its ID and the payer in one call | [line 175](../src/lib/paypal/client.ts#L175) |
| Calls take a mock-response parameter | A real sandbox `INSTRUMENT_DECLINED` for the demo's decline, instead of a fake one in our code | [line 178](../src/lib/paypal/client.ts#L178) |

Payouts and webhook signature verification stay on REST, because the SDK has neither.

## How it was checked

Against the real sandbox, through the same client the app uses:

- **No money moved, 2026-11-05.** An order was created, a transaction search ran, and PayPal refused, as it should, to capture or void a voided hold, to refund a refunded capture, and to authorize an order nobody approved.
- **Money moved, 2026-11-06.** A person approved two $2.00 orders. One was authorized and voided. The other was authorized, captured, captured again with the same request ID, which returned the same capture (`6SK33786XB396403W`) and no second charge, then refunded.

The plugin's claim form goes to APIMatic separately.
