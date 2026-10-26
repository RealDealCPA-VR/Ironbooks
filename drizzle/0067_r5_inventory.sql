-- Review round 5 (inventory): voiding or editing a FIFO sale puts its units back into the cost
-- layers they came from (lib/services/fifo.ts restoreConsumedStock). The layers a sale drew are
-- found through the audit row consumeStock writes for the item (entity_type 'item', entity_id the
-- item, new_values.entryId the COGS entry), so audit_logs needs an index on the record it is
-- about: without one every reversed FIFO line scanned the company's whole audit trail. The index
-- also serves the record history ("who changed this item / invoice").
CREATE INDEX IF NOT EXISTS "audit_logs_company_entity_idx" ON "audit_logs" ("company_id", "entity_type", "entity_id");
