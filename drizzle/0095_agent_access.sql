-- Agent access (phase 1): an Admin at the computer that holds the company file can let an AI
-- agent read the books through the app's own local server (AGENT_ACCESS.md).
--
-- An agent is its own record, not a user: it has no password, cannot sign in, takes no seat and
-- is not counted anywhere people are counted. It carries the role keys an Admin gave it (the same
-- roles people have, never Admin) and a mode (read_only | propose | post). Only a digest of its
-- access token is stored; the token itself is shown once, when the agent is made.
--
-- audit_logs.agent_id names the agent behind a change, next to user_id (null for an agent). No
-- foreign key, like user_sessions: an audit row must outlive the agent it names.
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"name" varchar(100) NOT NULL,
	"role_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" varchar(16) DEFAULT 'read_only' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_prefix" varchar(24) NOT NULL,
	"key_id" varchar(32),
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_token_hash_idx" ON "agents" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_company_idx" ON "agents" ("company_id");
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
