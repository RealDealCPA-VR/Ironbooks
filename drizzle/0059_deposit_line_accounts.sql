-- Repair deposit_lines.account_id (0037 backfill).
--
-- 0037 filled the account of each "extra" deposit line (no payment, not a sales-receipt /
-- invoice-payment / cash-back line) from the credit line on the deposit's posted entry with the
-- same amount and memo, LIMIT 1. Two extra lines with the same amount and memo (typically two
-- undescribed lines, both memo 'Additional deposit line') therefore BOTH got the first line's
-- account: a $100 Owner's Equity line and a $100 Other Income line both became Owner's Equity, and
-- the next re-post of that deposit (edit, Remove payment from deposit) moved the income to equity.
--
-- Re-derive the accounts one-to-one from the posted entry: within each (entry, amount, memo)
-- group, the extra lines and the matching credit lines are paired by rank. Both sides are ranked
-- by account (lines in a group are interchangeable — same amount and description), so a group
-- whose accounts already match the entry pairs every line with its own account and is left
-- untouched (only rows whose account actually changes are written). Groups where the number of
-- extra lines and matching credit lines differ are ambiguous and left as they are.
--
-- Home-currency deposits only. A foreign-currency deposit's lines are in the deposit currency while
-- its entry credits home amounts, and those are allocated from the converted total (largest
-- remainder), so neither the raw amount nor round2(amount x rate) pairs its lines reliably: a line
-- whose foreign amount equals another line's home amount would take that line's account. None
-- needs repair either: 0037 ran before foreign-currency deposits existed (0043 added
-- deposits.currency), and every later deposit stores its lines' accounts itself.
--
-- Idempotent: once a group matches its entry, re-running pairs it identically and writes nothing.
-- Only deposit_lines is written; the ledger is read, never changed.
WITH dl AS (
	SELECT
		l."id",
		d."posted_entry_id" AS "entry_id",
		CAST(l."amount" AS numeric) AS "amt",
		COALESCE(l."description", 'Additional deposit line') AS "memo_key",
		row_number() OVER w AS "rn",
		count(*) OVER (PARTITION BY d."posted_entry_id", CAST(l."amount" AS numeric), COALESCE(l."description", 'Additional deposit line')) AS "n"
	FROM "deposit_lines" l
	JOIN "deposits" d ON d."id" = l."deposit_id"
	WHERE l."payment_id" IS NULL
		AND d."posted_entry_id" IS NOT NULL
		AND d."currency" IS NULL
		AND COALESCE(l."description", '') NOT LIKE 'salesReceipt:%'
		AND COALESCE(l."description", '') NOT LIKE 'invoicePayment:%'
		AND COALESCE(l."description", '') NOT LIKE 'cashback:%'
	WINDOW w AS (
		PARTITION BY d."posted_entry_id", CAST(l."amount" AS numeric), COALESCE(l."description", 'Additional deposit line')
		ORDER BY l."account_id" NULLS LAST, l."id"
	)
),
gl AS (
	SELECT
		j."journal_entry_id" AS "entry_id",
		CAST(j."credit" AS numeric) AS "amt",
		COALESCE(j."memo", '') AS "memo_key",
		j."account_id",
		row_number() OVER w AS "rn",
		count(*) OVER (PARTITION BY j."journal_entry_id", CAST(j."credit" AS numeric), COALESCE(j."memo", '')) AS "n"
	FROM "journal_entry_lines" j
	WHERE j."credit" IS NOT NULL
		AND j."journal_entry_id" IN (SELECT "posted_entry_id" FROM "deposits" WHERE "posted_entry_id" IS NOT NULL)
	WINDOW w AS (
		PARTITION BY j."journal_entry_id", CAST(j."credit" AS numeric), COALESCE(j."memo", '')
		ORDER BY j."account_id", j."id"
	)
),
pair AS (
	SELECT dl."id", gl."account_id"
	FROM dl
	JOIN gl
		ON gl."entry_id" = dl."entry_id"
		AND gl."amt" = dl."amt"
		AND gl."memo_key" = dl."memo_key"
		AND gl."rn" = dl."rn"
		AND gl."n" = dl."n"
)
UPDATE "deposit_lines" t
SET "account_id" = pair."account_id"
FROM pair
WHERE t."id" = pair."id"
	AND t."account_id" IS DISTINCT FROM pair."account_id";
