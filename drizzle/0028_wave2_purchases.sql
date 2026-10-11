-- wave2 purchases: edit-after-save support, Items tab on checks, unified print queue,
-- check printer setup, vendor pre-fill/print-as/account no., multi-currency purchase documents,
-- and the Loan Manager.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "currency" varchar(3);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "prefill_account_ids" jsonb;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "print_on_check_as" varchar(255);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "account_number" varchar(100);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "currency" varchar(3);--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "currency" varchar(3);--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "bill_payments" ADD COLUMN IF NOT EXISTS "to_print" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD COLUMN IF NOT EXISTS "currency" varchar(3);--> statement-breakpoint
ALTER TABLE "bill_payments" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "bill_payment_applications" ADD COLUMN IF NOT EXISTS "amount_home" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "currency" varchar(3);--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "expense_lines" ADD COLUMN IF NOT EXISTS "item_id" uuid REFERENCES "items"("id");--> statement-breakpoint
ALTER TABLE "expense_lines" ADD COLUMN IF NOT EXISTS "quantity" numeric(15, 4);--> statement-breakpoint
ALTER TABLE "expense_lines" ADD COLUMN IF NOT EXISTS "unit_cost" numeric(15, 4);--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "voided_at" timestamp;--> statement-breakpoint
ALTER TABLE "paychecks" ADD COLUMN IF NOT EXISTS "to_print" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "paychecks" ADD COLUMN IF NOT EXISTS "check_number" varchar(100);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "check_print_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL UNIQUE REFERENCES "companies"("id"),
	"style" varchar(20) DEFAULT 'voucher' NOT NULL,
	"offset_x" numeric(6, 3) DEFAULT '0' NOT NULL,
	"offset_y" numeric(6, 3) DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"lender_vendor_id" uuid REFERENCES "vendors"("id"),
	"liability_account_id" uuid NOT NULL REFERENCES "accounts"("id"),
	"interest_account_id" uuid NOT NULL REFERENCES "accounts"("id"),
	"escrow_account_id" uuid REFERENCES "accounts"("id"),
	"payment_account_id" uuid REFERENCES "accounts"("id"),
	"original_amount" numeric(15, 2) NOT NULL,
	"annual_rate" numeric(9, 6) NOT NULL,
	"term_months" integer NOT NULL,
	"payments_per_year" integer DEFAULT 12 NOT NULL,
	"origin_date" timestamp NOT NULL,
	"first_payment_date" timestamp NOT NULL,
	"escrow_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loan_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"loan_id" uuid NOT NULL REFERENCES "loans"("id"),
	"payment_number" integer NOT NULL,
	"date" timestamp NOT NULL,
	"principal" numeric(15, 2) NOT NULL,
	"interest" numeric(15, 2) NOT NULL,
	"escrow" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total" numeric(15, 2) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"expense_id" uuid REFERENCES "expenses"("id"),
	"bill_id" uuid REFERENCES "bills"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loan_payments_loan_idx" ON "loan_payments" ("loan_id");
