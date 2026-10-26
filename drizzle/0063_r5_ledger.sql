-- 0063 — team ledger, review round 5.
--
-- The guard that refuses to void a journal entry whose customer / vendor lines have payments or
-- credits applied (0037: bk_journal_item_applications_void_guard) becomes a maintained ledger
-- guard. Under its bk_ name it was invisible to the guard machinery (lib/db/ledgerGuards.ts only
-- maintains bka_* guards): it was left in origin mode (raw SQL with session_replication_role =
-- replica skipped it), a file where it had been dropped or disabled offline was neither reported
-- by the ledger health check / Verify Data nor repaired when the file was opened. Same rule and
-- message (BK002 -> CONFLICT); only the name, the enable mode and the maintenance change.
DROP TRIGGER IF EXISTS "bk_journal_item_applications_void_guard" ON "journal_entries";
--> statement-breakpoint
DROP FUNCTION IF EXISTS bk_guard_journal_item_applications();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bka_guard_journal_item_applications() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_n integer;
BEGIN
  IF NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void' THEN
    SELECT COUNT(*) INTO v_n FROM journal_item_applications a WHERE a.journal_entry_id = NEW.id;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'Journal entry #% has amounts applied to payments, invoices or bills. Remove those applications in Receive Payments or Pay Bills first, then void or edit the entry.', NEW.entry_number
        USING ERRCODE = 'BK002';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_jia_void_guard ON journal_entries;
--> statement-breakpoint
CREATE TRIGGER bka_jia_void_guard
  BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION bka_guard_journal_item_applications();
--> statement-breakpoint
ALTER TABLE journal_entries ENABLE ALWAYS TRIGGER bka_jia_void_guard;
