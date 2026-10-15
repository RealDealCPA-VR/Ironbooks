-- gapsb: Multiple Currencies preference (A2) + password policy (K).
--
-- users gains:
--   password_changed_at   when the password was last set (expiry is counted from here). Existing
--                         users start from their last account update, so an expiry policy turned
--                         on later counts from a known date instead of locking everyone out.
--   must_change_password  true = the next sign-in must choose a new password (expired, or an
--                         administrator asked for it when setting the password).
-- password_history keeps earlier password hashes (bcrypt, never plaintext) so "don't reuse the
-- last N passwords" can be enforced.
-- companies.settings.multiCurrencyEnabled is made explicit for every existing company: ON when it
-- already has foreign-currency data (the same tables as lib/services/multiCurrency.ts
-- hasForeignCurrencyData, General Journal lines included) or foreign currencies in its list, OFF
-- otherwise. New
-- companies are created with it OFF (lib/services/company.ts NEW_COMPANY_SETTINGS).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "users" SET "password_changed_at" = COALESCE("updated_at", "created_at") WHERE "password_changed_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "password_hash" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_history_user_idx" ON "password_history" ("user_id", "created_at");
--> statement-breakpoint
UPDATE "companies" c
SET "settings" = COALESCE(c."settings", '{}'::jsonb) || jsonb_build_object(
  'multiCurrencyEnabled',
  EXISTS (SELECT 1 FROM "currencies" cu WHERE cu."company_id" = c."id" AND cu."is_base" = false)
  OR EXISTS (
    SELECT 1 FROM (
      SELECT "currency" FROM "accounts" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "vendors" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "invoices" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "payments_received" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "bills" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "bill_payments" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "expenses" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "transfers" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "vendor_credits" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "deposits" WHERE "company_id" = c."id"
      UNION ALL SELECT "currency" FROM "loans" WHERE "company_id" = c."id"
      UNION ALL
      SELECT l."currency" FROM "journal_entry_lines" l
      JOIN "journal_entries" e ON e."id" = l."journal_entry_id"
      WHERE e."company_id" = c."id"
    ) used
    WHERE used."currency" IS NOT NULL
      AND btrim(used."currency") <> ''
      AND upper(btrim(used."currency")) <> COALESCE(
        (SELECT upper(btrim(cb."code")) FROM "currencies" cb WHERE cb."company_id" = c."id" AND cb."is_base" = true LIMIT 1),
        upper(NULLIF(btrim(c."settings"->>'currency'), '')),
        'USD'
      )
  )
)
WHERE (c."settings"->'multiCurrencyEnabled') IS NULL;
