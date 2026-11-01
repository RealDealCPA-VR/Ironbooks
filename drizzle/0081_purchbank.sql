-- Feature round (team purchbank): purchases and banking gaps to QuickBooks Desktop parity.
--
-- Every statement is additive (IF NOT EXISTS / nullable or defaulted columns), so a company file
-- from any earlier version upgrades in place and nothing it already holds changes meaning.
--
-- Purchase orders: QB puts a Customer:Job and a Class on each P.O. line (carried onto the bill
-- when the P.O. is received or billed) and a Ship To address (the company, a customer or any
-- address typed on the P.O.).
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "ship_to" jsonb;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "ship_to_customer_id" uuid REFERENCES "customers"("id");
--> statement-breakpoint
-- A P.O. closed by hand (Mark as Closed) keeps that status when a later receipt edit releases
-- quantity; only a P.O. that closed because everything was received / billed reopens.
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "closed_manually" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Closed P.O.s with quantity still open on a line can only have been closed by hand.
UPDATE "purchase_orders" po
SET "closed_manually" = true
WHERE po."status" = 'closed'
  AND po."closed_manually" = false
  AND EXISTS (
    SELECT 1 FROM "purchase_order_lines" l
    WHERE l."purchase_order_id" = po."id" AND l."quantity_billed" < l."quantity"
  );
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "customer_id" uuid REFERENCES "customers"("id");
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "job_id" uuid REFERENCES "jobs"("id");
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "class_id" uuid REFERENCES "classes"("id");
--> statement-breakpoint
-- Bills remember the Terms list entry they were entered with, so the due date and the Pay Bills
-- discount keep following it when the entry is renamed (bills.terms keeps the label).
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "terms_id" uuid REFERENCES "payment_terms"("id");
--> statement-breakpoint
UPDATE "bills" b
SET "terms_id" = pt."id"
FROM "payment_terms" pt
WHERE b."terms_id" IS NULL
  AND b."terms" IS NOT NULL
  AND pt."company_id" = b."company_id"
  AND pt."code" IS NOT NULL
  AND lower(pt."code") = lower(b."terms");
--> statement-breakpoint
UPDATE "bills" b
SET "terms_id" = pt."id"
FROM "payment_terms" pt
WHERE b."terms_id" IS NULL
  AND b."terms" IS NOT NULL
  AND pt."company_id" = b."company_id"
  AND lower(pt."name") = lower(b."terms");
--> statement-breakpoint
-- Loan Manager: a balloon payment, how interest compounds (per payment period, or on the exact
-- days between payments over a 365- or 360-day year), a payment amount the lender set, and the
-- payment the Loan Manager starts from for a loan that was already being paid when it was added.
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "balloon_amount" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "compounding" varchar(16) DEFAULT 'monthly' NOT NULL;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "day_count" integer DEFAULT 365 NOT NULL;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "payment_amount" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "schedule_start_number" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "schedule_start_date" timestamp;
--> statement-breakpoint
-- Make Deposits: the Received From name of an extra deposit line (a register deposit keeps the
-- name that was picked). Posted onto the deposit's journal line as its Name.
ALTER TABLE "deposit_lines" ADD COLUMN IF NOT EXISTS "entity_type" varchar(20);
--> statement-breakpoint
ALTER TABLE "deposit_lines" ADD COLUMN IF NOT EXISTS "entity_id" uuid;
--> statement-breakpoint
-- Changes made to transactions after they were reconciled (QB lets you change a reconciled
-- transaction after a warning; the Previous Reconciliation Discrepancy report lists the change).
-- The line / entry ids are plain references, not foreign keys: Condense may remove the old lines
-- while the change stays on the report, so every value the report shows is kept on the row.
CREATE TABLE IF NOT EXISTS "reconciliation_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "reconciliation_id" uuid NOT NULL REFERENCES "reconciliations"("id"),
  "bank_account_id" uuid NOT NULL REFERENCES "bank_accounts"("id"),
  "old_entry_id" uuid,
  "old_line_id" uuid,
  "new_entry_id" uuid,
  "new_line_id" uuid,
  "transaction_date" timestamp NOT NULL,
  "entry_number" integer,
  "description" text,
  "source_ref" varchar(100),
  "reconciled_amount" numeric(15, 2) NOT NULL,
  "new_amount" numeric(15, 2),
  "effect" numeric(15, 2),
  "change_type" varchar(20) DEFAULT 'pending' NOT NULL,
  "tx_id" varchar(40),
  "created_by" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_changes_account_idx" ON "reconciliation_changes" ("company_id", "bank_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_changes_old_entry_idx" ON "reconciliation_changes" ("old_entry_id");
