CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"state" text NOT NULL,
	"cents" integer NOT NULL,
	"order_id" text NOT NULL,
	"authorization_id" text,
	"authorized_at" timestamp with time zone,
	"reauthorized" boolean DEFAULT false NOT NULL,
	"appeal_ends_at" timestamp with time zone,
	"capture_id" text,
	"refund_id" text,
	"forfeited_by" text,
	"forfeit_reason" text,
	"appeal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holds_pull_request_id_unique" UNIQUE("pull_request_id")
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"hold_id" uuid,
	"kind" text NOT NULL,
	"cents" integer DEFAULT 0 NOT NULL,
	"paypal_id" text,
	"actor" text,
	"note" text,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"min_cents" integer DEFAULT 200 NOT NULL,
	"max_cents" integer DEFAULT 2500 NOT NULL,
	"default_cents" integer DEFAULT 500 NOT NULL,
	"appeal_days" integer DEFAULT 7 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_owner_repo" UNIQUE("owner","repo")
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"author_login" text NOT NULL,
	"author_association" text NOT NULL,
	"title" text NOT NULL,
	"html_url" text NOT NULL,
	"door" text NOT NULL,
	"status" text NOT NULL,
	"check_run_id" bigint,
	"gate_comment_id" bigint,
	"triage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_project_number" UNIQUE("project_id","number")
);
--> statement-breakpoint
CREATE TABLE "vouches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"login" text NOT NULL,
	"vouched_by" text NOT NULL,
	"pull_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouches_project_login" UNIQUE("project_id","login")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"source" text NOT NULL,
	"delivery_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_source_delivery_id_pk" PRIMARY KEY("source","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouches" ADD CONSTRAINT "vouches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouches" ADD CONSTRAINT "vouches_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_events_created_at" ON "ledger_events" USING btree ("created_at");