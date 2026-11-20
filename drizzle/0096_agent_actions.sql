-- Agent access (phases 2-4): agents that enter transactions, and agents that may work while
-- nobody is signed in (AGENT_ACCESS.md).
--
-- agent_requests: one row per change an agent asked for with a request id. Asking again with the
-- same id returns the first answer instead of entering the same thing twice. Never travels with a
-- copy of the company (like the agents themselves).
--
-- agent_id on journal_entries / reconciliations / ai_proposals names the agent behind an entry,
-- next to the person answerable for it in created_by (the Admin who let the agent in, or the
-- person who approved its proposal). No foreign keys: a record must outlive the agent it names.
--
-- agents.unattended: this agent may work while Ironbooks has the company file open but nobody is
-- signed in. Off unless an Admin turns it on for that agent.
CREATE TABLE IF NOT EXISTS "agent_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"agent_id" uuid NOT NULL,
	"request_key" varchar(120) NOT NULL,
	"action" varchar(60) NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_requests_key_idx" ON "agent_requests" ("agent_id", "request_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_requests_company_idx" ON "agent_requests" ("company_id");
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "unattended" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "reconciliations" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
