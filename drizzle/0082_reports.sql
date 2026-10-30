-- Report gaps round (reports): Commented Reports and emailed scheduled reports.
--
-- commented_reports (QB "Comment on Report" / Reports > Commented Reports): a report saved as a
-- picture of what it showed when it was commented — the run's columns and rows (snapshot, with no
-- QuickZoom targets) plus the comments typed on its amounts (comments: [{ id, rowId, columnKey,
-- text }]) — so it can be printed, exported or sent later exactly as it was discussed. The
-- report type and its options (params) say what was run; re-running is a new commented report.
CREATE TABLE IF NOT EXISTS "commented_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(255) NOT NULL,
	"report_type" varchar(100) NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"comments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid REFERENCES "users"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commented_reports_company_idx" ON "commented_reports" ("company_id", "created_at");
--> statement-breakpoint
-- Scheduled reports can also be emailed (QB "Send report as e-mail"): the recipients, comma
-- separated. The email goes through the Send Forms settings and the network policy (an outside
-- mail server needs the company's opt-in); a schedule without recipients only saves files.
ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "email_to" text;
