# The hold lifecycle, tested on the PayPal sandbox

[`scripts/hold-lifecycle.mjs`](../scripts/hold-lifecycle.mjs) makes the same Orders v2 and Payments v2 calls the app makes, on four $5 holds in the PayPal sandbox. PayPal's clock cannot be moved, so the checks after the 3-day honor period ran on holds that had really aged. This is our own run. Every ID below is a sandbox ID.

## What it showed

- **A void blocks any later capture.** PayPal answers `AUTHORIZATION_VOIDED`, so a released hold cannot be taken.
- **A retry with the same `PayPal-Request-Id` returns the first capture**, with the same capture ID, so a repeated call never charges twice. A second capture with a new request ID is refused with `AUTHORIZATION_ALREADY_CAPTURED`.
- **A refund of a capture completes**, which is what `!reverse` does.
- **Reauthorizing inside the honor period is refused** with `REAUTHORIZATION_TOO_SOON`.
- **At 3.33 days, after the honor period, both paths worked.** Capturing the original authorization completed. Reauthorizing returned a new authorization ID that kept the original 29-day expiry, and capturing that ID completed. Afterwards PayPal reported the original authorization as `CAPTURED` too.

So PayPal accepts both halves of the app's forfeit path on an aged hold. The app reauthorizes from day 4. Before that, or if PayPal refuses the reauthorization, it captures the original. These runs come from the script: no forfeit in the live app has come that late yet.

## Every check, in order

| When | Check | Result | PayPal's answer |
|---|---|---|---|
| 2026-11-05 04:58 UTC | late-capture order, intent AUTHORIZE | OK | 3XG814415R043905U |
| 2026-11-05 04:58 UTC | reauthorize order, intent AUTHORIZE | OK | 8DF00986FY025500D |
| 2026-11-05 04:58 UTC | void order, intent AUTHORIZE | OK | 2CP7528705146750U |
| 2026-11-05 04:58 UTC | refund order, intent AUTHORIZE | OK | 71E10121X7856205L |
| 2026-11-05 05:12 UTC | late-capture authorize | OK | 13208202VJ536103S CREATED, expires 2026-12-04T05:12:50Z |
| 2026-11-05 05:12 UTC | reauthorize authorize | OK | 4MP02417L1880341M CREATED, expires 2026-12-04T05:12:52Z |
| 2026-11-05 05:12 UTC | void authorize | OK | 2E146166XJ226935F CREATED, expires 2026-12-04T05:12:54Z |
| 2026-11-05 05:12 UTC | refund authorize | OK | 1LB33928WC1442425 CREATED, expires 2026-12-04T05:12:57Z |
| 2026-11-05 05:12 UTC | void a hold | OK | the good-faith path |
| 2026-11-05 05:13 UTC | capture after void is refused | OK | 422 UNPROCESSABLE_ENTITY AUTHORIZATION_VOIDED |
| 2026-11-05 05:13 UTC | capture a fresh hold | OK | 9G5165412D673000E |
| 2026-11-05 05:13 UTC | retry with the same PayPal-Request-Id | OK | same capture id, no double charge |
| 2026-11-05 05:13 UTC | second capture with a new id is refused | OK | 422 UNPROCESSABLE_ENTITY AUTHORIZATION_ALREADY_CAPTURED |
| 2026-11-05 05:13 UTC | refund a reversed forfeit | OK | 3N0288945B9200222 COMPLETED |
| 2026-11-05 05:13 UTC | reauthorize inside the honor period | NOTE | refused, as the guides describe: 422 UNPROCESSABLE_ENTITY REAUTHORIZATION_TOO_SOON |
| 2026-11-08 13:04 UTC | late-capture: capture at 3.33 days | OK | 68H66354K6717341Y COMPLETED |
| 2026-11-08 13:04 UTC | reauthorize at 3.33 days | OK | new id 9M164574U13472607, expires 2026-12-04T05:12:53Z |
| 2026-11-08 13:04 UTC | reauthorize: capture at 3.33 days | OK | 86N47700BB8823321 COMPLETED |

## Changes made outside the app, on the live demo

These happened on the demo project and are on the [public ledger](https://goodfaith.onrender.com/ledger), each confirmed by a signed PayPal webhook and answered by a comment on the pull request.

| Pull request | What happened | Where | PayPal ID | What the app did |
|---|---|---|---|---|
| [goodfaith-demo#12](https://github.com/leejpsd/goodfaith-demo/pull/12) | A full refund, after the payout | The seller's PayPal dashboard | `72254226BN7565528` | Moved the hold to refunded, and recorded "changed outside this app" |
| [goodfaith-demo#4](https://github.com/leejpsd/goodfaith-demo/pull/4) | A dispute, after the payout | The buyer's PayPal account | `PP-R-EQE-10197137` | Recorded the dispute, and that the payout had already gone out |

PayPal kept its $1.36 fee when #12 was refunded in full, so a refund costs the operator the fee as well as the $25.00. PayPal also reports a $0.25 fee on each payout batch, charged to the sending account, and the payout does not take it out: #13 captured $25.00, kept $23.64 after PayPal's $1.36, and paid out $23.64, which left the operator $0.25 down. A dispute that opens before the payout stops the payout. That path is covered by a unit test, not by this run.

## What it did not test

Voiding a hold after it was reauthorized. PayPal's Payments schema lists `CANNOT_BE_VOIDED`: a reauthorization cannot be voided, and the original authorization must be voided instead. The app tries the new one and, when PayPal refuses, the one it replaced ([`hold-flow.ts`](../src/server/hold-flow.ts), `voidHold`). That fallback is covered by a unit test, not by a sandbox run.

## Run it yourself

With sandbox REST credentials in `.env.local` (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`):

```sh
node scripts/hold-lifecycle.mjs start      # four orders, and an approval link for each
node scripts/hold-lifecycle.mjs authorize  # after approving them with a sandbox personal account
node scripts/hold-lifecycle.mjs now        # void, capture retry, double capture, refund, early reauthorize
node scripts/hold-lifecycle.mjs late       # after 3 days: capture, and reauthorize then capture
node scripts/hold-lifecycle.mjs status     # every hold as PayPal reports it
```

The run is kept in `.hold-lifecycle.json`, which git ignores.
