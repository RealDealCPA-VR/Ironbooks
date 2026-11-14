-- Review loop 4 (confirmation): a line's own tax rate is kept on an edit too (see 0090).
--
-- 0090 kept the document's tax item rate; a line with its own tax item still re-read today's
-- rate on every save. The rates charged are stored per tax item ({taxRateId: rate}) and reused
-- for the tax items the edit still uses. Null on documents saved before this.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "line_tax_rates" jsonb;
--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "line_tax_rates" jsonb;
