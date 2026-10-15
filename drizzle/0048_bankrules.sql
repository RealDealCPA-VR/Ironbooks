-- Bank feed rules that learn by themselves (team bankrules).
--
-- transaction_rules gains the full QB-style rule shape:
--   bank_account_id   only fire for this bank account (NULL = any account)
--   direction         'any' | 'in' (money in) | 'out' (money out)
--   amount_min/max    absolute-amount range (both equal = "amount equals"; NULL = no bound)
--   set_class_id      class to put on the categorized line
--   set_memo          memo to put on the categorized entry
--   splits            optional [{accountId, classId, percent}] split by percentage (sums to 100)
--   mode              'suggest' (pre-fill for review) | 'auto' (post automatically)
--   enabled           on/off switch (is_active stays the soft-delete flag)
--   learned           created from a "learned" offer (user categorized the same pattern twice)
--   applied_count / last_applied_at  usage statistics shown on the Rules page
--   updated_at        record version for optimistic locking of rule edits
-- bank_categorization_history: every bank-feed line categorized through categorize(), with the
--   normalized description pattern — powers "you chose Fuel 5 times" and the learning offers.
-- bank_rule_dismissals: patterns the user said "don't ask again" for.
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "bank_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "direction" varchar(10) DEFAULT 'any' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "amount_min" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "amount_max" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "set_class_id" uuid;
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "set_memo" varchar(255);
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "splits" jsonb;
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "mode" varchar(10) DEFAULT 'suggest' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "learned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "applied_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "last_applied_at" timestamp;
--> statement-breakpoint
ALTER TABLE "transaction_rules" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transaction_rules_company_idx" ON "transaction_rules" ("company_id", "priority");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_categorization_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"bank_transaction_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"pattern" varchar(255) NOT NULL,
	"direction" varchar(10) NOT NULL,
	"account_id" uuid NOT NULL,
	"class_id" uuid,
	"payee" varchar(255),
	"split" boolean DEFAULT false NOT NULL,
	"source" varchar(20) DEFAULT 'user' NOT NULL,
	"rule_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_cat_history_pattern_idx" ON "bank_categorization_history" ("company_id", "pattern");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_cat_history_entry_idx" ON "bank_categorization_history" ("journal_entry_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_rule_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"pattern" varchar(255) NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bank_rule_dismissals_uq" ON "bank_rule_dismissals" ("company_id", "pattern", "account_id");
