-- Guided month-end close (lib/services/monthEndClose.ts).
--
-- One row per company + period end ('YYYY-MM-DD'). The checklist itself is computed live from the
-- books; this row only keeps what people decided about it:
--   steps        { <stepKey>: { reviewed, reviewedBy, reviewedByName, reviewedAt, note, skipReason } }
--   scan_ran_at  when the error scan / Verify Data step was last run for this period
--   status       'open' | 'closed' (closed once the closing date was set to period_end)
--   updated_at   record-locking version (two people ticking the same checklist)
CREATE TABLE IF NOT EXISTS "month_end_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"period_end" varchar(10) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scan_ran_at" timestamp,
	"closed_at" timestamp,
	"closed_by" uuid REFERENCES "users"("id"),
	"created_by" uuid REFERENCES "users"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "month_end_closes_company_period_idx" ON "month_end_closes" ("company_id", "period_end");
