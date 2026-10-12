-- P1 round, team payments.
--
-- journal_item_applications kind 'journal_offset': a General Journal A/R credit applied to a
-- General Journal A/R charge of the same customer in Receive Payments (or an A/P vendor-credit
-- line applied to an A/P amount-owed line in Pay Bills), as QuickBooks allows. One application is
-- two rows sharing "pair_id": one on the credit line and one on the charge line, same amount and
-- date. No GL is posted (both lines already sit in A/R or A/P); each line's open amount drops.
ALTER TABLE "journal_item_applications" ADD COLUMN IF NOT EXISTS "pair_id" uuid;
--> statement-breakpoint
ALTER TABLE "journal_item_applications" DROP CONSTRAINT IF EXISTS "journal_item_applications_kind";
--> statement-breakpoint
ALTER TABLE "journal_item_applications" ADD CONSTRAINT "journal_item_applications_kind" CHECK (
	("kind" = 'payment' AND "side" = 'ar' AND "payment_id" IS NOT NULL)
	OR ("kind" = 'invoice_credit' AND "side" = 'ar' AND "invoice_id" IS NOT NULL)
	OR ("kind" = 'bill_payment' AND "side" = 'ap' AND "bill_payment_id" IS NOT NULL)
	OR ("kind" = 'bill_credit' AND "side" = 'ap' AND "bill_id" IS NOT NULL)
	OR ("kind" = 'journal_offset' AND "pair_id" IS NOT NULL AND "invoice_id" IS NULL AND "bill_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_item_applications_pair_idx" ON "journal_item_applications" ("pair_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_received_company_date_idx" ON "payments_received" ("company_id", "date");
