CREATE TABLE IF NOT EXISTS "transaction_log_anchor" (
	"id" varchar(16) PRIMARY KEY DEFAULT 'log' NOT NULL,
	"genesis_hash" varchar(64) NOT NULL,
	"genesis_ts" varchar(40) NOT NULL,
	"head_seq" integer NOT NULL,
	"head_hash" varchar(64) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
