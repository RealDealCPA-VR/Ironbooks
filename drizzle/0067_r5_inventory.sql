-- Review round 5 (inventory): voiding or editing a FIFO sale puts its units back into the cost
-- layers they came from (lib/services/fifo.ts restoreConsumedStock). The layers a sale drew are
-- found through the audit row consumeStock writes for the item (entity_type 'item', entity_id the
-- item, new_values.entryId the COGS entry), so audit_logs needs an index on the record it is
-- about: without one every reversed FIFO line scanned the company's whole audit trail. The index
-- also serves the record history ("who changed this item / invoice").
CREATE INDEX IF NOT EXISTS "audit_logs_company_entity_idx" ON "audit_logs" ("company_id", "entity_type", "entity_id");
--> statement-breakpoint
-- Record locking for items (QB "This record was changed by another user"): an item's version
-- was its updated_at, which every sale, receipt, adjustment and build also moves (they write the
-- quantity on hand / average cost) — so saving an Edit Item form opened before anyone sold the
-- item was refused as a conflict. Like accounts (0046 edited_at vs the cached balance), items get
-- an edited_at version that moves only when something other than the stock figures changes.
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "edited_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bka_touch_item_edited_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at
     AND (to_jsonb(NEW) - 'quantity_on_hand' - 'average_cost' - 'value_remainder' - 'value_remainder_avg' - 'updated_at' - 'edited_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'quantity_on_hand' - 'average_cost' - 'value_remainder' - 'value_remainder_avg' - 'updated_at' - 'edited_at') THEN
    NEW.edited_at := GREATEST(
      date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
      OLD.edited_at + interval '1 millisecond'
    );
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_version_items ON "items";
--> statement-breakpoint
CREATE TRIGGER bka_version_items BEFORE UPDATE ON "items" FOR EACH ROW EXECUTE FUNCTION bka_touch_item_edited_at();
