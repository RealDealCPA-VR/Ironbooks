-- wave2 accountant: sales-tax liability engine + accountant tools (lib/services/accountant/*).
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "tax_rate_id" uuid REFERENCES "tax_rates"("id");
--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "tax_rate_id" uuid REFERENCES "tax_rates"("id");
--> statement-breakpoint
-- Integration (wave2 sales + accountant): 0027_wave2_sales already added both tax_rate_id columns
-- WITHOUT a foreign key, so the two ADD COLUMN IF NOT EXISTS above are no-ops on a migrated
-- database. Add the tax_rates FK here when the column has none yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'credit_memos'::regclass AND a.attname = 'tax_rate_id'
  ) THEN
    ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_tax_rate_id_tax_rates_id_fk"
      FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'sales_receipts'::regclass AND a.attname = 'tax_rate_id'
  ) THEN
    ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_tax_rate_id_tax_rates_id_fk"
      FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id");
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_tax_line_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"journal_entry_line_id" uuid NOT NULL REFERENCES "journal_entry_lines"("id") ON DELETE CASCADE,
	"agency_id" uuid REFERENCES "tax_agencies"("id"),
	"kind" varchar(20) NOT NULL,
	"note" text,
	"created_by" uuid REFERENCES "users"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tax_line_links_line_uq" ON "sales_tax_line_links" ("journal_entry_line_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tax_line_links_company_idx" ON "sales_tax_line_links" ("company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "working_tb_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"period_end" varchar(10) NOT NULL,
	"workpaper_ref" varchar(100),
	"note" text,
	"created_by" uuid REFERENCES "users"("id"),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "working_tb_notes_uq" ON "working_tb_notes" ("company_id", "account_id", "period_end");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "list_change_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"audit_log_id" uuid NOT NULL REFERENCES "audit_logs"("id") ON DELETE CASCADE,
	"reviewed_by" uuid REFERENCES "users"("id"),
	"reviewed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "list_change_reviews_uq" ON "list_change_reviews" ("audit_log_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_review_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"as_of" varchar(10) NOT NULL,
	"balances" jsonb NOT NULL,
	"note" text,
	"created_by" uuid REFERENCES "users"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_review_snapshots_company_idx" ON "client_review_snapshots" ("company_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_review_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"task_key" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'not_started' NOT NULL,
	"note" text,
	"created_by" uuid REFERENCES "users"("id"),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_review_tasks_uq" ON "client_review_tasks" ("company_id", "task_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_company_created_idx" ON "audit_logs" ("company_id", "created_at");
