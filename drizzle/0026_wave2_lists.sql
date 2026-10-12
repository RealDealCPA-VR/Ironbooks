-- wave2 lists: QB Desktop list parity (Other Names, Job Types, Terms, Ship Via, Payment Methods,
-- Customer Messages, Sales Tax Codes, To Do, Notes, Billing Rate Levels, Vehicles, U/M sets) plus
-- the new master-data columns on customers / vendors / items / employees / jobs / mileage_logs.
-- Master data only: nothing here touches the ledger.
CREATE TABLE IF NOT EXISTS "list_seeds" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"list_key" varchar(50) NOT NULL,
	"seeded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_rate_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(100) NOT NULL,
	"type" varchar(20) DEFAULT 'fixed_rate' NOT NULL,
	"fixed_rate" numeric(15, 4),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_rate_levels_name_uq" ON "billing_rate_levels" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_rate_level_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"level_id" uuid NOT NULL REFERENCES "billing_rate_levels"("id"),
	"item_id" uuid NOT NULL REFERENCES "items"("id"),
	"rate" numeric(15, 4) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_rate_level_items_uq" ON "billing_rate_level_items" ("level_id", "item_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "other_names" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"company_name" varchar(255),
	"email" varchar(255),
	"phone" varchar(50),
	"address" jsonb,
	"account_number" varchar(100),
	"notes" text,
	"billing_rate_level_id" uuid REFERENCES "billing_rate_levels"("id"),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "other_names_name_uq" ON "other_names" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"parent_id" uuid REFERENCES "job_types"("id"),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_types_name_uq" ON "job_types" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(100) NOT NULL,
	"code" varchar(50),
	"kind" varchar(20) DEFAULT 'standard' NOT NULL,
	"net_days" integer,
	"discount_percent" numeric(7, 4),
	"discount_days" integer,
	"due_day_of_month" integer,
	"due_next_month_within_days" integer,
	"discount_day_of_month" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_terms_name_uq" ON "payment_terms" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ship_via_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ship_via_methods_name_uq" ON "ship_via_methods" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(100) NOT NULL,
	"type" "payment_method" DEFAULT 'other' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_methods_name_uq" ON "payment_methods" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"message" varchar(500) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_messages_message_uq" ON "customer_messages" ("company_id", lower("message"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"code" varchar(3) NOT NULL,
	"description" varchar(255),
	"taxable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tax_codes_code_uq" ON "sales_tax_codes" ("company_id", lower("code"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "todo_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"title" varchar(255) NOT NULL,
	"details" text,
	"type" varchar(20) DEFAULT 'task' NOT NULL,
	"priority" varchar(10) DEFAULT 'medium' NOT NULL,
	"status" varchar(10) DEFAULT 'open' NOT NULL,
	"due_date" timestamp,
	"entity_type" varchar(30),
	"entity_id" uuid,
	"assigned_user_id" uuid REFERENCES "users"("id"),
	"created_by" uuid REFERENCES "users"("id"),
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todo_items_company_idx" ON "todo_items" ("company_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"entity_type" varchar(30) NOT NULL,
	"entity_id" uuid NOT NULL,
	"note_date" timestamp DEFAULT now() NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid REFERENCES "users"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_notes_entity_idx" ON "entity_notes" ("company_id", "entity_type", "entity_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(100) NOT NULL,
	"description" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vehicles_name_uq" ON "vehicles" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uom_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(100) NOT NULL,
	"kind" varchar(20) DEFAULT 'count' NOT NULL,
	"base_unit_name" varchar(50) NOT NULL,
	"base_unit_abbrev" varchar(20) NOT NULL,
	"default_purchase_unit" varchar(50),
	"default_sales_unit" varchar(50),
	"default_shipping_unit" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uom_sets_name_uq" ON "uom_sets" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uom_set_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"set_id" uuid NOT NULL REFERENCES "uom_sets"("id"),
	"name" varchar(50) NOT NULL,
	"abbrev" varchar(20) NOT NULL,
	"factor" numeric(18, 6) NOT NULL,
	"line_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uom_set_units_name_uq" ON "uom_set_units" ("set_id", lower("name"));
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "terms_id" uuid REFERENCES "payment_terms"("id");
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "sales_tax_code_id" uuid REFERENCES "sales_tax_codes"("id");
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "resale_number" varchar(50);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "tax_exemption_reason" varchar(100);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "terms_id" uuid REFERENCES "payment_terms"("id");
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "billing_rate_level_id" uuid REFERENCES "billing_rate_levels"("id");
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "preferred_vendor_id" uuid REFERENCES "vendors"("id");
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "sales_tax_code_id" uuid REFERENCES "sales_tax_codes"("id");
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "uom_set_id" uuid REFERENCES "uom_sets"("id");
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "billing_rate_level_id" uuid REFERENCES "billing_rate_levels"("id");
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "job_type_id" uuid REFERENCES "job_types"("id");
--> statement-breakpoint
ALTER TABLE "mileage_logs" ADD COLUMN IF NOT EXISTS "vehicle_id" uuid REFERENCES "vehicles"("id");
--> statement-breakpoint
ALTER TABLE "mileage_logs" ADD COLUMN IF NOT EXISTS "odometer_start" numeric(12, 1);
--> statement-breakpoint
ALTER TABLE "mileage_logs" ADD COLUMN IF NOT EXISTS "odometer_end" numeric(12, 1);
