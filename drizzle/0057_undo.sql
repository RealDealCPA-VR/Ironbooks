-- Undo for everything (ux/undo).
--
-- undo_actions keeps one short-lived undo token per save / void / delete a user makes from a
-- form: the record it touched, the kind of action, the record as it was BEFORE the action (the
-- snapshot an update or void is undone back to), and the record's version right AFTER the
-- action (so an undo refuses cleanly when anyone changed the record since). Tokens are armed
-- for 30 seconds, belong to the user who made the change, and can be used once
-- (lib/services/undo.ts). Old tokens are pruned as new ones are made.
CREATE TABLE IF NOT EXISTS "undo_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"user_id" uuid REFERENCES "users"("id"),
	"entity_type" varchar(40) NOT NULL,
	"entity_id" varchar(64),
	"kind" varchar(10) NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"label" text,
	"snapshot" jsonb,
	"after_version" timestamp,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"armed_at" timestamp,
	"expires_at" timestamp,
	"undone_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "undo_actions_company_user_idx" ON "undo_actions" ("company_id", "user_id", "created_at");
