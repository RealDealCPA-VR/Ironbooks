-- P1 round, team FX: multi-currency completeness.
--
-- 1. journal_entry_lines.currency / foreign_amount / exchange_rate: a line on a foreign-currency
--    bank or credit-card account carries its amount in the ACCOUNT's currency (same side as its
--    debit/credit), so registers, bank feeds and reconciliation work in the account's currency
--    while the debit/credit columns (home currency) stay the ledger of record. foreign_amount 0
--    marks a home-currency-only revaluation line (Home Currency Adjustment). Lines that existed
--    before this migration on foreign-currency accounts are back-filled from their check / bill
--    payment rate when known, else from the currency list's current rate.
-- 2. Vendor credits, deposits, transfers and Loan Manager loans/payments get currency + exchange
--    rate (+ home amounts) columns.
-- 3. vendor_credit_applications: home A/P relieved when a foreign vendor credit is applied to a
--    foreign bill (realized exchange gain/loss posted with it).
-- 4. home_currency_adjustments: QB Home Currency Adjustment runs.
-- 5. bka_jel_fx_guard: once a posted line has a foreign amount it cannot be changed (outside a
--    sanctioned ledger rewrite), like the line's debit/credit.
ALTER TABLE "journal_entry_lines" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD COLUMN IF NOT EXISTS "foreign_amount" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18, 8);
--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18, 8);
--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD COLUMN IF NOT EXISTS "home_total" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD COLUMN IF NOT EXISTS "home_unapplied" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18, 8);
--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN IF NOT EXISTS "home_total" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18, 8);
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "to_currency" varchar(3);
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "to_amount" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "home_amount" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18, 8);
--> statement-breakpoint
ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18, 8);
--> statement-breakpoint
ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "fx_entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"vendor_credit_id" uuid NOT NULL REFERENCES "vendor_credits"("id"),
	"bill_id" uuid NOT NULL REFERENCES "bills"("id"),
	"date" timestamp NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"home_bill" numeric(15, 2) NOT NULL,
	"home_credit" numeric(15, 2) NOT NULL,
	"fx_entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_credit_applications_bill_idx" ON "vendor_credit_applications" ("bill_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_credit_applications_credit_idx" ON "vendor_credit_applications" ("vendor_credit_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "home_currency_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"date" timestamp NOT NULL,
	"memo" text,
	"rates" jsonb NOT NULL,
	"detail" jsonb NOT NULL,
	"total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
	"reversal_entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
	"voided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "home_currency_adjustments_company_idx" ON "home_currency_adjustments" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jel_foreign_account_idx" ON "journal_entry_lines" ("account_id") WHERE "foreign_amount" IS NOT NULL;
--> statement-breakpoint
-- Back-fill: lines on foreign-currency accounts posted before this migration. Only metadata
-- columns change (debit/credit/account untouched), which the immutability guard allows.
UPDATE "journal_entry_lines" l
SET "currency" = a."currency",
    "exchange_rate" = COALESCE(e2."exchange_rate", bp."exchange_rate", c."rate_to_base"),
    "foreign_amount" = round(COALESCE(l."debit", l."credit") / NULLIF(COALESCE(e2."exchange_rate", bp."exchange_rate", c."rate_to_base"), 0), 2)
FROM "accounts" a
JOIN "journal_entries" je ON TRUE
LEFT JOIN "currencies" c ON c."company_id" = a."company_id" AND c."code" = a."currency"
LEFT JOIN "expenses" e2 ON e2."posted_entry_id" = je."id" AND e2."currency" = a."currency"
LEFT JOIN "bill_payments" bp ON bp."posted_entry_id" = je."id" AND bp."currency" = a."currency"
WHERE a."id" = l."account_id"
  AND je."id" = l."journal_entry_id"
  AND a."currency" IS NOT NULL
  AND l."foreign_amount" IS NULL
  AND COALESCE(e2."exchange_rate", bp."exchange_rate", c."rate_to_base") IS NOT NULL
  AND COALESCE(c."is_base", false) = false;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bka_jel_fx_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  IF bka_ledger_rewrite_allowed() THEN
    RETURN NEW;
  END IF;
  IF OLD."foreign_amount" IS NOT NULL
     AND (NEW."foreign_amount", NEW."currency", NEW."exchange_rate")
         IS DISTINCT FROM (OLD."foreign_amount", OLD."currency", OLD."exchange_rate") THEN
    SELECT status::text AS status, created_at, entry_number INTO r
    FROM journal_entries WHERE id = OLD.journal_entry_id;
    IF FOUND AND r.status IN ('posted', 'void') AND NOT bka_entry_is_new(r.created_at) THEN
      RAISE EXCEPTION 'LEDGER: the foreign-currency amount of % journal entry #% cannot be changed — void it or post a correcting entry instead',
        r.status, r.entry_number
        USING ERRCODE = 'BK002';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_jel_fx_guard ON journal_entry_lines;
--> statement-breakpoint
CREATE TRIGGER bka_jel_fx_guard
  BEFORE UPDATE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION bka_jel_fx_guard();
--> statement-breakpoint
ALTER TABLE journal_entry_lines ENABLE ALWAYS TRIGGER bka_jel_fx_guard;
--> statement-breakpoint
-- 6. payment_fx_reliefs: home A/R relieved on each foreign invoice by each received payment, so
--    the payment that finishes an invoice clears exactly the home amount still on A/R.
CREATE TABLE IF NOT EXISTS "payment_fx_reliefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"payment_id" uuid NOT NULL REFERENCES "payments_received"("id"),
	"invoice_id" uuid NOT NULL REFERENCES "invoices"("id"),
	"date" timestamp NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"home_amount" numeric(15, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_fx_reliefs_invoice_idx" ON "payment_fx_reliefs" ("invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_fx_reliefs_payment_idx" ON "payment_fx_reliefs" ("payment_id");
