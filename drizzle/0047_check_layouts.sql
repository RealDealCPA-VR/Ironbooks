-- Check printing on any pre-cut / pre-printed check stock (QB Printer Setup parity + custom layouts).
--
-- check_print_settings gains:
--   check_position         'top' | 'middle' | 'bottom' — where the check sits on voucher / wallet stock
--   layout                 per-field position overrides (inches from the check's top-left; only fields
--                          that differ from the QB defaults are stored; NULL = defaults)
--   first_sheet_remaining  standard checks (3 per sheet): unused checks left on the first sheet (1-3)
--   page_size              'letter' | 'legal'
--   check_height           height of one check in inches (2.75-3.67)
-- Existing rows get the defaults, which print exactly as before.
ALTER TABLE "check_print_settings" ADD COLUMN IF NOT EXISTS "check_position" varchar(10) DEFAULT 'top' NOT NULL;
--> statement-breakpoint
ALTER TABLE "check_print_settings" ADD COLUMN IF NOT EXISTS "layout" jsonb;
--> statement-breakpoint
ALTER TABLE "check_print_settings" ADD COLUMN IF NOT EXISTS "first_sheet_remaining" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "check_print_settings" ADD COLUMN IF NOT EXISTS "page_size" varchar(10) DEFAULT 'letter' NOT NULL;
--> statement-breakpoint
ALTER TABLE "check_print_settings" ADD COLUMN IF NOT EXISTS "check_height" numeric(5, 3) DEFAULT '3.5' NOT NULL;
