-- wave2 sales: A/R document parity (edit-after-save, shipping fields, to-be-printed/emailed
-- queues, statement charges, early-payment discounts, credits applied in Receive Payments,
-- bounced checks, collections notes).
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "ship_date" timestamp;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "ship_via" varchar(100);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "fob" varchar(100);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tracking_number" varchar(100);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "ship_to" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "po_number" varchar(100);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "to_be_printed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "to_be_emailed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "last_emailed_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "is_statement_charge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "ship_date" timestamp;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "ship_via" varchar(100);--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "fob" varchar(100);--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "tracking_number" varchar(100);--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "ship_to" jsonb;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "po_number" varchar(100);--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "to_be_printed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "to_be_emailed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "last_emailed_at" timestamp;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "ship_date" timestamp;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "ship_via" varchar(100);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "fob" varchar(100);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "tracking_number" varchar(100);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "ship_to" jsonb;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "po_number" varchar(100);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "to_be_printed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "to_be_emailed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "last_emailed_at" timestamp;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "to_be_printed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "to_be_emailed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "last_emailed_at" timestamp;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "to_be_printed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "to_be_emailed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "last_emailed_at" timestamp;--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD COLUMN IF NOT EXISTS "taxable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD COLUMN IF NOT EXISTS "restock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "payments_received" ADD COLUMN IF NOT EXISTS "discount_account_id" uuid;--> statement-breakpoint
ALTER TABLE "payments_received" ADD COLUMN IF NOT EXISTS "memo" text;--> statement-breakpoint
ALTER TABLE "payments_received" ADD COLUMN IF NOT EXISTS "bounced_at" timestamp;--> statement-breakpoint
ALTER TABLE "payment_applications" ADD COLUMN IF NOT EXISTS "discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"credit_memo_id" uuid NOT NULL REFERENCES "credit_memos"("id"),
	"invoice_id" uuid NOT NULL REFERENCES "invoices"("id"),
	"payment_id" uuid REFERENCES "payments_received"("id"),
	"amount" numeric(15, 2) NOT NULL,
	"date" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_applications_memo_idx" ON "credit_applications" ("credit_memo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_applications_invoice_idx" ON "credit_applications" ("invoice_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bounced_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"payment_id" uuid NOT NULL REFERENCES "payments_received"("id"),
	"customer_id" uuid NOT NULL REFERENCES "customers"("id"),
	"date" timestamp NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"bank_account_id" uuid NOT NULL REFERENCES "accounts"("id"),
	"reversal_entry_id" uuid REFERENCES "journal_entries"("id"),
	"bank_fee" numeric(15, 2) DEFAULT '0' NOT NULL,
	"bank_fee_account_id" uuid REFERENCES "accounts"("id"),
	"bank_fee_entry_id" uuid REFERENCES "journal_entries"("id"),
	"customer_fee" numeric(15, 2) DEFAULT '0' NOT NULL,
	"customer_fee_invoice_id" uuid REFERENCES "invoices"("id"),
	"applications" jsonb,
	"memo" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bounced_checks_payment_uq" ON "bounced_checks" ("payment_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collection_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"customer_id" uuid NOT NULL REFERENCES "customers"("id"),
	"invoice_id" uuid REFERENCES "invoices"("id"),
	"note" text NOT NULL,
	"follow_up_date" timestamp,
	"done" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_notes_customer_idx" ON "collection_notes" ("customer_id");
