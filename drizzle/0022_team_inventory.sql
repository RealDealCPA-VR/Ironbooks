-- Team inventory: Advanced Inventory (sites, bins, serial/lot, barcodes, transfers, landed cost).
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "barcode" varchar(100);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "tracking_mode" varchar(10) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "weight" numeric(15, 4);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_company_barcode_uq" ON "items" ("company_id", "barcode") WHERE "barcode" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_layers" ADD COLUMN IF NOT EXISTS "source_ref" varchar(100);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"code" varchar(50),
	"address" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_sites_company_default_uq" ON "inventory_sites" ("company_id") WHERE "is_default" = true;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_bins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"site_id" uuid NOT NULL REFERENCES "inventory_sites"("id"),
	"name" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"item_id" uuid NOT NULL REFERENCES "items"("id"),
	"site_id" uuid NOT NULL REFERENCES "inventory_sites"("id"),
	"bin_id" uuid REFERENCES "inventory_bins"("id"),
	"quantity" numeric(15, 4) NOT NULL,
	"serial_number" varchar(100),
	"lot_number" varchar(100),
	"date" timestamp NOT NULL,
	"source_type" varchar(40) NOT NULL,
	"source_id" uuid,
	"source_line" integer,
	"reversal_of_id" uuid,
	"reversed_at" timestamp,
	"memo" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_movements_item_site_idx" ON "inventory_movements" ("company_id", "item_id", "site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_movements_source_idx" ON "inventory_movements" ("company_id", "source_type", "source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_movements_serial_idx" ON "inventory_movements" ("company_id", "item_id", "serial_number") WHERE "serial_number" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_line_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"source_type" varchar(40) NOT NULL,
	"source_id" uuid NOT NULL,
	"line_order" integer NOT NULL,
	"item_id" uuid NOT NULL REFERENCES "items"("id"),
	"site_id" uuid REFERENCES "inventory_sites"("id"),
	"bin_id" uuid REFERENCES "inventory_bins"("id"),
	"serial_numbers" jsonb,
	"lot_number" varchar(100),
	"lot_expiration" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_line_details_source_idx" ON "inventory_line_details" ("company_id", "source_type", "source_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"item_id" uuid NOT NULL REFERENCES "items"("id"),
	"lot_number" varchar(100) NOT NULL,
	"expiration_date" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_lots_item_lot_uq" ON "inventory_lots" ("company_id", "item_id", "lot_number");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_site_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"item_id" uuid NOT NULL REFERENCES "items"("id"),
	"site_id" uuid NOT NULL REFERENCES "inventory_sites"("id"),
	"reorder_point" numeric(15, 4),
	"max_quantity" numeric(15, 4),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "item_site_settings_item_site_uq" ON "item_site_settings" ("company_id", "item_id", "site_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"transfer_number" integer NOT NULL,
	"date" timestamp NOT NULL,
	"from_site_id" uuid NOT NULL REFERENCES "inventory_sites"("id"),
	"to_site_id" uuid NOT NULL REFERENCES "inventory_sites"("id"),
	"status" varchar(20) DEFAULT 'posted' NOT NULL,
	"memo" text,
	"voided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_transfers_company_number_uq" ON "inventory_transfers" ("company_id", "transfer_number");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL REFERENCES "inventory_transfers"("id"),
	"item_id" uuid NOT NULL REFERENCES "items"("id"),
	"quantity" numeric(15, 4) NOT NULL,
	"from_bin_id" uuid REFERENCES "inventory_bins"("id"),
	"to_bin_id" uuid REFERENCES "inventory_bins"("id"),
	"serial_numbers" jsonb,
	"lot_number" varchar(100),
	"line_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "landed_cost_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"bill_id" uuid NOT NULL REFERENCES "bills"("id"),
	"bill_line_id" uuid NOT NULL,
	"charge_account_id" uuid NOT NULL REFERENCES "accounts"("id"),
	"method" varchar(20) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"date" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'posted' NOT NULL,
	"memo" text,
	"voided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "landed_cost_allocation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_id" uuid NOT NULL REFERENCES "landed_cost_allocations"("id"),
	"item_receipt_id" uuid NOT NULL REFERENCES "item_receipts"("id"),
	"item_receipt_line_id" uuid NOT NULL REFERENCES "item_receipt_lines"("id"),
	"item_id" uuid NOT NULL REFERENCES "items"("id"),
	"basis" numeric(15, 4) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"inventory_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cogs_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"quantity_at_allocation" numeric(15, 4) DEFAULT '0' NOT NULL,
	"layer_adjustments" jsonb,
	"entry_id" uuid REFERENCES "journal_entries"("id"),
	"line_order" integer DEFAULT 0 NOT NULL
);
