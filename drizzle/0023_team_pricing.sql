-- team pricing: Advanced Pricing (price levels, price rules, customer/vendor types),
-- per-line pricing provenance, and Enhanced Receiving (receipt -> bill variance links).
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "customer_type_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "price_level_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "vendor_type_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD COLUMN IF NOT EXISTS "pricing" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN IF NOT EXISTS "pricing" jsonb;--> statement-breakpoint
ALTER TABLE "sales_receipt_lines" ADD COLUMN IF NOT EXISTS "pricing" jsonb;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN IF NOT EXISTS "pricing" jsonb;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "quantity_received_unbilled" numeric(15, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "item_receipt_lines" ADD COLUMN IF NOT EXISTS "quantity_billed" numeric(15, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Receipts converted to bills before this migration were billed in full.
UPDATE "item_receipt_lines" SET "quantity_billed" = "quantity"
  WHERE "item_receipt_id" IN (SELECT "id" FROM "item_receipts" WHERE "status" = 'billed')
    AND "quantity_billed" = 0;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"parent_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"parent_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"type" varchar(20) DEFAULT 'fixed_percent' NOT NULL,
	"percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"rounding" varchar(20),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_level_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"price_level_id" uuid NOT NULL REFERENCES "price_levels"("id"),
	"item_id" uuid NOT NULL REFERENCES "items"("id"),
	"price" numeric(15, 4) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_level_items_level_item_uq" ON "price_level_items" ("price_level_id", "item_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"conditions" jsonb NOT NULL,
	"adjustment" jsonb NOT NULL,
	"tiers" jsonb,
	"rounding" varchar(20),
	"start_date" varchar(10),
	"end_date" varchar(10),
	"min_quantity" numeric(15, 4),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_rules_company_idx" ON "price_rules" ("company_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_receipt_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"bill_id" uuid NOT NULL REFERENCES "bills"("id"),
	"item_receipt_id" uuid NOT NULL REFERENCES "item_receipts"("id"),
	"item_receipt_line_id" uuid NOT NULL REFERENCES "item_receipt_lines"("id"),
	"item_id" uuid NOT NULL REFERENCES "items"("id"),
	"quantity" numeric(15, 4) NOT NULL,
	"receipt_unit_cost" numeric(15, 4) NOT NULL,
	"bill_unit_cost" numeric(15, 4) NOT NULL,
	"accrual_amount" numeric(15, 2) NOT NULL,
	"bill_amount" numeric(15, 2) NOT NULL,
	"variance" numeric(15, 2) DEFAULT '0' NOT NULL,
	"variance_mode" varchar(20) DEFAULT 'none' NOT NULL,
	"inventory_variance" numeric(15, 2) DEFAULT '0' NOT NULL,
	"expensed_variance" numeric(15, 2) DEFAULT '0' NOT NULL,
	"layer_adjustments" jsonb,
	"written_off" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_receipt_bill_lines_bill_idx" ON "item_receipt_bill_lines" ("bill_id");
