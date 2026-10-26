-- Review round 5 (team banking).
--
-- Transfers now post with sourceRef 'transfer:<id>' (lib/services/transfers.ts). Entries of
-- transfers saved before that carried no source, so the Journal screen treated them as General
-- Journal entries (edit / void / reverse them apart from the transfer) and reports labelled them
-- "General Journal". Link those entries to their transfer. Only the header's source_ref changes
-- (the ledger guards allow it); amounts, dates and lines are untouched. Entries a transfer edit
-- voided are linked through the transfer's audit trail (postedEntryId before / after the edit).
UPDATE "journal_entries" je
SET "source_ref" = 'transfer:' || t."id"
FROM "transfers" t
WHERE je."id" = t."posted_entry_id"
  AND je."company_id" = t."company_id"
  AND je."source_ref" IS NULL;
--> statement-breakpoint
UPDATE "journal_entries" je
SET "source_ref" = 'transfer:' || a."entity_id"
FROM "audit_logs" a
WHERE a."entity_type" = 'transfer'
  AND a."company_id" = je."company_id"
  AND je."source_ref" IS NULL
  AND je."id"::text IN (a."old_values"->>'postedEntryId', a."new_values"->>'postedEntryId');
