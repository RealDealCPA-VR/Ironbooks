-- prefsperms: preferences, QuickBooks Enterprise permissions, email set-up inside the app.
--
-- 1. Two-factor RECOVERY codes (Security (2FA)). A sole Admin who lost their authenticator app
--    could never sign in again. Turning two-factor sign-in on now hands out ten one-time codes;
--    only their SHA-256 hashes are kept here (with when each was used).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_recovery_codes" jsonb;
