-- Challenge question for resetting a forgotten password (QuickBooks Desktop asks the Admin to pick
-- one when the password is set). A company file is portable — copied to a file server, a USB drive
-- or an accountant — and its users live inside it, so "forgot password" on this computer must ask
-- for something only the user knows rather than reset the only user's password for anyone who
-- can type the user name.
--
-- users gains
--   challenge_question     the question the user picked (lib/challengeQuestions.ts)
--   challenge_answer_hash  bcrypt of the normalized answer (case- and spacing-insensitive)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "challenge_question" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "challenge_answer_hash" text;
