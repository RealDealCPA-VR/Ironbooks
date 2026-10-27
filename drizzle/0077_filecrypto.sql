-- The password belongs to the company file: encryption at rest of the single company file
-- (electron/fileCrypto.js, electron/companyFileFormat.js format 2, lib/services/fileProtection.ts).
--
-- A protected company file is encrypted with one random file key, which is never stored anywhere.
-- What the file stores are KEY SLOTS: the file key wrapped with a key derived from one secret —
-- a user's password, a user's challenge answer, or the file's recovery key. The slots live here,
-- inside the (encrypted) database, and a copy of them is written into the company file's plain
-- manifest with every save, so the file opens on any computer with a fresh install for anyone who
-- knows one of those secrets.
--
-- file_protection  one row while the file is protected: the key check (a digest that names the
--                  file key without revealing it) and the lookup salt (slots are found by an HMAC
--                  of the user name with it, so the manifest never lists user names).
-- file_key_slots   the slots. `secret_ref` is a digest of the user's password hash (or challenge
--                  answer hash) when the slot was made: a slot whose user has since changed that
--                  secret is stale and is left out of the file until the next sign-in re-wraps it.
--
-- Existing company files are not protected by this migration; an Admin turns protection on
-- (Company > Security), and every new company file is protected from its first save.
CREATE TABLE IF NOT EXISTS "file_protection" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "key_check" varchar(64) NOT NULL,
  "lookup_salt" varchar(64) NOT NULL,
  "protected_at" timestamp DEFAULT now() NOT NULL,
  "protected_by" uuid,
  "recovery_created_at" timestamp,
  CONSTRAINT "file_protection_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_key_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" varchar(16) NOT NULL,
  "user_id" uuid,
  "tag" varchar(64),
  "question" text,
  "secret_ref" varchar(64),
  "slot" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "file_key_slots_kind_check" CHECK ("kind" IN ('password', 'challenge', 'recovery'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "file_key_slots" ADD CONSTRAINT "file_key_slots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "file_key_slots_user_kind_idx" ON "file_key_slots" USING btree ("user_id", "kind") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "file_key_slots_one_recovery_idx" ON "file_key_slots" USING btree ("kind") WHERE "kind" = 'recovery';
