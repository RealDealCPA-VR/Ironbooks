CREATE TABLE IF NOT EXISTS "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid,
	"remote_addr" varchar(100),
	"user_agent" text,
	"via_host" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"end_reason" varchar(50)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_active_idx" ON "user_sessions" ("ended_at", "last_seen_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "single_user_mode" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enabled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "single_user_mode" ALTER COLUMN "id" TYPE varchar(40);
--> statement-breakpoint
DELETE FROM "single_user_mode" WHERE "id" = 'file';
