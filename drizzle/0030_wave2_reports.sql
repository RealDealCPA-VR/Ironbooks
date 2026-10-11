-- wave2 reports: memorized report groups, scheduled reports, budget kinds / forecasts /
-- Customer:Job budgets, mileage vehicle.
CREATE TABLE IF NOT EXISTS "memorized_report_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memorized_report_groups_company_idx" ON "memorized_report_groups" ("company_id");
--> statement-breakpoint
ALTER TABLE "memorized_reports" ADD COLUMN IF NOT EXISTS "group_id" uuid REFERENCES "memorized_report_groups"("id");
--> statement-breakpoint
ALTER TABLE "memorized_reports" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"memorized_report_id" uuid REFERENCES "memorized_reports"("id"),
	"group_id" uuid REFERENCES "memorized_report_groups"("id"),
	"frequency" varchar(20) NOT NULL,
	"next_run_at" timestamp NOT NULL,
	"anchor_day" integer,
	"format" varchar(10) DEFAULT 'csv' NOT NULL,
	"folder" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp,
	"last_status" varchar(20),
	"last_message" text,
	"created_by" uuid REFERENCES "users"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "anchor_day" integer;
--> statement-breakpoint
UPDATE "report_schedules" SET "anchor_day" = EXTRACT(DAY FROM "next_run_at")::integer WHERE "anchor_day" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_schedules_due_idx" ON "report_schedules" ("company_id", "is_active", "next_run_at");
--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN IF NOT EXISTS "kind" varchar(20) DEFAULT 'profit_loss' NOT NULL;
--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN IF NOT EXISTS "is_forecast" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "budget_lines" ADD COLUMN IF NOT EXISTS "customer_id" uuid REFERENCES "customers"("id");
--> statement-breakpoint
ALTER TABLE "mileage_logs" ADD COLUMN IF NOT EXISTS "vehicle" varchar(100);
