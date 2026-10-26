-- Review round 5 (purchases): indexes for the purchase documents' hot lookups.
--
-- Every bill / check / vendor credit / item receipt / PO is loaded, edited, voided and printed by
-- its lines (bill_lines.bill_id, expense_lines.expense_id, ...), Pay Bills and every payment void
-- read bill_payment_applications by bill and by payment, and Write Checks / Pay Bills look up the
-- account's check numbers and a vendor's bills. None of these child-table columns had an index,
-- so each lookup scanned the whole table — fine on a demo file, seconds per bill or check on a
-- company file with years of history. Index-only migration (no table or column changes), safe to
-- re-run.
CREATE INDEX IF NOT EXISTS "bill_lines_bill_idx" ON "bill_lines" ("bill_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bill_payment_applications_bill_idx" ON "bill_payment_applications" ("bill_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bill_payment_applications_payment_idx" ON "bill_payment_applications" ("bill_payment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_company_vendor_idx" ON "bills" ("company_id", "vendor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bill_payments_company_account_idx" ON "bill_payments" ("company_id", "payment_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expense_lines_expense_idx" ON "expense_lines" ("expense_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_company_account_idx" ON "expenses" ("company_id", "payment_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_credit_lines_credit_idx" ON "vendor_credit_lines" ("vendor_credit_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_receipt_lines_receipt_idx" ON "item_receipt_lines" ("item_receipt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_order_lines_po_idx" ON "purchase_order_lines" ("purchase_order_id");
