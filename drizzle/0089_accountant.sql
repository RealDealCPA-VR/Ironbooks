-- Accountant fix round (I6 Batch Delete/Void): deleting a posted General Journal entry.
--
-- The ledger never removes a posted entry (bka_je_guard), so a "deleted" entry is voided (its
-- amounts reversed by the balance triggers, exactly like a void) and stamped deleted_at. Deleted
-- entries drop out of the Journal list; the delete is in the audit trail and on the
-- Voided/Deleted Transactions report, and Batch Delete/Void can restore it (a new entry posted
-- from the audit snapshot). Null on every other entry.
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
