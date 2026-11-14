-- Review loop 4 (sales tax): a sales document keeps the tax rate it was charged at.
--
-- Invoices, sales receipts and credit memos re-read their tax item's CURRENT rate on every save,
-- so fixing a typo on a Q1 invoice after the rate changed in Q3 re-taxed it at the new rate and
-- silently changed a period whose sales tax was already paid. The rate charged is now stored on the
-- document and reused while its tax item stays the same; changing the tax item takes the new
-- item's current rate. Null on documents saved before this (their next save stores it).
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tax_rate_value" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "tax_rate_value" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "tax_rate_value" numeric(9, 6);
