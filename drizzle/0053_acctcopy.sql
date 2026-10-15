-- Accountant's Copy (QB "Accountant's Copy" / dividing date, PARITY I1).
--
-- accountant_copies: one row per Accountant's Copy of a company.
--   side 'client'     the client's file: while status = 'outstanding', transactions dated ON OR
--                     BEFORE dividing_date are locked and list entries can't be deleted or merged.
--                     'imported' / 'cancelled' end the restriction.
--   side 'accountant' the accountant's working copy (the same row, flipped when the .ibac transfer
--                     file is opened): only work ON OR BEFORE dividing_date is allowed.
--   file_token        random secret shared by the transfer file and the changes file (.ibcx), so a
--                     changes file is only accepted by the client file it was made from.
-- accountant_copy_baseline: on the accountant side, the version (updated_at / edited_at) of every
--   journal entry, check/expense, account and class at the moment the copy was opened. The changes
--   file is the delta against this baseline; the client import checks each edited record still has
--   that version (record locking).
CREATE TABLE IF NOT EXISTS "accountant_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"side" varchar(12) DEFAULT 'client' NOT NULL,
	"status" varchar(16) DEFAULT 'outstanding' NOT NULL,
	"dividing_date" varchar(10) NOT NULL,
	"file_token" varchar(64) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"opened_at" timestamp,
	"baseline_log_seq" integer,
	"exported_at" timestamp,
	"export_count" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp,
	"imported_by" uuid,
	"cancelled_at" timestamp,
	"cancelled_by" uuid,
	"accountant_note" text,
	"result" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accountant_copies_company_idx" ON "accountant_copies" ("company_id", "side", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accountant_copy_baseline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"copy_id" uuid NOT NULL REFERENCES "accountant_copies"("id") ON DELETE CASCADE,
	"entity_type" varchar(20) NOT NULL,
	"entity_id" uuid NOT NULL,
	"version" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accountant_copy_baseline_entity_idx" ON "accountant_copy_baseline" ("copy_id", "entity_type", "entity_id");
