-- Review loop 5 (memorized transactions): why an automatic entry could not be entered.
--
-- The automatic run (launch + hourly) only logged a failure to the console, so a template whose
-- entry failed (closed period, inactive name, ...) stayed due forever while the Reminders list
-- still said it "enters automatically". The last failure is now kept on the template and shown
-- on the Memorized Transactions list and in Reminders; a successful entry clears it.
ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD COLUMN IF NOT EXISTS "last_error_at" timestamp;
