-- Review round 5 (security): secrets that travel with the company file.
--
-- AI provider API keys were encrypted with a key derived from this computer's .auth-secret, the
-- session-signing key that deliberately never goes into a company file, backup or portable file.
-- A company file opened on another computer (the office file server, the accountant's PC, a
-- restored backup) could therefore never decrypt its own AI keys.
--
-- file_secrets holds random secrets that belong to the company FILE (one row per purpose):
--   'vault'  the key-encryption secret for stored provider keys (lib/ai/keyVault.ts, "v2:" blobs)
-- It is created on first use, travels with every copy of the file, and is never used to sign
-- sessions (that stays the per-computer .auth-secret). Keys written before this change ("v1:")
-- are re-encrypted with it the first time the file is opened on a computer that can still read
-- them (lib/db/index.ts → migrateLegacySecrets).
CREATE TABLE IF NOT EXISTS "file_secrets" (
  "name" varchar(64) PRIMARY KEY NOT NULL,
  "secret" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
