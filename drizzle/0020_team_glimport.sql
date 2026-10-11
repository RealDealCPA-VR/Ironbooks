CREATE TABLE IF NOT EXISTS "qb_gl_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"period_start" timestamp,
	"period_end" timestamp,
	"entries_posted" integer DEFAULT 0 NOT NULL,
	"entries_skipped" integer DEFAULT 0 NOT NULL,
	"accounts_created" integer DEFAULT 0 NOT NULL,
	"variance_amount" numeric(15, 2),
	"proof" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "qb_gl_imports" ADD CONSTRAINT "qb_gl_imports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "qb_gl_imports" ADD CONSTRAINT "qb_gl_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qb_gl_imports_company_idx" ON "qb_gl_imports" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_source_ref_idx" ON "journal_entries" ("company_id", "source_ref");
