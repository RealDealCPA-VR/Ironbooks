-- Accountant's Copy, complete (PARITY I1): the changes file now carries sales and purchase forms,
-- payments and their applications, reconciliations and list (name / item) changes.
--
-- accountant_copy_baseline gains
--   digest  md5 of the record's substance at the moment the copy was opened (derived values such
--           as balances, amounts paid, print flags and the posted entry are left out), so a record
--           whose version only moved because a payment was applied is not reported as edited — and
--           the client import can tell such a record from one the client really changed;
--   state   'void' / 'draft' / 'live' (posting forms) or the status (estimates, sales orders, POs).
ALTER TABLE "accountant_copy_baseline" ALTER COLUMN "entity_type" TYPE varchar(40);
--> statement-breakpoint
ALTER TABLE "accountant_copy_baseline" ADD COLUMN IF NOT EXISTS "digest" text;
--> statement-breakpoint
ALTER TABLE "accountant_copy_baseline" ADD COLUMN IF NOT EXISTS "state" varchar(20);
