-- The first hold's PayPal webhook arrived on 2026-11-05 before the code that marks a hold row as
-- confirmed existed, so its row stayed "not yet". This marks it only if that exact delivery is on record.
UPDATE "ledger_events" SET "reconciled_at" = now()
WHERE "kind" = 'held' AND "paypal_id" = '2PA68823PB968234L' AND "reconciled_at" IS NULL
  AND EXISTS (SELECT 1 FROM "webhook_deliveries" WHERE "source" = 'paypal' AND "delivery_id" = 'WH-7CM96128XE517704R-0NH76196GN0948428');
