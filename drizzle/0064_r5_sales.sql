-- Review round 5 (sales / A/R): indexes on the A/R document lines and applications.
--
-- Postgres does not index foreign keys by itself, and these hot lookups had none, so on a large
-- company file every one of them read the whole table:
--   - a document's lines (open / print / edit / void of an invoice, sales receipt, credit memo,
--     estimate or sales order);
--   - the customer statement's per-invoice "payment-item lines" subquery (one full scan of
--     invoice_lines per invoice: 0.5 s for one customer on 20,000 invoices, 4 ms with the index);
--   - a payment's applications and the applications of an invoice (Receive Payments, voids,
--     edits, Transaction History, as-of agings);
--   - a customer's invoices, credit memos and payments (statements, credit limit, balances).
CREATE INDEX IF NOT EXISTS "invoice_lines_invoice_idx" ON "invoice_lines" ("invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_company_customer_idx" ON "invoices" ("company_id", "customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_applications_payment_idx" ON "payment_applications" ("payment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_applications_invoice_idx" ON "payment_applications" ("invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_received_company_customer_idx" ON "payments_received" ("company_id", "customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_memos_company_customer_idx" ON "credit_memos" ("company_id", "customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_memo_lines_memo_idx" ON "credit_memo_lines" ("credit_memo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_applications_payment_idx" ON "credit_applications" ("payment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_receipt_lines_receipt_idx" ON "sales_receipt_lines" ("sales_receipt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_lines_estimate_idx" ON "estimate_lines" ("estimate_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_order_lines_order_idx" ON "sales_order_lines" ("sales_order_id");
--> statement-breakpoint
-- Billable time & costs: the source an invoice line bills ({"kind":"bill_line"|"expense_line"|
-- "time_entry","id":...}), so an invoice edit that removes the line (or moves the invoice to
-- another customer) puts that cost or time back on the customer's Time/Costs list. NULL on lines
-- that bill nothing and on lines saved before this column existed (those stay billed until the
-- invoice is voided, as before).
ALTER TABLE "invoice_lines" ADD COLUMN IF NOT EXISTS "billable_source" jsonb;
