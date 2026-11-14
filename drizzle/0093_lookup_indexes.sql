-- Review loop 6 (migrations): indexes for lookups that scanned whole tables on large files.
--
-- inventory_layers had only its primary key: every FIFO sale, receipt, return and landed-cost
-- lookup filters by (company, item) or by source document. paycheck_lines had none on its
-- paycheck (opening a paycheck, YTD totals, edits). The billable-cost lookups by customer scanned
-- all bill / expense lines and time entries.
CREATE INDEX IF NOT EXISTS "inventory_layers_item_idx" ON "inventory_layers" ("company_id", "item_id", "date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_layers_source_idx" ON "inventory_layers" ("company_id", "source_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paycheck_lines_paycheck_idx" ON "paycheck_lines" ("paycheck_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bill_lines_billable_idx" ON "bill_lines" ("customer_id") WHERE "customer_id" IS NOT NULL AND "billed_invoice_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expense_lines_billable_idx" ON "expense_lines" ("customer_id") WHERE "customer_id" IS NOT NULL AND "billed_invoice_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entries_customer_idx" ON "time_entries" ("company_id", "customer_id") WHERE "invoiced_invoice_id" IS NULL;
