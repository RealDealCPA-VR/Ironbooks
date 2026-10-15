-- Parity gaps B3 / B12 (team gapsa).
--
-- B3  Other Names as payees: a check / cash expense / credit card charge can be written to an
--     entry of the Other Names list (QB "Other" name type). expenses.other_name_id links it; the
--     printed payee text stays in payee_name. Merging other names re-points this foreign key.
-- B12 Price levels on credit memos: credit_memo_lines.pricing records which price rule / price
--     level priced the line (same jsonb shape as invoice_lines.pricing, lib/services/pricing.ts).
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "other_name_id" uuid REFERENCES "other_names"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_other_name_idx" ON "expenses" ("other_name_id");
--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD COLUMN IF NOT EXISTS "pricing" jsonb;
