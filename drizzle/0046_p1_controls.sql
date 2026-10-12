-- P1 controls round.
--
-- 1. Record locking (QB "This record was changed by another user"): optimistic-concurrency
--    versions for every editable transaction type that had none. Each table gets an updated_at
--    column (existing rows start at the upgrade time) and a bka_version_* trigger that moves it
--    forward on every UPDATE that doesn't set it explicitly, so ANY change — an edit, a void, a
--    payment applied, a print — makes an open copy of the record stale
--    (lib/services/concurrency.ts withVersionCheck). Versions are UTC, millisecond precision,
--    and always strictly increase.
CREATE OR REPLACE FUNCTION bka_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := GREATEST(
      date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
      OLD.updated_at + interval '1 millisecond'
    );
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments_received" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "bill_payments" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "item_receipts" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "paychecks" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_sales_orders ON "sales_orders";
--> statement-breakpoint
CREATE TRIGGER bka_version_sales_orders BEFORE UPDATE ON "sales_orders" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_sales_receipts ON "sales_receipts";
--> statement-breakpoint
CREATE TRIGGER bka_version_sales_receipts BEFORE UPDATE ON "sales_receipts" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_credit_memos ON "credit_memos";
--> statement-breakpoint
CREATE TRIGGER bka_version_credit_memos BEFORE UPDATE ON "credit_memos" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_purchase_orders ON "purchase_orders";
--> statement-breakpoint
CREATE TRIGGER bka_version_purchase_orders BEFORE UPDATE ON "purchase_orders" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_expenses ON "expenses";
--> statement-breakpoint
CREATE TRIGGER bka_version_expenses BEFORE UPDATE ON "expenses" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_deposits ON "deposits";
--> statement-breakpoint
CREATE TRIGGER bka_version_deposits BEFORE UPDATE ON "deposits" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_transfers ON "transfers";
--> statement-breakpoint
CREATE TRIGGER bka_version_transfers BEFORE UPDATE ON "transfers" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_payments_received ON "payments_received";
--> statement-breakpoint
CREATE TRIGGER bka_version_payments_received BEFORE UPDATE ON "payments_received" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_bill_payments ON "bill_payments";
--> statement-breakpoint
CREATE TRIGGER bka_version_bill_payments BEFORE UPDATE ON "bill_payments" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_vendor_credits ON "vendor_credits";
--> statement-breakpoint
CREATE TRIGGER bka_version_vendor_credits BEFORE UPDATE ON "vendor_credits" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_item_receipts ON "item_receipts";
--> statement-breakpoint
CREATE TRIGGER bka_version_item_receipts BEFORE UPDATE ON "item_receipts" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_paychecks ON "paychecks";
--> statement-breakpoint
CREATE TRIGGER bka_version_paychecks BEFORE UPDATE ON "paychecks" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_estimates ON "estimates";
--> statement-breakpoint
CREATE TRIGGER bka_version_estimates BEFORE UPDATE ON "estimates" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_employees ON "employees";
--> statement-breakpoint
CREATE TRIGGER bka_version_employees BEFORE UPDATE ON "employees" FOR EACH ROW EXECUTE FUNCTION bka_touch_updated_at();
--> statement-breakpoint
-- Accounts: updated_at also moves whenever a posting changes the cached balance, so it can't be
-- the edit version (anyone posting would make an open account form stale). edited_at moves only
-- when something other than the balance changes.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "edited_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bka_touch_account_edited_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at
     AND (to_jsonb(NEW) - 'balance' - 'updated_at' - 'edited_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'balance' - 'updated_at' - 'edited_at') THEN
    NEW.edited_at := GREATEST(
      date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
      OLD.edited_at + interval '1 millisecond'
    );
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_accounts ON "accounts";
--> statement-breakpoint
CREATE TRIGGER bka_version_accounts BEFORE UPDATE ON "accounts" FOR EACH ROW EXECUTE FUNCTION bka_touch_account_edited_at();
