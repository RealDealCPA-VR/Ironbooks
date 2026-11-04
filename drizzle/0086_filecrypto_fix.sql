-- filecrypto fix (round 2): the key check of the file key used BEFORE the last key change.
-- A key change is written to the database first and to the company file by the next save; until
-- that save the company file is still sealed with the previous key. Signing in on the working copy
-- already on this computer accepts a company file sealed with exactly that previous key, and
-- refuses any other key check (an edited plain listing) as tampered.
ALTER TABLE "file_protection" ADD COLUMN IF NOT EXISTS "previous_key_check" varchar(64);
