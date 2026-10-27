-- Team salesar (feature round): lists and sales gaps to QuickBooks parity.
--
-- Every column is new and nullable (or has a default), so an existing company file upgrades in
-- place and every document saved before keeps working exactly as it did.
--
-- 1. Credit memos carry a class and a Customer:Job, on the memo and on each line (a write-off of a
--    job invoice then posts its bad debt to that job and class, as the invoice's income was).
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "class_id" uuid REFERENCES "classes"("id");
--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "job_id" uuid REFERENCES "jobs"("id");
--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD COLUMN IF NOT EXISTS "class_id" uuid REFERENCES "classes"("id");
--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD COLUMN IF NOT EXISTS "job_id" uuid REFERENCES "jobs"("id");
--> statement-breakpoint
-- 2. Payment Method list (B7): received payments and sales receipts name the list entry they were
--    paid with ("Visa", "E-Check"); `method` keeps the entry's type, so deposits and reports that
--    group by type keep working. NULL on documents saved before (they show their type).
ALTER TABLE "payments_received" ADD COLUMN IF NOT EXISTS "payment_method_id" uuid REFERENCES "payment_methods"("id");
--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "payment_method_id" uuid REFERENCES "payment_methods"("id");
--> statement-breakpoint
-- 3. Customer Message list (B8): the message picked on a sales form, printed at its foot.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "customer_message_id" uuid REFERENCES "customer_messages"("id");
--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD COLUMN IF NOT EXISTS "customer_message_id" uuid REFERENCES "customer_messages"("id");
--> statement-breakpoint
ALTER TABLE "credit_memos" ADD COLUMN IF NOT EXISTS "customer_message_id" uuid REFERENCES "customer_messages"("id");
--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "customer_message_id" uuid REFERENCES "customer_messages"("id");
--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "customer_message_id" uuid REFERENCES "customer_messages"("id");
--> statement-breakpoint
-- 4. Sales Tax Code column on sales form lines (B9): the code the line was saved with ("Tax",
--    "Non", "OOS"...). `taxable` stays the flag the totals use; it follows the code. NULL on lines
--    saved before (their taxable flag is what they were taxed by).
ALTER TABLE "invoice_lines" ADD COLUMN IF NOT EXISTS "sales_tax_code_id" uuid REFERENCES "sales_tax_codes"("id");
--> statement-breakpoint
ALTER TABLE "sales_receipt_lines" ADD COLUMN IF NOT EXISTS "sales_tax_code_id" uuid REFERENCES "sales_tax_codes"("id");
--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD COLUMN IF NOT EXISTS "sales_tax_code_id" uuid REFERENCES "sales_tax_codes"("id");
--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD COLUMN IF NOT EXISTS "sales_tax_code_id" uuid REFERENCES "sales_tax_codes"("id");
--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN IF NOT EXISTS "sales_tax_code_id" uuid REFERENCES "sales_tax_codes"("id");
--> statement-breakpoint
-- 5. Billing Groups (C6): named groups of customers that Batch Invoicing bills together.
CREATE TABLE IF NOT EXISTS "billing_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" varchar(100) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_groups_company_name_uq" ON "billing_groups" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_group_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "group_id" uuid NOT NULL REFERENCES "billing_groups"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_group_members_uq" ON "billing_group_members" ("group_id", "customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_group_members_customer_idx" ON "billing_group_members" ("customer_id");
