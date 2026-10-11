-- ===========================================================================
-- 0025 — wave2 foundation: QB account types, JE names, adjusting entries,
--        alphanumeric document numbers, income-tax lines.
--
-- (1) account_subtype gains the missing QuickBooks account types (Other Current
--     Asset, Undeposited Funds, Other Asset, Other Current Liability, Other
--     Expense, Non-Posting). The type is RE-CREATED (column -> text -> new enum)
--     rather than ALTER TYPE ... ADD VALUE, because the migrator runs inside one
--     transaction and Postgres refuses to use a value added by ADD VALUE before
--     that transaction commits — and the data fix-up below needs the new values.
-- (2) Existing data is reclassified conservatively (only unambiguous names):
--     Undeposited Funds -> undeposited_funds (an Other Current Asset in QB);
--     prepaids / advances held as "checking" -> other_current_asset;
--     non-"Accounts Payable" liabilities that defaulted to accounts_payable and
--     sales-tax / payroll liabilities seeded as long_term_liability ->
--     other_current_liability. Subtype changes never touch type or balance, so
--     the 0017 ledger guards are unaffected.
-- (3) Non-posting accounts can never carry posted lines (DB-enforced, BK001), so
--     they can never reach the trial balance, balance sheet or P&L.
-- ===========================================================================

-- One-time: rebuild the enum and reclassify ONLY if the new values are not there yet, so a
-- re-run never re-applies the name heuristics to accounts the user has since re-typed, and
-- never trips the bka_accounts_non_posting trigger (it is dropped first and recreated below).
DROP TRIGGER IF EXISTS bka_accounts_non_posting ON accounts;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'account_subtype' AND e.enumlabel = 'non_posting'
  ) THEN
    ALTER TABLE "accounts" ALTER COLUMN "subtype" TYPE text;
    DROP TYPE IF EXISTS "public"."account_subtype";
    CREATE TYPE "public"."account_subtype" AS ENUM('checking', 'savings', 'accounts_receivable', 'inventory', 'fixed_assets', 'accounts_payable', 'credit_card', 'long_term_liability', 'owners_equity', 'retained_earnings', 'sales', 'service_revenue', 'other_income', 'cost_of_goods_sold', 'operating_expenses', 'payroll', 'taxes', 'other_current_asset', 'undeposited_funds', 'other_asset', 'other_current_liability', 'other_expense', 'non_posting');

    UPDATE "accounts" SET "subtype" = 'undeposited_funds'
    WHERE "type" = 'asset' AND "subtype" IN ('checking', 'savings') AND "name" ~* 'undeposited';

    UPDATE "accounts" SET "subtype" = 'other_current_asset'
    WHERE "type" = 'asset' AND "subtype" IN ('checking', 'savings')
      AND "name" ~* '(prepaid|prepayment|\madvances?\M|employee loan|loans? to )';

    UPDATE "accounts" SET "subtype" = 'other_asset'
    WHERE "type" = 'asset' AND "subtype" IN ('checking', 'savings', 'fixed_assets')
      AND "name" ~* '(security deposit|goodwill|organi[sz]ation costs?)';

    UPDATE "accounts" SET "subtype" = 'other_current_liability'
    WHERE "type" = 'liability' AND "subtype" = 'accounts_payable'
      AND "code" <> '2000'
      AND "name" !~* '(accounts\s*payable|^a/?p\M|trade payables?)';

    UPDATE "accounts" SET "subtype" = 'other_current_liability'
    WHERE "type" = 'liability' AND "subtype" = 'long_term_liability'
      AND "name" ~* '(sales tax|payroll|withholding|accrued|wages payable|\mvat\M|\mgst\M|\mhst\M|customer deposits?)'
      AND "name" !~* '(loan|note|mortgage|long[- ]?term|lease)';

    ALTER TABLE "accounts" ALTER COLUMN "subtype" TYPE "public"."account_subtype" USING "subtype"::"public"."account_subtype";
  END IF;
END
$$;
--> statement-breakpoint

-- ---- tax lines ------------------------------------------------------------------
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "tax_line" varchar(40);
--> statement-breakpoint

-- ---- adjusting entries + names on journal lines ----------------------------------
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "is_adjusting" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD COLUMN IF NOT EXISTS "entity_type" varchar(20);
--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD COLUMN IF NOT EXISTS "entity_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jel_entity_idx" ON "journal_entry_lines" ("entity_type", "entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "je_company_adjusting_idx" ON "journal_entries" ("company_id") WHERE "is_adjusting";
--> statement-breakpoint

-- ---- non-posting accounts never carry posted lines -------------------------------
CREATE OR REPLACE FUNCTION bka_assert_no_non_posting(p_entry uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_number integer;
  v_name text;
BEGIN
  SELECT e.entry_number, a.name INTO v_number, v_name
  FROM journal_entries e
  JOIN journal_entry_lines l ON l.journal_entry_id = e.id
  JOIN accounts a ON a.id = l.account_id
  WHERE e.id = p_entry AND e.status = 'posted' AND a.subtype = 'non_posting'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'LEDGER: journal entry #% posts to non-posting account "%"; non-posting accounts (estimates, purchase orders) never carry amounts', v_number, v_name
      USING ERRCODE = 'BK001';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bka_jel_non_posting_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM bka_assert_no_non_posting(NEW.journal_entry_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bka_je_non_posting_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bka_assert_no_non_posting(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_jel_non_posting ON journal_entry_lines;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER bka_jel_non_posting
  AFTER INSERT OR UPDATE ON journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bka_jel_non_posting_check();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_je_non_posting ON journal_entries;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER bka_je_non_posting
  AFTER UPDATE OF status ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bka_je_non_posting_check();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bka_accounts_non_posting_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subtype = 'non_posting' AND (TG_OP = 'INSERT' OR OLD.subtype IS DISTINCT FROM 'non_posting') THEN
    IF TG_OP = 'UPDATE' AND EXISTS (
      SELECT 1 FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
      WHERE l.account_id = NEW.id AND e.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'LEDGER: account % has posted transactions and cannot become a non-posting account', NEW.code
        USING ERRCODE = 'BK003';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_accounts_non_posting ON accounts;
--> statement-breakpoint
CREATE TRIGGER bka_accounts_non_posting
  BEFORE INSERT OR UPDATE OF subtype ON accounts
  FOR EACH ROW EXECUTE FUNCTION bka_accounts_non_posting_guard();
--> statement-breakpoint
ALTER TABLE journal_entry_lines ENABLE ALWAYS TRIGGER bka_jel_non_posting;
--> statement-breakpoint
ALTER TABLE journal_entries ENABLE ALWAYS TRIGGER bka_je_non_posting;
--> statement-breakpoint
ALTER TABLE accounts ENABLE ALWAYS TRIGGER bka_accounts_non_posting;
--> statement-breakpoint

-- ---- alphanumeric document numbers ------------------------------------------------
-- ref_number is the user-facing number ("INV-1001"); the legacy integer columns stay for
-- sorting/back-compat. A BEFORE INSERT/UPDATE trigger fills ref_number from the integer
-- whenever a writer does not supply one, so services that predate docNumbers.ts keep working.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "ref_number" varchar(50);
--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "ref_number" varchar(50);
--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "ref_number" varchar(50);
--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "ref_number" varchar(50);
--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "ref_number" varchar(50);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "ref_number" varchar(50);
--> statement-breakpoint
UPDATE "invoices" SET "ref_number" = "invoice_number"::text WHERE "ref_number" IS NULL;
--> statement-breakpoint
UPDATE "estimates" SET "ref_number" = "estimate_number"::text WHERE "ref_number" IS NULL;
--> statement-breakpoint
UPDATE "sales_receipts" SET "ref_number" = "receipt_number"::text WHERE "ref_number" IS NULL;
--> statement-breakpoint
UPDATE "credit_memos" SET "ref_number" = "memo_number"::text WHERE "ref_number" IS NULL;
--> statement-breakpoint
UPDATE "sales_orders" SET "ref_number" = "order_number"::text WHERE "ref_number" IS NULL;
--> statement-breakpoint
UPDATE "purchase_orders" SET "ref_number" = "po_number"::text WHERE "ref_number" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_ref_number_idx" ON "invoices" ("company_id", lower("ref_number"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimates_ref_number_idx" ON "estimates" ("company_id", lower("ref_number"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_receipts_ref_number_idx" ON "sales_receipts" ("company_id", lower("ref_number"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_memos_ref_number_idx" ON "credit_memos" ("company_id", lower("ref_number"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_orders_ref_number_idx" ON "sales_orders" ("company_id", lower("ref_number"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_ref_number_idx" ON "purchase_orders" ("company_id", lower("ref_number"));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION docnum_fill_ref_number() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_num text;
BEGIN
  IF NEW.ref_number IS NULL OR btrim(NEW.ref_number) = '' THEN
    v_num := to_jsonb(NEW) ->> TG_ARGV[0];
    NEW.ref_number := v_num;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS docnum_invoices_ref_number ON invoices;
--> statement-breakpoint
CREATE TRIGGER docnum_invoices_ref_number BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION docnum_fill_ref_number('invoice_number');
--> statement-breakpoint
DROP TRIGGER IF EXISTS docnum_estimates_ref_number ON estimates;
--> statement-breakpoint
CREATE TRIGGER docnum_estimates_ref_number BEFORE INSERT OR UPDATE ON estimates
  FOR EACH ROW EXECUTE FUNCTION docnum_fill_ref_number('estimate_number');
--> statement-breakpoint
DROP TRIGGER IF EXISTS docnum_sales_receipts_ref_number ON sales_receipts;
--> statement-breakpoint
CREATE TRIGGER docnum_sales_receipts_ref_number BEFORE INSERT OR UPDATE ON sales_receipts
  FOR EACH ROW EXECUTE FUNCTION docnum_fill_ref_number('receipt_number');
--> statement-breakpoint
DROP TRIGGER IF EXISTS docnum_credit_memos_ref_number ON credit_memos;
--> statement-breakpoint
CREATE TRIGGER docnum_credit_memos_ref_number BEFORE INSERT OR UPDATE ON credit_memos
  FOR EACH ROW EXECUTE FUNCTION docnum_fill_ref_number('memo_number');
--> statement-breakpoint
DROP TRIGGER IF EXISTS docnum_sales_orders_ref_number ON sales_orders;
--> statement-breakpoint
CREATE TRIGGER docnum_sales_orders_ref_number BEFORE INSERT OR UPDATE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION docnum_fill_ref_number('order_number');
--> statement-breakpoint
DROP TRIGGER IF EXISTS docnum_purchase_orders_ref_number ON purchase_orders;
--> statement-breakpoint
CREATE TRIGGER docnum_purchase_orders_ref_number BEFORE INSERT OR UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION docnum_fill_ref_number('po_number');
