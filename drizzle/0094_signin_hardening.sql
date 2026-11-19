-- Security review (sign-in): limits that must outlive a restart, and sign-outs that really end.
--
-- "I forgot my password": wrong challenge answers were only counted in memory, so restarting the
-- app cleared the count. The count and its growing lockout now live on the user's row; a right
-- answer or a successful sign-in clears them.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "challenge_failed_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "challenge_lockouts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "challenge_locked_until" timestamp;
--> statement-breakpoint
-- Two-factor sign-in: the 30-second step of the last code accepted, so the same code can't be
-- used twice (lib/services/totpCodes.ts).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_last_step" integer;
--> statement-breakpoint
-- Employee portal: signing out raises the version, which ends every portal sign-in made before.
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "portal_token_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Password-reset tokens are now kept only as a fingerprint ("<how>:<sha256>"). A token an older
-- version stored as plain text could never be used again anyway (they last an hour); drop it.
UPDATE "users" SET "reset_token" = NULL, "reset_expires" = NULL WHERE "reset_token" IS NOT NULL AND position(':' in "reset_token") = 0;
