-- P1 purchases round.
--
-- 1. payment_checks: printable check documents for payments that are not Write Checks / Pay Bills
--    / paychecks — QB's Sales Tax Payment (kind 'sales_tax', one check per tax agency), Pay
--    Payroll Liabilities (kind 'payroll_liability') and customer refund checks (kind
--    'customer_refund', D3: the refund journal entry already exists; this row lets it wait in the
--    Print Checks queue and take a check number). The journal entry stays the ledger record
--    (sales tax payments keep sourceRef 'tax_agency:<agencyId>'); posted_entry_id links it.
-- 2. tax_agencies.vendor_id: the vendor a Sales Tax Payment check is written to (QB tax agencies
--    are vendors).
-- 3. vendor_credits.ref_number + vendor credit Items tab / Class / Customer:Job on lines.
-- 4. check_print_settings.stock: 'preprinted' (default, only the variable fields are printed) or
--    'blank' (full check layout on plain paper).
CREATE TABLE IF NOT EXISTS "payment_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"kind" varchar(30) NOT NULL,
	"agency_id" uuid REFERENCES "tax_agencies"("id"),
	"vendor_id" uuid REFERENCES "vendors"("id"),
	"customer_id" uuid REFERENCES "customers"("id"),
	"payee_name" varchar(255) NOT NULL,
	"payment_account_id" uuid NOT NULL REFERENCES "accounts"("id"),
	"date" timestamp NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"reference" varchar(100),
	"to_print" boolean DEFAULT false NOT NULL,
	"memo" text,
	"posted_entry_id" uuid REFERENCES "journal_entries"("id"),
	"voided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_checks_company_idx" ON "payment_checks" ("company_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_checks_entry_idx" ON "payment_checks" ("posted_entry_id");
--> statement-breakpoint
ALTER TABLE "tax_agencies" ADD COLUMN IF NOT EXISTS "vendor_id" uuid REFERENCES "vendors"("id");--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD COLUMN IF NOT EXISTS "ref_number" varchar(50);--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN IF NOT EXISTS "item_id" uuid REFERENCES "items"("id");--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN IF NOT EXISTS "quantity" numeric(15, 4);--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN IF NOT EXISTS "unit_cost" numeric(15, 4);--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN IF NOT EXISTS "cost_amount" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN IF NOT EXISTS "class_id" uuid REFERENCES "classes"("id");--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN IF NOT EXISTS "customer_id" uuid REFERENCES "customers"("id");--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN IF NOT EXISTS "job_id" uuid REFERENCES "jobs"("id");--> statement-breakpoint
ALTER TABLE "check_print_settings" ADD COLUMN IF NOT EXISTS "stock" varchar(20) DEFAULT 'preprinted' NOT NULL;
