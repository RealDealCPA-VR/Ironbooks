-- "Needs attention" home inbox (team home).
--
-- 1. attention_item_states: per-user snooze / dismiss of inbox items. An item is identified by a
--    stable key built by lib/services/attention.ts (e.g. 'invoice:<uuid>' or
--    'reconcile:<bank account uuid>:2026-09-30'), so a dismissed "reconcile through September"
--    comes back on its own when October needs reconciling. One row per company + user + key.
-- 2. backup_log: when a backup of the company file was made (Back up now, File > Back Up, the
--    desktop app's automatic backups), so the inbox can say "Your last backup was 9 days ago".
CREATE TABLE IF NOT EXISTS "attention_item_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"item_key" varchar(200) NOT NULL,
	"snoozed_until" timestamp,
	"dismissed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attention_item_states_user_key_idx" ON "attention_item_states" ("company_id", "user_id", "item_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"user_id" uuid REFERENCES "users"("id"),
	"kind" varchar(20) NOT NULL,
	"filename" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_log_company_idx" ON "backup_log" ("company_id", "created_at");
