-- prefsperms: preferences, QuickBooks Enterprise permissions, email set-up inside the app.
--
-- 1. Two-factor RECOVERY codes (Security (2FA)). A sole Admin who lost their authenticator app
--    could never sign in again. Turning two-factor sign-in on now hands out ten one-time codes;
--    only their SHA-256 hashes are kept here (with when each was used).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_recovery_codes" jsonb;
--> statement-breakpoint
-- 2. Send Forms: the mail server lives IN the company file (Preferences > Send Forms), so a desktop
--    user can set it up without environment variables, and it travels with the file. The password
--    is sealed with the file's own vault secret (lib/ai/keyVault.ts sealForFile, "v2:" blobs) and
--    never returned. Files for outsiders (Accountant's Copy, Period Copy) leave that secret out.
CREATE TABLE IF NOT EXISTS "company_email_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "host" varchar(255),
  "port" integer,
  "security" varchar(16) DEFAULT 'starttls' NOT NULL,
  "username" varchar(255),
  "password_enc" text,
  "from_name" varchar(255),
  "from_email" varchar(255),
  "reply_to" varchar(255),
  "bcc" varchar(500),
  "use_sender_address" boolean DEFAULT true NOT NULL,
  "last_test_at" timestamp,
  "last_test_ok" boolean,
  "last_test_message" text,
  "updated_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_email_settings_company_idx" ON "company_email_settings" ("company_id");
