CREATE TABLE IF NOT EXISTS "ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task_policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cloud_enabled" boolean DEFAULT false NOT NULL,
	"auto_apply_enabled" boolean DEFAULT false NOT NULL,
	"auto_apply_threshold" numeric(5, 4) DEFAULT '0.9500' NOT NULL,
	"llm_suggest_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_company_id_unique" UNIQUE("company_id"),
	CONSTRAINT "ai_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_categorizer_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"model" jsonb NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"watermark" timestamp,
	"trained_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_categorizer_models_company_id_unique" UNIQUE("company_id"),
	CONSTRAINT "ai_categorizer_models_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_auto_applied" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_transaction_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_auto_applied_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "ai_auto_applied_bank_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "ai_auto_applied_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "ai_auto_applied_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_auto_applied_company_entry_idx" ON "ai_auto_applied" ("company_id", "journal_entry_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid,
	"kind" varchar(50) NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"result_ref" varchar(255),
	"error" text,
	"decided_by" uuid,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "ai_proposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "ai_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_proposals_company_status_idx" ON "ai_proposals" ("company_id", "status");
