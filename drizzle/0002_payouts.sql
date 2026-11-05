ALTER TABLE "holds" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "holds" ADD COLUMN "payout_batch_id" text;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD COLUMN "searched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "payout_receiver" text;