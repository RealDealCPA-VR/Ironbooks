-- p1/salesforms: customer ship-to addresses (QB Enterprise: several named ship-to addresses per
-- customer, one of them the default), a ship-to on estimates, and sales tax on sales orders
-- (tax item + per-line Tax flag, carried to the invoice on conversion).
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "ship_to_addresses" jsonb;--> statement-breakpoint
-- Existing customers: their single shipping address becomes the default ship-to "Ship To 1".
UPDATE "customers"
SET "ship_to_addresses" = jsonb_build_array("shipping_address" || jsonb_build_object('name', 'Ship To 1', 'isDefault', true))
WHERE "ship_to_addresses" IS NULL
  AND "shipping_address" IS NOT NULL
  AND jsonb_typeof("shipping_address") = 'object'
  AND "shipping_address" <> '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "ship_to" jsonb;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "tax_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN IF NOT EXISTS "taxable" boolean DEFAULT true NOT NULL;
