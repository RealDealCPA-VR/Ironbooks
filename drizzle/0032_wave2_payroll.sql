-- wave2 payroll: historical YTD / liability adjustments on paychecks, employee employment
-- fields, employer state payroll tax settings (SUI/SDI) and workers' compensation codes.
ALTER TABLE "paychecks" ADD COLUMN IF NOT EXISTS "entry_type" varchar(30) DEFAULT 'paycheck' NOT NULL;--> statement-breakpoint
ALTER TABLE "paychecks" ADD COLUMN IF NOT EXISTS "memo" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "hire_date" timestamp;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "release_date" timestamp;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "phone" varchar(50);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "workers_comp_code_id" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_state_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"state" varchar(2) NOT NULL,
	"year" integer NOT NULL,
	"sui_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"sui_wage_base" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sdi_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"sdi_wage_base" numeric(15, 2) DEFAULT '0' NOT NULL,
	"account_number" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_state_settings_company_state_year_uq" ON "payroll_state_settings" ("company_id", "state", "year");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workers_comp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"code" varchar(20) NOT NULL,
	"description" varchar(255),
	"rate_per_100" numeric(9, 4) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workers_comp_codes_company_code_uq" ON "workers_comp_codes" ("company_id", "code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paychecks_company_employee_date_idx" ON "paychecks" ("company_id", "employee_id", "pay_date");
