-- Team ledger fix round (P0 I11 + reclassify durability).
--
-- 1. journal_item_applications: named General Journal A/R / A/P lines (journal.ts
--    journalOpenItems) are open items that can be paid or used as credits, as in QuickBooks:
--      kind 'payment'        a received payment pays a JE A/R debit (charge)
--      kind 'invoice_credit' a JE A/R credit is applied to an invoice
--      kind 'bill_payment'   a bill payment pays a JE A/P credit (amount owed to the vendor)
--      kind 'bill_credit'    a JE A/P debit (vendor credit) is applied to a bill
--    No GL is posted by an application (both sides already sit in A/R or A/P); the payment /
--    bill payment that pays a JE item posts its own entry as usual.
-- 2. A journal entry with applications cannot be voided (or edited, which voids it) until they are
--    removed — BK002 (CONFLICT) like the other ledger guards.
-- 3. deposit_lines.account_id: the account an "extra" deposit line credits, so the deposit's own
--    rows carry it (Reclassify keeps them in step; the edit form no longer has to re-pick it).
CREATE TABLE IF NOT EXISTS "journal_item_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"side" varchar(2) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"journal_entry_id" uuid NOT NULL REFERENCES "journal_entries"("id") ON DELETE CASCADE,
	"journal_line_id" uuid NOT NULL REFERENCES "journal_entry_lines"("id") ON DELETE CASCADE,
	"payment_id" uuid REFERENCES "payments_received"("id"),
	"bill_payment_id" uuid REFERENCES "bill_payments"("id"),
	"invoice_id" uuid REFERENCES "invoices"("id"),
	"bill_id" uuid REFERENCES "bills"("id"),
	"amount" numeric(15, 2) NOT NULL,
	"date" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "journal_item_applications_amount_positive" CHECK ("amount" > 0),
	CONSTRAINT "journal_item_applications_side" CHECK ("side" IN ('ar', 'ap')),
	CONSTRAINT "journal_item_applications_kind" CHECK (
		("kind" = 'payment' AND "side" = 'ar' AND "payment_id" IS NOT NULL)
		OR ("kind" = 'invoice_credit' AND "side" = 'ar' AND "invoice_id" IS NOT NULL)
		OR ("kind" = 'bill_payment' AND "side" = 'ap' AND "bill_payment_id" IS NOT NULL)
		OR ("kind" = 'bill_credit' AND "side" = 'ap' AND "bill_id" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_item_applications_line_idx" ON "journal_item_applications" ("journal_line_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_item_applications_entry_idx" ON "journal_item_applications" ("journal_entry_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_item_applications_payment_idx" ON "journal_item_applications" ("payment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_item_applications_bill_payment_idx" ON "journal_item_applications" ("bill_payment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_item_applications_company_idx" ON "journal_item_applications" ("company_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bk_guard_journal_item_applications() RETURNS trigger AS $$
DECLARE
  v_n integer;
BEGIN
  IF NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void' THEN
    SELECT COUNT(*) INTO v_n FROM journal_item_applications a WHERE a.journal_entry_id = NEW.id;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'Journal entry #% has amounts applied to payments, invoices or bills. Remove those applications in Receive Payments or Pay Bills first, then void or edit the entry.', NEW.entry_number
        USING ERRCODE = 'BK002';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bk_journal_item_applications_void_guard" ON "journal_entries";
--> statement-breakpoint
CREATE TRIGGER "bk_journal_item_applications_void_guard"
	BEFORE UPDATE OF "status" ON "journal_entries"
	FOR EACH ROW EXECUTE FUNCTION bk_guard_journal_item_applications();
--> statement-breakpoint
ALTER TABLE "deposit_lines" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "accounts"("id");
--> statement-breakpoint
-- Backfill: an extra deposit line credited the account of the matching credit line (same memo and
-- amount) on the deposit's posted entry.
UPDATE "deposit_lines" dl
SET "account_id" = (
	SELECT jel."account_id"
	FROM "deposits" d
	JOIN "journal_entry_lines" jel ON jel."journal_entry_id" = d."posted_entry_id"
	WHERE d."id" = dl."deposit_id"
		AND jel."credit" IS NOT NULL
		AND CAST(jel."credit" AS numeric) = CAST(dl."amount" AS numeric)
		AND COALESCE(jel."memo", '') = COALESCE(dl."description", 'Additional deposit line')
	ORDER BY jel."created_at"
	LIMIT 1
)
WHERE dl."account_id" IS NULL
	AND dl."payment_id" IS NULL
	AND COALESCE(dl."description", '') NOT LIKE 'salesReceipt:%'
	AND COALESCE(dl."description", '') NOT LIKE 'cashback:%';
