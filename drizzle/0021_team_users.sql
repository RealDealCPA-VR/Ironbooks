ALTER TABLE "user_companies" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(100) NOT NULL,
	"description" text,
	"permissions" jsonb NOT NULL,
	"flags" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_roles_company_name_idx" ON "company_roles" ("company_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_role_assignments" (
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"role_key" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	PRIMARY KEY ("company_id", "user_id", "role_key")
);
--> statement-breakpoint
-- The company creator is the Admin (unless roles were already configured for them).
INSERT INTO "user_role_assignments" ("company_id", "user_id", "role_key")
SELECT c."id", c."owner_id", 'admin' FROM "companies" c
WHERE NOT EXISTS (
	SELECT 1 FROM "user_role_assignments" a
	WHERE a."company_id" = c."id" AND a."user_id" = c."owner_id"
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Migrate legacy memberships to the equivalent built-in roles:
-- owner/admin -> Admin, accountant -> Accountant, viewer -> View-Only.
-- Only members with no assignments yet (safe to re-run; never adds to configured roles).
INSERT INTO "user_role_assignments" ("company_id", "user_id", "role_key")
SELECT DISTINCT uc."company_id", uc."user_id",
	CASE uc."role"
		WHEN 'owner' THEN 'admin'
		WHEN 'admin' THEN 'admin'
		WHEN 'accountant' THEN 'accountant'
		ELSE 'view_only'
	END
FROM "user_companies" uc
WHERE NOT EXISTS (
	SELECT 1 FROM "user_role_assignments" a
	WHERE a."company_id" = uc."company_id" AND a."user_id" = uc."user_id"
)
ON CONFLICT DO NOTHING;
