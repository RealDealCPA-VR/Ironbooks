ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "group_name" varchar(100);
--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "mode" varchar(20) DEFAULT 'automatic' NOT NULL;
--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "remaining" integer;
--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "days_in_advance" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "last_run_at" timestamp;
--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "anchor_day" integer;
--> statement-breakpoint
UPDATE "recurring_templates" SET "mode" = 'remind' WHERE "mode" = 'automatic' AND ("template" -> '__options' ->> 'autoEnter') = 'false';
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "entity_type" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "entity_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"prefs" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_preferences_company_user_idx" ON "user_preferences" ("company_id", "user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"form_type" varchar(30) NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"design" jsonb NOT NULL,
	"logo_attachment_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_templates_company_type_idx" ON "form_templates" ("company_id", "form_type");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_templates_one_default_idx" ON "form_templates" ("company_id", "form_type") WHERE "is_default" = true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"user_id" uuid REFERENCES "users"("id"),
	"title" varchar(255) NOT NULL,
	"notes" text,
	"kind" varchar(20) DEFAULT 'task' NOT NULL,
	"priority" varchar(10) DEFAULT 'medium' NOT NULL,
	"due_date" varchar(10),
	"due_time" varchar(5),
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp,
	"entity_type" varchar(30),
	"entity_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todos_company_due_idx" ON "todos" ("company_id", "due_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"company_name" varchar(255),
	"status" varchar(10) DEFAULT 'warm' NOT NULL,
	"email" varchar(255),
	"phone" varchar(50),
	"website" varchar(255),
	"address" jsonb,
	"contacts" jsonb,
	"notes" text,
	"converted_customer_id" uuid REFERENCES "customers"("id"),
	"converted_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "letter_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"category" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
