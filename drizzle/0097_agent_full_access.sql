-- Agent full access (Phase 0, storage): asking instead of refusing (AGENT_ACCESS.md).
--
-- agents.preset: what an agent may do on its own is now a policy preset (read_only |
-- ask_every_change | trusted_bookkeeper | full_with_asks), adjusted per class and area in
-- agent_policies. "mode" stays, because older code still reads it. Existing agents keep behaving
-- the same: Read only -> read_only, Propose -> ask_every_change, Post -> trusted_bookkeeper (which
-- already asks before deleting, changing many records at once or sending anything outside). An
-- unknown mode was read as Read only, so it becomes read_only. A new agent asks for every change
-- unless an Admin picks another preset. Its limits sit next to it: the most records one request
-- may change, the amount above which two people approve, how many days a request waits, the
-- folders it may use, an email notice when it asks while nobody is signed in, and a pause.
--
-- agent_policies: an Allow / Ask / Never that differs from the preset, for a risk class
-- everywhere (area null) or within one area. At most one row per agent, class and area (a null
-- area counts as one value).
--
-- agent_permission_requests: what an agent asked a person to approve, kept whatever the answer.
-- The proposals agents made before this version (ai_proposals of kind agent_action) are copied in
-- once, named by proposal_id, and the proposals themselves are left as they are.
--
-- agent_grants: standing permission a person gave while approving ("this and similar ones for the
-- next hour"), until it expires or is revoked.
--
-- audit_logs.approved_by / agent_request_id / agent_grant_id: the person who approved an agent's
-- change, and the request or grant it ran under.
--
-- No foreign keys to agents, people, requests or grants: a record must outlive what it names.
-- None of these travel with a copy of the company (like agents and agent_requests).
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "preset" varchar(24);
--> statement-breakpoint
UPDATE "agents" SET "preset" = CASE "mode"
		WHEN 'post' THEN 'trusted_bookkeeper'
		WHEN 'propose' THEN 'ask_every_change'
		ELSE 'read_only'
	END
	WHERE "preset" IS NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "preset" SET DEFAULT 'ask_every_change';
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "preset" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "bulk_cap" integer;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "two_person_over" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "request_expiry_days" integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "folders" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "notify_email" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "paused_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"agent_id" uuid NOT NULL,
	"class" varchar(24) NOT NULL,
	"area" varchar(40),
	"setting" varchar(8) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_policies_key_idx" ON "agent_policies" ("agent_id", "class", "area") NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_permission_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"agent_id" uuid NOT NULL,
	"request_key" varchar(120) NOT NULL,
	"operation" varchar(160) NOT NULL,
	"class" varchar(24) NOT NULL,
	"input" jsonb,
	"reason" text,
	"summary" text NOT NULL,
	"preview" jsonb,
	"needs" jsonb,
	"staleness_key" varchar(128),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"second_approver" uuid,
	"decided_at" timestamp,
	"note" text,
	"result" jsonb,
	"error" text,
	"grant_id" uuid,
	"proposal_id" uuid,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_permission_requests_key_idx" ON "agent_permission_requests" ("agent_id", "request_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_permission_requests_company_status_idx" ON "agent_permission_requests" ("company_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_permission_requests_agent_idx" ON "agent_permission_requests" ("agent_id", "created_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_permission_requests_proposal_idx" ON "agent_permission_requests" ("proposal_id") WHERE "proposal_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"agent_id" uuid NOT NULL,
	"operation" varchar(160) NOT NULL,
	"class" varchar(24) NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"given_by" uuid NOT NULL,
	"request_id" uuid,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"revoked_by" uuid,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_grants_agent_idx" ON "agent_grants" ("agent_id", "operation");
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "approved_by" uuid;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "agent_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "agent_grant_id" uuid;
--> statement-breakpoint
-- The proposals agents made before this version, copied in once (a proposal already copied is
-- skipped, so running this again changes nothing). Each keeps the request id the agent sent with
-- it when that is on record, its agent (from the proposal, or from what the proposal says), and
-- what a person decided: pending stays pending, approved was entered (executed), rejected is
-- denied, anything else is cancelled. One still waiting gets a full wait from the upgrade, so
-- nothing expires the moment the app is updated.
INSERT INTO "agent_permission_requests" (
	"company_id", "agent_id", "request_key", "operation", "class", "input", "summary", "status",
	"decided_by", "decided_at", "result", "error", "expires_at", "created_at", "proposal_id"
)
SELECT
	p."company_id",
	p."agent",
	LEFT(COALESCE(
		(SELECT r."request_key" FROM "agent_requests" r
		  WHERE r."agent_id" = p."agent" AND r."result" ->> 'proposalId' = p."id"::text
		  ORDER BY r."created_at" LIMIT 1),
		'proposal:' || p."id"::text
	), 120),
	LEFT('action:' || COALESCE(NULLIF(p."payload" ->> 'action', ''), 'unknown'), 160),
	'change',
	p."payload" -> 'input',
	p."summary",
	CASE lower(p."status")
		WHEN 'pending' THEN 'pending'
		WHEN 'approved' THEN 'executed'
		WHEN 'rejected' THEN 'denied'
		WHEN 'declined' THEN 'denied'
		ELSE 'cancelled'
	END,
	p."decided_by",
	p."decided_at",
	CASE WHEN p."result_ref" IS NOT NULL THEN jsonb_build_object('resultRef', p."result_ref") END,
	p."error",
	CASE WHEN lower(p."status") = 'pending'
		THEN LOCALTIMESTAMP + make_interval(days => COALESCE(a."request_expiry_days", 7))
		ELSE p."created_at" + make_interval(days => COALESCE(a."request_expiry_days", 7))
	END,
	p."created_at",
	p."id"
FROM (
	SELECT q."id", q."company_id", q."summary", q."payload", q."status", q."result_ref", q."error",
	       q."decided_by", q."decided_at", q."created_at",
	       COALESCE(q."agent_id", CASE
	         WHEN q."payload" -> 'agent' ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
	         THEN (q."payload" -> 'agent' ->> 'id')::uuid
	       END) AS "agent"
	  FROM "ai_proposals" q
	 WHERE q."kind" = 'agent_action'
) p
LEFT JOIN "agents" a ON a."id" = p."agent"
WHERE p."agent" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "agent_permission_requests" x WHERE x."proposal_id" = p."id")
ON CONFLICT DO NOTHING;
