-- fix/sales: QB-style progress invoicing. Estimate lines carry a class and remember what was
-- billed before per-line tracking existed; invoice lines link back to the estimate line they bill
-- (invoiced-to-date = prior + linked lines on posted, non-void invoices).
ALTER TABLE "estimate_lines" ADD COLUMN IF NOT EXISTS "class_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD COLUMN IF NOT EXISTS "prior_qty_invoiced" numeric(15, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD COLUMN IF NOT EXISTS "prior_amount_invoiced" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "prior_amount_invoiced" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN IF NOT EXISTS "estimate_line_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_lines_estimate_line_idx" ON "invoice_lines" ("estimate_line_id");--> statement-breakpoint
-- Backfill 1: an estimate converted in one go produced an invoice whose lines mirror the
-- estimate lines in order — link them.
UPDATE "invoice_lines" il
SET "estimate_line_id" = el."id"
FROM "estimates" e
JOIN "estimate_lines" el ON el."estimate_id" = e."id"
JOIN "invoices" i ON i."id" = e."converted_invoice_id"
WHERE il."invoice_id" = i."id"
  AND il."estimate_line_id" IS NULL
  AND il."line_order" = el."line_order"
  AND il."quantity" = el."quantity"
  AND il."item_id" IS NOT DISTINCT FROM el."item_id"
  AND COALESCE(i."memo", '') NOT LIKE 'Progress billing (%';--> statement-breakpoint
-- Backfill 2: estimates billed by the old dollar-only progress invoicing have no line links;
-- keep what they had billed as a "prior" amount, spread over the lines pro rata.
UPDATE "estimate_lines" el
SET "prior_amount_invoiced" = ROUND(el."amount" * LEAST(e."amount_invoiced" / e."total", 1), 2),
    "prior_qty_invoiced" = ROUND(el."quantity" * LEAST(e."amount_invoiced" / e."total", 1), 4)
FROM "estimates" e
WHERE el."estimate_id" = e."id"
  AND e."amount_invoiced" > 0
  AND e."total" > 0
  AND e."prior_amount_invoiced" = 0
  AND NOT EXISTS (
    SELECT 1 FROM "invoice_lines" il JOIN "estimate_lines" el2 ON el2."id" = il."estimate_line_id"
    WHERE el2."estimate_id" = e."id"
  );--> statement-breakpoint
UPDATE "estimates" e
SET "prior_amount_invoiced" = e."amount_invoiced"
WHERE e."amount_invoiced" > 0
  AND e."prior_amount_invoiced" = 0
  AND NOT EXISTS (
    SELECT 1 FROM "invoice_lines" il JOIN "estimate_lines" el2 ON el2."id" = il."estimate_line_id"
    WHERE el2."estimate_id" = e."id"
  );
