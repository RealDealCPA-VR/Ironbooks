-- Receipt capture (local OCR + phone upload).
--
-- receipt_scans: one row per receipt photo / PDF dropped into the Doc Center inbox. The file
--   itself is an `attachments` row (unfiled until the receipt is saved as a transaction, then
--   filed to it). The row holds what was read from it (vendor, date, total, tax, card last 4),
--   how it was read (pdf-text / ocr / vision / none), and the transaction it became.
--   `version` is the record-locking counter: saving or re-reading a receipt must name the
--   version the person was looking at, so two people can't turn one receipt into two expenses.
-- receipt_upload_tokens: short-lived, single-company links for uploading receipts from a phone
--   over the tailnet. Only a SHA-256 hash of the token is stored; each token expires, can be
--   revoked and allows a limited number of uploads.
CREATE TABLE IF NOT EXISTS "receipt_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"attachment_id" uuid NOT NULL REFERENCES "attachments"("id") ON DELETE CASCADE,
	"source" varchar(20) DEFAULT 'desktop' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"method" varchar(20),
	"message" text,
	"vendor_name" varchar(255),
	"receipt_date" varchar(10),
	"total" numeric(15, 2),
	"subtotal" numeric(15, 2),
	"tax" numeric(15, 2),
	"card_last4" varchar(4),
	"card_brand" varchar(40),
	"reference" varchar(60),
	"confidence" jsonb,
	"raw_text" text,
	"txn_type" varchar(20),
	"txn_id" uuid,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"processing_started_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "receipt_scans_attachment_idx" ON "receipt_scans" ("attachment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receipt_scans_company_status_idx" ON "receipt_scans" ("company_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receipt_upload_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id"),
	"token_hash" varchar(64) NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp NOT NULL,
	"max_uploads" integer DEFAULT 20 NOT NULL,
	"upload_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "receipt_upload_tokens_hash_idx" ON "receipt_upload_tokens" ("token_hash");
