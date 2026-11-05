-- A vouch for someone vouched before used to write no ledger row. Pull request #8 on the demo hit this.
INSERT INTO "ledger_events" ("project_id", "pull_request_id", "kind", "cents", "actor", "note")
SELECT pr."project_id", pr."id", 'vouched', 0, 'leejpsd', 'recorded late, after a bug that skipped this row'
FROM "pull_requests" pr
WHERE pr."door" = 'choose'
  AND pr."status" = 'in_review'
  AND NOT EXISTS (SELECT 1 FROM "holds" h WHERE h."pull_request_id" = pr."id" AND h."authorized_at" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "ledger_events" l WHERE l."pull_request_id" = pr."id" AND l."kind" = 'vouched');
--> statement-breakpoint
-- Captures from before the column existed keep their time on the ledger.
UPDATE "holds" h
SET "captured_at" = (SELECT min(l."created_at") FROM "ledger_events" l WHERE l."hold_id" = h."id" AND l."kind" = 'captured')
WHERE h."capture_id" IS NOT NULL AND h."captured_at" IS NULL;
