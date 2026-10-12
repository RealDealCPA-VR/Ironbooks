-- Team UX P1 round.
--
-- 1. ONE To Do list (QB Company > To Do List). Until now there were two stores: "todo_items"
--    (Lists > To Do, /api/todos) and "todos" (Calendar, Reminders, Lead Center,
--    /api/calendar/todos). "todos" becomes the only store: it gains a status
--    (open | done | inactive), an assigned user and a "remind me on" date, and every
--    todo_items row is copied in under its SAME id (so old links and ids keep working).
--    The copy is idempotent (ON CONFLICT DO NOTHING) and nothing is deleted: todo_items is
--    left in place, unused, so no data can be lost.
-- 2. Simple vs. Advanced menus (My Preferences > navMode). New users start in Simple mode;
--    people who already use the app keep the full menu they know (navMode 'advanced').
ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "status" varchar(10) DEFAULT 'open' NOT NULL;
--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "assigned_user_id" uuid REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "remind_on" varchar(10);
--> statement-breakpoint
UPDATE "todos" SET "status" = 'done' WHERE "done" = true AND "status" = 'open';
--> statement-breakpoint
INSERT INTO "todos" (
	"id", "company_id", "user_id", "title", "notes", "kind", "priority", "due_date", "due_time",
	"done", "done_at", "status", "entity_type", "entity_id", "assigned_user_id", "created_at", "updated_at"
)
SELECT
	ti."id", ti."company_id", ti."created_by", ti."title", ti."details", ti."type", ti."priority",
	to_char(ti."due_date", 'YYYY-MM-DD'),
	CASE WHEN ti."due_date" IS NOT NULL AND to_char(ti."due_date", 'HH24:MI') <> '00:00'
		THEN to_char(ti."due_date", 'HH24:MI') END,
	ti."status" = 'done', ti."completed_at",
	CASE WHEN ti."status" IN ('open', 'done', 'inactive') THEN ti."status" ELSE 'open' END,
	ti."entity_type", ti."entity_id", ti."assigned_user_id", ti."created_at", ti."updated_at"
FROM "todo_items" ti
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todos_company_status_idx" ON "todos" ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todos_entity_idx" ON "todos" ("company_id", "entity_type", "entity_id");
--> statement-breakpoint
INSERT INTO "user_preferences" ("company_id", "user_id", "prefs")
SELECT uc."company_id", uc."user_id", '{"navMode":"advanced"}'::jsonb
FROM "user_companies" uc
ON CONFLICT ("company_id", "user_id") DO UPDATE
	SET "prefs" = '{"navMode":"advanced"}'::jsonb || "user_preferences"."prefs"
	WHERE "user_preferences"."prefs"->>'navMode' IS NULL;
