-- ===========================================================================
-- 0017 — Ledger invariants enforced by the DATABASE (team ledger).
--
-- Unbalanced books must be impossible, whatever code path writes the rows
-- (services, raw SQL, imports, condense, restore, merge, future bugs):
--
--  (a) DEFERRED BALANCE CHECK. A DEFERRABLE INITIALLY DEFERRED constraint
--      trigger on journal_entry_lines + journal_entries verifies at COMMIT that
--      every touched 'posted' entry has >= 2 lines, SUM(debit) = SUM(credit),
--      every line has exactly one positive side with <= 2 decimals, and every
--      line's account belongs to the entry's company. Drafts are not checked
--      (they never affect balances); void entries are history (immutable).
--
--  (b) accounts.balance IS DERIVED, NEVER WRITTEN. It is maintained purely by
--      statement-level triggers from journal lines + entry status transitions
--      (posting.ts no longer applies deltas itself, so nothing is applied twice).
--      A direct write of accounts.balance that is not trigger-driven is refused
--      unless the new value equals the ledger-derived balance (so the Rebuild
--      utility can still repair legacy drift); new accounts must start at 0;
--      changing an account's type re-derives its balance under the new sign.
--
--  (c) IMMUTABILITY. Lines of posted/void entries cannot be inserted, deleted
--      or have their entry/account/debit/credit changed, posted/void headers
--      cannot be deleted, re-dated or moved to another company, void is final
--      and posted cannot go back to draft — except (1) within the transaction
--      that created the entry, or (2) when a whitelisted service has executed
--      `SELECT set_config('bka.allow_ledger_rewrite', 'on', true)` (transaction-
--      local; see allowLedgerRewrite() in lib/services/posting.ts): condense,
--      account merge and company restore. Even then (a) still runs at COMMIT.
--
-- Error SQLSTATEs (translated to ServiceError by lib/services/_base.ts):
--   BK001 unbalanced / malformed posted entry     → UNBALANCED
--   BK002 immutable posted ledger row             → CONFLICT
--   BK003 accounts.balance tampering              → CONFLICT
-- ===========================================================================

CREATE INDEX IF NOT EXISTS "jel_journal_entry_id_idx" ON "journal_entry_lines" ("journal_entry_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jel_account_id_idx" ON "journal_entry_lines" ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "je_company_status_idx" ON "journal_entries" ("company_id", "status");
--> statement-breakpoint

-- ---- helpers --------------------------------------------------------------

CREATE OR REPLACE FUNCTION bka_ledger_rewrite_allowed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('bka.allow_ledger_rewrite', true), '') = 'on'
$$;
--> statement-breakpoint

-- Signed change to an account's NATURAL balance for one line (mirrors balanceDelta()).
CREATE OR REPLACE FUNCTION bka_natural_amount(p_type account_type, p_debit numeric, p_credit numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_type IN ('asset', 'expense')
              THEN coalesce(p_debit, 0) - coalesce(p_credit, 0)
              ELSE coalesce(p_credit, 0) - coalesce(p_debit, 0) END
$$;
--> statement-breakpoint

-- Ledger-derived natural balance of one account: posted lines only.
CREATE OR REPLACE FUNCTION bka_account_ledger_balance(p_account uuid, p_type account_type)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(bka_natural_amount(p_type, l.debit, l.credit)), 0)::numeric(15, 2)
  FROM journal_entry_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id
  WHERE l.account_id = p_account AND e.status = 'posted'
$$;
--> statement-breakpoint

-- True when the entry row was created by the CURRENT transaction (created_at defaults to
-- now(), which is the transaction start time and is identical for every statement and
-- savepoint in it). Lets postJournalEntry insert lines into the entry it just created.
CREATE OR REPLACE FUNCTION bka_entry_is_new(p_created timestamp) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_created = now()::timestamp
$$;
--> statement-breakpoint

-- ---- (a) deferred balance check ---------------------------------------------

CREATE OR REPLACE FUNCTION bka_assert_entry_balanced(p_entry uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_company uuid;
  v_number integer;
  v_lines integer;
  v_debit numeric;
  v_credit numeric;
  v_bad integer;
  v_foreign integer;
BEGIN
  SELECT status::text, company_id, entry_number INTO v_status, v_company, v_number
  FROM journal_entries WHERE id = p_entry;
  IF NOT FOUND THEN
    RETURN; -- entry deleted later in the same transaction
  END IF;

  SELECT count(*),
         coalesce(sum(l.debit), 0),
         coalesce(sum(l.credit), 0),
         count(*) FILTER (WHERE NOT (
             ((coalesce(l.debit, 0) > 0 AND coalesce(l.credit, 0) = 0)
               OR (coalesce(l.credit, 0) > 0 AND coalesce(l.debit, 0) = 0))
             AND coalesce(l.debit, 0) = round(coalesce(l.debit, 0), 2)
             AND coalesce(l.credit, 0) = round(coalesce(l.credit, 0), 2))),
         count(*) FILTER (WHERE a.company_id IS DISTINCT FROM v_company)
  INTO v_lines, v_debit, v_credit, v_bad, v_foreign
  FROM journal_entry_lines l
  LEFT JOIN accounts a ON a.id = l.account_id
  WHERE l.journal_entry_id = p_entry;

  IF v_foreign > 0 THEN
    RAISE EXCEPTION 'LEDGER: journal entry #% references an account of another company', v_number
      USING ERRCODE = 'BK001';
  END IF;
  IF v_status <> 'posted' THEN
    RETURN; -- drafts never touch balances; void entries are frozen history
  END IF;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'LEDGER: posted journal entry #% has % line(s); at least two are required', v_number, v_lines
      USING ERRCODE = 'BK001';
  END IF;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'LEDGER: posted journal entry #% has % malformed line(s) (each line needs exactly one positive debit or credit with at most 2 decimals)', v_number, v_bad
      USING ERRCODE = 'BK001';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'LEDGER: posted journal entry #% is out of balance: debits % <> credits %', v_number, v_debit, v_credit
      USING ERRCODE = 'BK001';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION bka_jel_balance_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM bka_assert_entry_balanced(NEW.journal_entry_id);
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id) THEN
    PERFORM bka_assert_entry_balanced(OLD.journal_entry_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION bka_je_balance_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bka_assert_entry_balanced(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS bka_jel_balanced ON journal_entry_lines;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER bka_jel_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bka_jel_balance_check();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_je_balanced ON journal_entries;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER bka_je_balanced
  AFTER INSERT OR UPDATE OF status, company_id ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bka_je_balance_check();
--> statement-breakpoint

-- ---- (c) immutability guards ----------------------------------------------

CREATE OR REPLACE FUNCTION bka_jel_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  IF bka_ledger_rewrite_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Removing / changing an existing line.
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
      (NEW.journal_entry_id, NEW.account_id, NEW.debit, NEW.credit)
        IS DISTINCT FROM (OLD.journal_entry_id, OLD.account_id, OLD.debit, OLD.credit)) THEN
    SELECT status::text AS status, created_at, entry_number INTO r
    FROM journal_entries WHERE id = OLD.journal_entry_id;
    IF FOUND AND r.status IN ('posted', 'void') AND NOT bka_entry_is_new(r.created_at) THEN
      RAISE EXCEPTION 'LEDGER: lines of % journal entry #% cannot be % — void it or post a correcting entry instead',
        r.status, r.entry_number, CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE 'changed' END
        USING ERRCODE = 'BK002';
    END IF;
  END IF;

  -- Adding a line to an entry (insert, or moving a line into another entry).
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    SELECT status::text AS status, created_at, entry_number INTO r
    FROM journal_entries WHERE id = NEW.journal_entry_id;
    IF FOUND AND r.status IN ('posted', 'void') AND NOT bka_entry_is_new(r.created_at) THEN
      RAISE EXCEPTION 'LEDGER: lines cannot be added to % journal entry #%', r.status, r.entry_number
        USING ERRCODE = 'BK002';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION bka_je_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF bka_ledger_rewrite_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted', 'void') AND NOT bka_entry_is_new(OLD.created_at) THEN
      RAISE EXCEPTION 'LEDGER: % journal entry #% cannot be deleted — void it instead', OLD.status, OLD.entry_number
        USING ERRCODE = 'BK002';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'LEDGER: journal entry #% cannot be moved to another id or company', OLD.entry_number
      USING ERRCODE = 'BK002';
  END IF;
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN
    RAISE EXCEPTION 'LEDGER: journal entry #% is void; voiding is final', OLD.entry_number
      USING ERRCODE = 'BK002';
  END IF;
  IF OLD.status = 'posted' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'LEDGER: posted journal entry #% cannot return to draft — void it instead', OLD.entry_number
      USING ERRCODE = 'BK002';
  END IF;
  IF OLD.status IN ('posted', 'void') AND NEW.date IS DISTINCT FROM OLD.date
     AND NOT bka_entry_is_new(OLD.created_at) THEN
    RAISE EXCEPTION 'LEDGER: the date of % journal entry #% cannot be changed — void and re-post it instead',
      OLD.status, OLD.entry_number
      USING ERRCODE = 'BK002';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS bka_jel_guard ON journal_entry_lines;
--> statement-breakpoint
CREATE TRIGGER bka_jel_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION bka_jel_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_je_guard ON journal_entries;
--> statement-breakpoint
CREATE TRIGGER bka_je_guard
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION bka_je_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION bka_ledger_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT bka_ledger_rewrite_allowed() THEN
    RAISE EXCEPTION 'LEDGER: % cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'BK002';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_jel_no_truncate ON journal_entry_lines;
--> statement-breakpoint
CREATE TRIGGER bka_jel_no_truncate BEFORE TRUNCATE ON journal_entry_lines
  FOR EACH STATEMENT EXECUTE FUNCTION bka_ledger_no_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_je_no_truncate ON journal_entries;
--> statement-breakpoint
CREATE TRIGGER bka_je_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION bka_ledger_no_truncate();
--> statement-breakpoint

-- ---- (b) accounts.balance maintained by trigger -----------------------------

-- Lines inserted / updated / deleted: apply the natural-balance delta of every line
-- whose entry is posted, aggregated per account (one UPDATE per touched account).
CREATE OR REPLACE FUNCTION bka_jel_sync_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    WITH d AS (
      SELECT l.account_id, sum(bka_natural_amount(a.type, l.debit, l.credit)) AS delta
      FROM bka_new_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id AND e.status = 'posted'
      JOIN accounts a ON a.id = l.account_id
      GROUP BY l.account_id
    )
    UPDATE accounts a SET balance = a.balance + d.delta, updated_at = now()
    FROM d WHERE a.id = d.account_id AND d.delta <> 0;
  ELSIF TG_OP = 'DELETE' THEN
    WITH d AS (
      SELECT l.account_id, sum(bka_natural_amount(a.type, l.debit, l.credit)) AS delta
      FROM bka_old_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id AND e.status = 'posted'
      JOIN accounts a ON a.id = l.account_id
      GROUP BY l.account_id
    )
    UPDATE accounts a SET balance = a.balance - d.delta, updated_at = now()
    FROM d WHERE a.id = d.account_id AND d.delta <> 0;
  ELSE
    WITH moved AS (
      SELECT l.account_id, l.journal_entry_id, l.debit, l.credit, 1 AS sgn FROM bka_new_lines l
      UNION ALL
      SELECT l.account_id, l.journal_entry_id, l.debit, l.credit, -1 AS sgn FROM bka_old_lines l
    ), d AS (
      SELECT m.account_id, sum(m.sgn * bka_natural_amount(a.type, m.debit, m.credit)) AS delta
      FROM moved m
      JOIN journal_entries e ON e.id = m.journal_entry_id AND e.status = 'posted'
      JOIN accounts a ON a.id = m.account_id
      GROUP BY m.account_id
    )
    UPDATE accounts a SET balance = a.balance + d.delta, updated_at = now()
    FROM d WHERE a.id = d.account_id AND d.delta <> 0;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- Entry status transitions: entering 'posted' applies its lines, leaving it reverses them.
CREATE OR REPLACE FUNCTION bka_je_sync_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  WITH flips AS (
    SELECT n.id,
           CASE WHEN n.status = 'posted' AND o.status <> 'posted' THEN 1
                WHEN o.status = 'posted' AND n.status <> 'posted' THEN -1
                ELSE 0 END AS sgn
    FROM bka_new_entries n JOIN bka_old_entries o ON o.id = n.id
  ), d AS (
    SELECT l.account_id, sum(f.sgn * bka_natural_amount(a.type, l.debit, l.credit)) AS delta
    FROM flips f
    JOIN journal_entry_lines l ON l.journal_entry_id = f.id
    JOIN accounts a ON a.id = l.account_id
    WHERE f.sgn <> 0
    GROUP BY l.account_id
  )
  UPDATE accounts a SET balance = a.balance + d.delta, updated_at = now()
  FROM d WHERE a.id = d.account_id AND d.delta <> 0;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS bka_jel_sync_ins ON journal_entry_lines;
--> statement-breakpoint
CREATE TRIGGER bka_jel_sync_ins AFTER INSERT ON journal_entry_lines
  REFERENCING NEW TABLE AS bka_new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION bka_jel_sync_balances();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_jel_sync_upd ON journal_entry_lines;
--> statement-breakpoint
CREATE TRIGGER bka_jel_sync_upd AFTER UPDATE ON journal_entry_lines
  REFERENCING OLD TABLE AS bka_old_lines NEW TABLE AS bka_new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION bka_jel_sync_balances();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_jel_sync_del ON journal_entry_lines;
--> statement-breakpoint
CREATE TRIGGER bka_jel_sync_del AFTER DELETE ON journal_entry_lines
  REFERENCING OLD TABLE AS bka_old_lines
  FOR EACH STATEMENT EXECUTE FUNCTION bka_jel_sync_balances();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bka_je_sync_upd ON journal_entries;
--> statement-breakpoint
CREATE TRIGGER bka_je_sync_upd AFTER UPDATE ON journal_entries
  REFERENCING OLD TABLE AS bka_old_entries NEW TABLE AS bka_new_entries
  FOR EACH STATEMENT EXECUTE FUNCTION bka_je_sync_balances();
--> statement-breakpoint

-- Guard on accounts: balance is trigger-maintained. A direct (non-trigger) write may only
-- set it to the ledger-derived value (Rebuild Data); inserts start at zero; a type change
-- re-derives the balance under the new debit/credit sign.
CREATE OR REPLACE FUNCTION bka_accounts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_derived numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(NEW.balance, 0) <> 0 THEN
      RAISE EXCEPTION 'LEDGER: account % must be created with a zero balance — post an opening-balance journal entry instead', NEW.code
        USING ERRCODE = 'BK003';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.type IS DISTINCT FROM OLD.type THEN
    NEW.balance := bka_account_ledger_balance(NEW.id, NEW.type);
    RETURN NEW;
  END IF;

  IF NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2 THEN
    v_derived := bka_account_ledger_balance(NEW.id, NEW.type);
    IF NEW.balance IS DISTINCT FROM v_derived THEN
      RAISE EXCEPTION 'LEDGER: accounts.balance of account % is derived from the ledger (%) and cannot be set to %',
        NEW.code, v_derived, NEW.balance
        USING ERRCODE = 'BK003';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- One-time re-derivation of every cached balance BEFORE the guard is installed, so legacy
-- drift (from the old TypeScript-maintained cache) is healed and can never come back.
UPDATE accounts a
SET balance = bka_account_ledger_balance(a.id, a.type)
WHERE a.balance IS DISTINCT FROM bka_account_ledger_balance(a.id, a.type);
--> statement-breakpoint

DROP TRIGGER IF EXISTS bka_accounts_guard ON accounts;
--> statement-breakpoint
CREATE TRIGGER bka_accounts_guard
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION bka_accounts_guard();
