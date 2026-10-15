/**
 * Period Copy (QuickBooks Desktop "Period Copy", PARITY I7).
 *
 * A portable company file (.bkp) of ONE company holding only the activity of a date range — for
 * an auditor, a lender or an accountant who should see that period and nothing after it:
 *
 *  1. A complete, verified snapshot of the file is restored into a temporary folder (the
 *     Portable Company File engine), so the open company file is never touched.
 *  2. Everything AFTER the end date is removed: journal entries, the documents behind them
 *     (invoices, bills, payments, checks, deposits, paychecks, ...), bank-feed rows,
 *     reconciliations, time and mileage. Applications that linked a removed document to a kept
 *     one are taken back out of the kept one (an invoice paid after the end date is open again
 *     in the copy, a payment applied to a later invoice has that amount unapplied again), so the
 *     aging and open balances read "as of the end date". Other companies in the file are removed.
 *  3. Everything BEFORE the start date is summarized with the Condense engine
 *     (lib/services/condense.ts): detail is replaced by monthly summary entries that carry the
 *     same balances (the opening balances of the period); entries still needed by open invoices,
 *     bills and General Journal items stay in detail, exactly as Condense keeps them.
 *  4. The copy is verified before it is handed out: its trial balance on the day before the
 *     start date and on the end date must equal the original file's, account by account, and
 *     every entry must balance (the database ledger guards check this at commit too). Otherwise
 *     nothing is produced.
 *
 * The copy's transaction log starts fresh (the original log describes activity outside the
 * range). The closing date of the copy is set to the end date, so nobody adds activity to the
 * audited period by mistake; its company preferences record the range (settings.periodCopy).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, resolveDataDir, type DB } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import Decimal from 'decimal.js';
import { Money } from '@/lib/money';
import { type ServiceContext, ServiceError, validation, writeAudit } from './_base';
import { allowLedgerRewriteRaw } from './posting';
import { condensePeriod } from './condense';
import { createPortableCompanyFile, restorePortableCompanyFile } from './portableFile';
import { trialBalance } from './reports';
import { TRANSACTION_LOG_FILE, resetTransactionLogCache } from './transactionLog';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PeriodCopyInput {
  /** First day of the period, 'YYYY-MM-DD'. */
  from: string;
  /** Last day of the period, 'YYYY-MM-DD'. */
  to: string;
  /** Data dir of the open company file (tests / multi-dir setups). */
  dataDir?: string;
}

export interface PeriodCopySummary {
  from: string;
  to: string;
  companyName: string;
  removedAfter: { journalEntries: number; documents: number };
  condensed: { entries: number; summaryEntries: number; keptOpenDocumentEntries: number } | null;
  otherCompaniesRemoved: number;
  verified: {
    /** Trial balance on the day before the start date (the opening balances). */
    openingTrialBalance: { totalDebit: string; totalCredit: string };
    /** Trial balance on the end date. */
    closingTrialBalance: { totalDebit: string; totalCredit: string };
    accountsCompared: number;
  };
}

export interface PeriodCopyResult {
  buffer: Buffer;
  filename: string;
  summary: PeriodCopySummary;
}

type Queryable = Pick<Transaction, 'query' | 'exec'>;

const endOfDay = (ymd: string) => new Date(`${ymd}T23:59:59.999Z`);
const dayBefore = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const dayAfter = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const qi = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function rawClient(db: DB): PGlite {
  const client = (db as unknown as { $client?: PGlite }).$client;
  if (!client) throw new ServiceError('INTERNAL', 'Period Copy: database client unavailable.');
  return client;
}

/** Dated activity tables and their date column (removed after the end date). */
const DATED_TABLES: Array<[string, string]> = [
  ['invoices', 'date'],
  ['payments_received', 'date'],
  ['sales_receipts', 'date'],
  ['credit_memos', 'date'],
  ['estimates', 'date'],
  ['sales_orders', 'date'],
  ['bills', 'date'],
  ['bill_payments', 'date'],
  ['vendor_credits', 'date'],
  ['purchase_orders', 'date'],
  ['item_receipts', 'date'],
  ['expenses', 'date'],
  ['deposits', 'date'],
  ['transfers', 'date'],
  ['paychecks', 'pay_date'],
  ['pay_runs', 'pay_date'],
  ['payment_checks', 'date'],
  ['bounced_checks', 'date'],
  ['bank_transactions', 'date'],
  ['depreciation_entries', 'date'],
  ['inventory_transfers', 'date'],
  ['inventory_movements', 'date'],
  ['inventory_layers', 'date'],
  ['landed_cost_allocations', 'date'],
  ['home_currency_adjustments', 'date'],
  ['loan_payments', 'date'],
  ['pending_builds', 'date'],
  ['payment_fx_reliefs', 'date'],
  ['time_entries', 'date'],
  ['mileage_logs', 'date'],
  ['credit_applications', 'date'],
  ['vendor_credit_applications', 'date'],
  ['journal_item_applications', 'date'],
];

interface TrimCounts {
  journalEntries: number;
  documents: number;
  otherCompanies: number;
}

async function columnsByTable(q: Queryable): Promise<Map<string, Set<string>>> {
  const res = await q.query<{ t: string; c: string }>(
    `SELECT c.relname AS t, a.attname AS c
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  const out = new Map<string, Set<string>>();
  for (const r of res.rows) {
    if (!out.has(r.t)) out.set(r.t, new Set());
    out.get(r.t)!.add(r.c);
  }
  return out;
}

/**
 * Remove rows whose single-column foreign key now points at a deleted row: NOT NULL references
 * are deleted (a line of a removed document), nullable ones are cleared (a kept document's link
 * to a removed entry). Repeats until nothing changes.
 */
async function sweepOrphans(q: Queryable): Promise<void> {
  const fks = await q.query<{ child: string; col: string; parent: string; pcol: string; notnull: boolean }>(
    `SELECT cl.relname AS child, att.attname AS col, pcl.relname AS parent, patt.attname AS pcol, att.attnotnull AS notnull
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_class pcl ON pcl.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       JOIN pg_attribute patt ON patt.attrelid = con.confrelid AND patt.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND n.nspname = 'public' AND array_length(con.conkey, 1) = 1`,
  );
  for (let pass = 0; pass < 50; pass++) {
    let changed = 0;
    for (const fk of fks.rows) {
      const orphan = `${qi(fk.col)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${qi(fk.parent)} p WHERE p.${qi(fk.pcol)} = c.${qi(fk.col)})`;
      if (fk.child === 'journal_entry_lines' && fk.col === 'journal_entry_id') continue; // handled explicitly
      const res = fk.notnull
        ? await q.query(`DELETE FROM ${qi(fk.child)} c WHERE ${orphan}`)
        : await q.query(`UPDATE ${qi(fk.child)} c SET ${qi(fk.col)} = NULL WHERE ${orphan}`);
      changed += res.affectedRows ?? 0;
    }
    if (!changed) return;
  }
}

/**
 * The cached on-hand quantities (items.quantity_on_hand) and the FIFO layers' remaining
 * quantities are running totals: without this they would show today's stock in a copy that ends
 * months ago. Runs inside trimCopy BEFORE the dated rows are deleted, because it reads them:
 *
 *  - On hand as of the end date = on hand now − Σ inventory movements dated after the end date
 *    (every quantity-changing document writes a signed movement, reversals included) − the
 *    quantity changes of physical counts dated after the end date (the one path that sets the
 *    total without a movement; it records old/new quantity in the audit trail).
 *    Per-site quantities need nothing more: a non-default site is the sum of its (kept)
 *    movements and the default site is the remainder of this total.
 *  - Average cost goes back to its value before the first later receipt / cost change.
 *  - FIFO layers kept in the copy get back what documents dated after the end date consumed
 *    from them: first exactly, from the consumption record (audit trail of fifo.consumeStock,
 *    tied to its COGS entry's date); then any remaining difference between the kept layers and
 *    the on-hand total is settled the FIFO way — added back to the oldest layer still holding
 *    stock (the one later sales were eating into), or, when the layers hold too much, taken
 *    from the oldest layers first.
 *
 * The ledger itself needs no help: the inventory asset balance comes from the kept entries.
 */
async function restoreInventoryAsOf(
  tx: Queryable,
  companyId: string,
  cutoff: string,
  has: (t: string, c: string) => boolean,
): Promise<void> {
  const P = [companyId, cutoff];
  const cutoffDate = new Date(`${cutoff.slice(0, 10)}T00:00:00.000Z`);
  const delta = new Map<string, Decimal>(); // itemId -> quantity change after the end date
  const add = (itemId: string, q: string | Decimal) => delta.set(itemId, (delta.get(itemId) ?? Money.zero()).plus(Money.of(q)));

  for (const r of (
    await tx.query<{ item_id: string; q: string }>(
      `SELECT item_id::text AS item_id, SUM(quantity)::text AS q FROM inventory_movements
        WHERE company_id = $1 AND date >= $2 GROUP BY item_id`,
      P,
    )
  ).rows) {
    add(r.item_id, r.q);
  }

  const audit = has('audit_logs', 'new_values');
  if (audit) {
    const counts = await tx.query<{ item_id: string; old_q: string | null; new_q: string | null; at: string | null }>(
      `SELECT entity_id::text AS item_id, old_values->>'quantityOnHand' AS old_q, new_values->>'quantityOnHand' AS new_q,
              new_values->>'physicalCountDate' AS at
         FROM audit_logs
        WHERE company_id = $1 AND entity_type = 'item' AND new_values ? 'physicalCountDate'`,
      [companyId],
    );
    for (const r of counts.rows) {
      if (!r.at || new Date(r.at).getTime() < cutoffDate.getTime() || r.new_q == null) continue;
      add(r.item_id, Money.of(r.new_q).minus(Money.of(r.old_q ?? '0')));
    }
  }

  for (const [itemId, change] of delta) {
    if (change.isZero()) continue;
    await tx.query(
      `UPDATE items SET quantity_on_hand = COALESCE(quantity_on_hand, 0) - $3::numeric WHERE id = $2 AND company_id = $1`,
      [companyId, itemId, change.toFixed(4)],
    );
  }

  // Average cost as of the end date: the value it had just before the first later event that
  // moved it — a receipt dated after the end date (a positive movement) or a dated cost change
  // (an audited averageCost change tied to an entry dated after it). Every such event writes its
  // audit row in the same transaction as its movement / entry, so they share created_at.
  if (audit && has('items', 'average_cost')) {
    const avg = await tx.query<{ item_id: string; avg: string | null }>(
      `WITH later AS (
         SELECT item_id, MIN(created_at) AS t FROM (
           SELECT item_id, created_at FROM inventory_movements
            WHERE company_id = $1 AND date >= $2 AND quantity > 0
           UNION ALL
           SELECT a.entity_id AS item_id, a.created_at FROM audit_logs a
             JOIN journal_entries je ON je.id::text = a.new_values->>'postedEntryId'
            WHERE a.company_id = $1 AND a.entity_type = 'item' AND a.old_values ? 'averageCost' AND je.date >= $2
         ) x GROUP BY item_id
       )
       SELECT DISTINCT ON (a.entity_id) a.entity_id::text AS item_id, a.old_values->>'averageCost' AS avg
         FROM audit_logs a JOIN later l ON l.item_id = a.entity_id
        WHERE a.company_id = $1 AND a.entity_type = 'item' AND a.old_values ? 'averageCost' AND a.created_at >= l.t
        ORDER BY a.entity_id, a.created_at, a.id`,
      P,
    );
    for (const r of avg.rows) {
      await tx.query('UPDATE items SET average_cost = $3::numeric WHERE id = $2 AND company_id = $1', [
        companyId,
        r.item_id,
        r.avg == null ? null : Money.of(r.avg).toFixed(4),
      ]);
    }
  }

  if (!has('inventory_layers', 'quantity_remaining')) return;

  // FIFO 1: exact give-back of what later documents consumed from kept layers.
  if (audit) {
    const consumed = await tx.query<{ layer_id: string; q: string }>(
      `SELECT l->>'layerId' AS layer_id, SUM((l->>'quantityTaken')::numeric)::text AS q
         FROM audit_logs a
         JOIN journal_entries je ON je.id::text = a.new_values->>'entryId'
         CROSS JOIN LATERAL jsonb_array_elements(a.new_values->'layers') l
        WHERE a.company_id = $1 AND a.entity_type = 'item' AND jsonb_typeof(a.new_values->'layers') = 'array'
          AND je.date >= $2
        GROUP BY l->>'layerId'`,
      P,
    );
    for (const r of consumed.rows) {
      await tx.query(
        `UPDATE inventory_layers SET quantity_remaining = quantity_remaining + $3::numeric
          WHERE company_id = $1 AND id::text = $4 AND date < $2`,
        [companyId, cutoff, r.q, r.layer_id],
      );
    }
  }

  // FIFO 2: the kept layers of every FIFO item must hold exactly its on-hand quantity.
  const layers = await tx.query<{ id: string; item_id: string; q: string; qoh: string | null }>(
    `SELECT l.id::text AS id, l.item_id::text AS item_id, l.quantity_remaining::text AS q, i.quantity_on_hand::text AS qoh
       FROM inventory_layers l JOIN items i ON i.id = l.item_id
      WHERE l.company_id = $1 AND l.date < $2
      ORDER BY l.item_id, l.date, l.created_at, l.id`,
    P,
  );
  const byItem = new Map<string, Array<{ id: string; q: Decimal }>>();
  const target = new Map<string, Decimal>();
  for (const r of layers.rows) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
    byItem.get(r.item_id)!.push({ id: r.id, q: Money.of(r.q) });
    target.set(r.item_id, Money.of(r.qoh ?? '0'));
  }
  for (const [itemId, list] of byItem) {
    const want = Decimal.max(target.get(itemId)!, 0);
    const held = list.reduce((s, l) => s.plus(l.q), Money.zero());
    if (held.eq(want)) continue;
    if (held.lessThan(want)) {
      // Later sales ate into the oldest layer still holding stock (or the newest, when all are empty).
      const boundary = list.find((l) => l.q.greaterThan(0)) ?? list[list.length - 1];
      boundary.q = boundary.q.plus(want.minus(held));
    } else {
      let excess = held.minus(want);
      for (const l of list) {
        if (excess.lessThanOrEqualTo(0)) break;
        const take = Decimal.min(l.q, excess);
        l.q = l.q.minus(take);
        excess = excess.minus(take);
      }
    }
    for (const l of list) {
      await tx.query('UPDATE inventory_layers SET quantity_remaining = $2::numeric WHERE id::text = $1', [l.id, l.q.toFixed(4)]);
    }
  }
}

/** Steps 1-2: other companies out, everything after the end date out (applications unwound). */
async function trimCopy(db: DB, companyId: string, to: string): Promise<TrimCounts> {
  const cutoff = `${dayAfter(to)} 00:00:00`;
  return rawClient(db).transaction(async (tx) => {
    await tx.exec('SET LOCAL session_replication_role = replica');
    await allowLedgerRewriteRaw(tx, 'condense');
    const cols = await columnsByTable(tx);
    const has = (t: string, c: string) => cols.get(t)?.has(c) ?? false;
    const counts: TrimCounts = { journalEntries: 0, documents: 0, otherCompanies: 0 };

    // ---- Accountant's Copy records ----
    // A Period Copy is a standalone file for an auditor: it must not inherit the original's
    // outstanding Accountant's Copy (its dividing-date lock, banner or file token). Cleared before
    // condensePeriod runs on the copy, which refuses while a copy is outstanding.
    if (cols.has('accountant_copies')) await tx.exec('DELETE FROM accountant_copies');

    // ---- Working state of features merged alongside Period Copy ----
    // None of it is part of the books, and some of it would show activity after the end date:
    // undo tokens carry snapshots of records, the receipt inbox holds receipts not yet entered
    // (their unfiled image attachments go with them; a receipt already entered stays attached
    // to its transaction, kept or removed with it), phone upload links are live credentials,
    // and "Needs attention" snoozes / the backup log describe the original file.
    if (cols.has('receipt_scans')) {
      await tx.query(
        `DELETE FROM attachments a USING receipt_scans r
          WHERE r.attachment_id = a.id AND r.status <> 'saved' AND a.entity_id IS NULL`,
      );
      await tx.exec('DELETE FROM receipt_scans');
    }
    for (const t of ['undo_actions', 'receipt_upload_tokens', 'attention_item_states', 'backup_log']) {
      if (cols.has(t)) await tx.exec(`DELETE FROM ${qi(t)}`);
    }
    // Month-end close reviews of months after the period.
    if (has('month_end_closes', 'period_end')) {
      await tx.query('DELETE FROM month_end_closes WHERE period_end > $1', [to]);
    }

    // ---- Other companies in the file ----
    const others = await tx.query<{ id: string }>('SELECT id::text AS id FROM companies WHERE id <> $1', [companyId]);
    if (others.rows.length) {
      counts.otherCompanies = others.rows.length;
      // Lines first, while their entries still exist (the balance triggers read the entry).
      await tx.query(
        'DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id <> $1)',
        [companyId],
      );
      for (const [t, c] of cols) {
        if (t === 'companies' || !c.has('company_id')) continue;
        await tx.query(`DELETE FROM ${qi(t)} WHERE company_id IS NOT NULL AND company_id <> $1`, [companyId]);
      }
      await tx.query('DELETE FROM companies WHERE id <> $1', [companyId]);
    }

    // ---- Unwind applications that link kept documents to removed ones ----
    const P = [companyId, cutoff];
    const touchedInvoices = new Set<string>();
    const touchedBills = new Set<string>();
    const collect = (set: Set<string>, rows: Array<{ id: string }>) => rows.forEach((r) => set.add(r.id));

    // Customer payments after the end date paid kept invoices.
    collect(
      touchedInvoices,
      (
        await tx.query<{ id: string }>(
          `UPDATE invoices i SET amount_paid = i.amount_paid - x.amt, balance_due = i.balance_due + x.amt
             FROM (SELECT pa.invoice_id, SUM(pa.amount_applied + pa.discount_amount) AS amt
                     FROM payment_applications pa
                     JOIN payments_received p ON p.id = pa.payment_id
                     JOIN invoices inv ON inv.id = pa.invoice_id
                    WHERE p.company_id = $1 AND p.date >= $2 AND inv.date < $2
                    GROUP BY pa.invoice_id) x
            WHERE i.id = x.invoice_id RETURNING i.id::text AS id`,
          P,
        )
      ).rows,
    );
    // Kept payments applied to invoices dated after the end date: that money is unapplied again.
    await tx.query(
      `UPDATE payments_received p SET unapplied = p.unapplied + x.amt
         FROM (SELECT pa.payment_id, SUM(pa.amount_applied) AS amt
                 FROM payment_applications pa
                 JOIN payments_received pr ON pr.id = pa.payment_id
                 JOIN invoices inv ON inv.id = pa.invoice_id
                WHERE pr.company_id = $1 AND inv.date >= $2 AND pr.date < $2
                GROUP BY pa.payment_id) x
        WHERE p.id = x.payment_id`,
      P,
    );
    await tx.query(
      `DELETE FROM payment_applications pa USING payments_received p, invoices inv
        WHERE p.id = pa.payment_id AND inv.id = pa.invoice_id AND p.company_id = $1 AND (p.date >= $2 OR inv.date >= $2)`,
      P,
    );

    // Credit-memo applications (dated) to invoices.
    if (has('credit_applications', 'date')) {
      collect(
        touchedInvoices,
        (
          await tx.query<{ id: string }>(
            `UPDATE invoices i SET amount_paid = i.amount_paid - x.amt, balance_due = i.balance_due + x.amt
               FROM (SELECT ca.invoice_id, SUM(ca.amount) AS amt
                       FROM credit_applications ca
                       JOIN credit_memos cm ON cm.id = ca.credit_memo_id
                       JOIN invoices inv ON inv.id = ca.invoice_id
                      WHERE ca.company_id = $1 AND inv.date < $2 AND (ca.date >= $2 OR cm.date >= $2)
                      GROUP BY ca.invoice_id) x
              WHERE i.id = x.invoice_id RETURNING i.id::text AS id`,
            P,
          )
        ).rows,
      );
      await tx.query(
        `UPDATE credit_memos m SET unapplied = m.unapplied + x.amt,
                status = CASE WHEN m.status IN ('paid', 'closed') THEN 'open'::doc_status ELSE m.status END
           FROM (SELECT ca.credit_memo_id, SUM(ca.amount) AS amt
                   FROM credit_applications ca
                   JOIN credit_memos cm ON cm.id = ca.credit_memo_id
                   JOIN invoices inv ON inv.id = ca.invoice_id
                  WHERE ca.company_id = $1 AND cm.date < $2 AND (ca.date >= $2 OR inv.date >= $2)
                  GROUP BY ca.credit_memo_id) x
          WHERE m.id = x.credit_memo_id`,
        P,
      );
      await tx.query(
        `DELETE FROM credit_applications ca USING credit_memos cm, invoices inv
          WHERE cm.id = ca.credit_memo_id AND inv.id = ca.invoice_id AND ca.company_id = $1
            AND (ca.date >= $2 OR cm.date >= $2 OR inv.date >= $2)`,
        P,
      );
    }

    // Bill payments after the end date paid kept bills.
    collect(
      touchedBills,
      (
        await tx.query<{ id: string }>(
          `UPDATE bills b SET amount_paid = b.amount_paid - x.amt, balance_due = b.balance_due + x.amt
             FROM (SELECT bpa.bill_id, SUM(bpa.amount_applied) AS amt
                     FROM bill_payment_applications bpa
                     JOIN bill_payments bp ON bp.id = bpa.bill_payment_id
                     JOIN bills bl ON bl.id = bpa.bill_id
                    WHERE bp.company_id = $1 AND bp.date >= $2 AND bl.date < $2
                    GROUP BY bpa.bill_id) x
            WHERE b.id = x.bill_id RETURNING b.id::text AS id`,
          P,
        )
      ).rows,
    );
    await tx.query(
      `DELETE FROM bill_payment_applications bpa USING bill_payments bp, bills bl
        WHERE bp.id = bpa.bill_payment_id AND bl.id = bpa.bill_id AND bp.company_id = $1 AND (bp.date >= $2 OR bl.date >= $2)`,
      P,
    );

    // Vendor-credit applications (dated) to bills.
    if (has('vendor_credit_applications', 'date')) {
      collect(
        touchedBills,
        (
          await tx.query<{ id: string }>(
            `UPDATE bills b SET amount_credited = b.amount_credited - x.amt, balance_due = b.balance_due + x.amt
               FROM (SELECT vca.bill_id, SUM(vca.amount) AS amt
                       FROM vendor_credit_applications vca
                       JOIN vendor_credits vc ON vc.id = vca.vendor_credit_id
                       JOIN bills bl ON bl.id = vca.bill_id
                      WHERE vca.company_id = $1 AND bl.date < $2 AND (vca.date >= $2 OR vc.date >= $2)
                      GROUP BY vca.bill_id) x
              WHERE b.id = x.bill_id RETURNING b.id::text AS id`,
            P,
          )
        ).rows,
      );
      await tx.query(
        `UPDATE vendor_credits v SET unapplied = v.unapplied + x.amt,
                status = CASE WHEN v.status IN ('paid', 'closed') THEN 'open'::doc_status ELSE v.status END
           FROM (SELECT vca.vendor_credit_id, SUM(vca.amount) AS amt
                   FROM vendor_credit_applications vca
                   JOIN vendor_credits vc ON vc.id = vca.vendor_credit_id
                   JOIN bills bl ON bl.id = vca.bill_id
                  WHERE vca.company_id = $1 AND vc.date < $2 AND (vca.date >= $2 OR bl.date >= $2)
                  GROUP BY vca.vendor_credit_id) x
          WHERE v.id = x.vendor_credit_id`,
        P,
      );
      await tx.query(
        `DELETE FROM vendor_credit_applications vca USING vendor_credits vc, bills bl
          WHERE vc.id = vca.vendor_credit_id AND bl.id = vca.bill_id AND vca.company_id = $1
            AND (vca.date >= $2 OR vc.date >= $2 OR bl.date >= $2)`,
        P,
      );
    }

    // General Journal item applications (QB I11) that cross the end date.
    if (has('journal_item_applications', 'date')) {
      const removed = `
        SELECT a.* FROM journal_item_applications a
          JOIN journal_entries je ON je.id = a.journal_entry_id
          LEFT JOIN payments_received p ON p.id = a.payment_id
          LEFT JOIN bill_payments bp ON bp.id = a.bill_payment_id
          LEFT JOIN invoices inv ON inv.id = a.invoice_id
          LEFT JOIN bills bl ON bl.id = a.bill_id
         WHERE a.company_id = $1
           AND (a.date >= $2 OR je.date >= $2 OR p.date >= $2 OR bp.date >= $2 OR inv.date >= $2 OR bl.date >= $2)`;
      collect(
        touchedInvoices,
        (
          await tx.query<{ id: string }>(
            `UPDATE invoices i SET amount_paid = i.amount_paid - x.amt, balance_due = i.balance_due + x.amt
               FROM (SELECT r.invoice_id, SUM(r.amount) AS amt FROM (${removed}) r
                      WHERE r.kind = 'invoice_credit' AND r.invoice_id IS NOT NULL GROUP BY r.invoice_id) x
              WHERE i.id = x.invoice_id AND i.date < $2 RETURNING i.id::text AS id`,
            P,
          )
        ).rows,
      );
      collect(
        touchedBills,
        (
          await tx.query<{ id: string }>(
            `UPDATE bills b SET amount_credited = b.amount_credited - x.amt, balance_due = b.balance_due + x.amt
               FROM (SELECT r.bill_id, SUM(r.amount) AS amt FROM (${removed}) r
                      WHERE r.kind = 'bill_credit' AND r.bill_id IS NOT NULL GROUP BY r.bill_id) x
              WHERE b.id = x.bill_id AND b.date < $2 RETURNING b.id::text AS id`,
            P,
          )
        ).rows,
      );
      await tx.query(
        `UPDATE payments_received pr SET unapplied = pr.unapplied + x.amt
           FROM (SELECT r.payment_id, SUM(r.amount) AS amt FROM (${removed}) r
                  WHERE r.kind = 'payment' AND r.payment_id IS NOT NULL GROUP BY r.payment_id) x
          WHERE pr.id = x.payment_id AND pr.date < $2`,
        P,
      );
      await tx.query(`DELETE FROM journal_item_applications WHERE id IN (SELECT id FROM (${removed}) r)`, P);
    }

    // Kept invoices / bills whose payments were taken back are open (or partly paid) again.
    if (touchedInvoices.size) {
      await tx.query(
        `UPDATE invoices SET status = (CASE WHEN balance_due <= 0 THEN 'paid' WHEN amount_paid > 0 THEN 'partial' ELSE 'open' END)::doc_status
          WHERE id = ANY($1::uuid[]) AND status NOT IN ('void', 'draft')`,
        [[...touchedInvoices]],
      );
    }
    if (touchedBills.size) {
      await tx.query(
        `UPDATE bills SET status = (CASE WHEN balance_due <= 0 THEN 'paid' WHEN amount_paid + amount_credited > 0 THEN 'partial' ELSE 'open' END)::doc_status
          WHERE id = ANY($1::uuid[]) AND status NOT IN ('void', 'draft')`,
        [[...touchedBills]],
      );
    }

    // ---- Inventory quantities as of the end date (before the dated rows they derive from go) ----
    if (has('items', 'quantity_on_hand') && has('inventory_movements', 'date')) {
      await restoreInventoryAsOf(tx, companyId, cutoff, has);
    }

    // ---- Journal entries after the end date (lines first: the balance triggers read the entry) ----
    await tx.query(
      `DELETE FROM journal_entry_lines WHERE journal_entry_id IN
         (SELECT id FROM journal_entries WHERE company_id = $1 AND date >= $2)`,
      P,
    );
    counts.journalEntries =
      (await tx.query('DELETE FROM journal_entries WHERE company_id = $1 AND date >= $2', P)).affectedRows ?? 0;

    // ---- Dated activity after the end date ----
    for (const [t, c] of DATED_TABLES) {
      if (!has(t, c) || !has(t, 'company_id')) continue;
      counts.documents += (await tx.query(`DELETE FROM ${qi(t)} WHERE company_id = $1 AND ${qi(c)} >= $2`, P)).affectedRows ?? 0;
    }
    if (has('reconciliations', 'statement_date')) {
      await tx.query(
        `DELETE FROM reconciliations r USING bank_accounts b
          WHERE r.bank_account_id = b.id AND b.company_id = $1 AND r.statement_date >= $2`,
        P,
      );
    }

    // Lines whose entry is gone (other companies) and every other dangling reference.
    await tx.query('DELETE FROM journal_entry_lines l WHERE NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = l.journal_entry_id)');
    await sweepOrphans(tx);

    // Bank accounts: last reconciliation = the latest one still in the copy.
    if (has('bank_accounts', 'last_reconciled_date')) {
      await tx.query(
        `UPDATE bank_accounts b
            SET last_reconciled_date = r.statement_date, last_reconciled_balance = r.statement_balance
           FROM (SELECT DISTINCT ON (bank_account_id) bank_account_id, statement_date, statement_balance
                   FROM reconciliations WHERE status = 'completed'
                  ORDER BY bank_account_id, statement_date DESC) r
          WHERE r.bank_account_id = b.id AND b.company_id = $1`,
        [companyId],
      );
      await tx.query(
        `UPDATE bank_accounts b SET last_reconciled_date = NULL, last_reconciled_balance = NULL
          WHERE b.company_id = $1 AND NOT EXISTS (SELECT 1 FROM reconciliations r WHERE r.bank_account_id = b.id AND r.status = 'completed')`,
        [companyId],
      );
    }

    // Cached balances = the ledger (the guard accepts exactly the ledger-derived value).
    await tx.query(
      `UPDATE accounts a SET balance = bka_account_ledger_balance(a.id, a.type)
        WHERE a.balance IS DISTINCT FROM bka_account_ledger_balance(a.id, a.type)`,
    );
    return counts;
  });
}

/** Audit entity types whose record lives in a table (for pruning the audit trail of removed records). */
const AUDITED_TABLES: Record<string, string> = {
  journal_entry: 'journal_entries',
  invoice: 'invoices',
  payment_received: 'payments_received',
  sales_receipt: 'sales_receipts',
  credit_memo: 'credit_memos',
  estimate: 'estimates',
  sales_order: 'sales_orders',
  bill: 'bills',
  bill_payment: 'bill_payments',
  vendor_credit: 'vendor_credits',
  purchase_order: 'purchase_orders',
  item_receipt: 'item_receipts',
  expense: 'expenses',
  deposit: 'deposits',
  transfer: 'transfers',
  paycheck: 'paychecks',
  pay_run: 'pay_runs',
  time_entry: 'time_entries',
  inventory_transfer: 'inventory_transfers',
  bank_transaction: 'bank_transactions',
  reconciliation: 'reconciliations',
  receipt_scan: 'receipt_scans',
  receipt_upload_link: 'receipt_upload_tokens',
  month_end_close: 'month_end_closes',
};

/**
 * Step 5: the audit trail and attached files of records that are no longer in the copy go too
 * (they would show activity outside the period). Attachment files nobody references are removed
 * from the copy's folder so the portable file does not carry them.
 */
async function pruneHistory(db: DB, companyId: string, dir: string): Promise<void> {
  await rawClient(db).transaction(async (tx) => {
    await tx.exec('SET LOCAL session_replication_role = replica');
    const cols = await columnsByTable(tx);
    for (const [entityType, table] of Object.entries(AUDITED_TABLES)) {
      if (!cols.has(table)) continue;
      const gone = `NOT EXISTS (SELECT 1 FROM ${qi(table)} t WHERE t.id = x.entity_id)`;
      await tx.query(`DELETE FROM audit_logs x WHERE x.company_id = $1 AND x.entity_type = $2 AND ${gone}`, [companyId, entityType]);
      await tx.query(`DELETE FROM attachments x WHERE x.company_id = $1 AND x.entity_type = $2 AND ${gone}`, [companyId, entityType]);
    }
    await sweepOrphans(tx);
  });
  const keep = new Set(
    (await rawClient(db).query<{ p: string }>('SELECT storage_path AS p FROM attachments')).rows.map((r) =>
      path.normalize(r.p),
    ),
  );
  const attDir = path.join(dir, 'attachments');
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (!keep.has(path.normalize(r))) fs.rmSync(path.join(dir, r), { force: true });
    }
  };
  if (fs.existsSync(attDir)) walk('attachments');
}

async function setCopySettings(db: DB, companyId: string, patch: (s: Record<string, unknown>) => Record<string, unknown>) {
  const [co] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
  const next = patch({ ...((co?.settings ?? {}) as Record<string, unknown>) });
  await db.update(companies).set({ settings: next as never }).where(eq(companies.id, companyId));
}

function tbMap(tb: Awaited<ReturnType<typeof trialBalance>>): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of tb.rows) m.set(r.accountId, `${r.debit}|${r.credit}`);
  return m;
}

function sameTb(a: Awaited<ReturnType<typeof trialBalance>>, b: Awaited<ReturnType<typeof trialBalance>>): string | null {
  const ma = tbMap(a);
  const mb = tbMap(b);
  for (const [id, v] of ma) if (mb.get(id) !== v) return id;
  for (const id of mb.keys()) if (!ma.has(id)) return id;
  return a.totalDebit === b.totalDebit && a.totalCredit === b.totalCredit ? null : 'totals';
}

/** Build the Period Copy of the active company. */
export async function createPeriodCopy(ctx: ServiceContext, input: PeriodCopyInput): Promise<PeriodCopyResult> {
  if (ctx.role && ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new ServiceError('FORBIDDEN', 'Only the company owner or an admin can create a Period Copy (it contains every user of the file).');
  }
  const from = String(input.from ?? '').trim();
  const to = String(input.to ?? '').trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
    throw validation('Enter the start and end dates of the period (YYYY-MM-DD).');
  }
  if (from > to) throw validation('The start date must be on or before the end date.');
  if (!ctx.userId) throw new ServiceError('FORBIDDEN', 'A Period Copy needs a signed-in user.');

  const [co] = await ctx.db.select({ name: companies.name, settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  if (!co) throw new ServiceError('NOT_FOUND', 'Company not found');
  const openingDay = dayBefore(from);
  const origOpening = await trialBalance(ctx, endOfDay(openingDay));
  const origClosing = await trialBalance(ctx, endOfDay(to));

  const portable = await createPortableCompanyFile(ctx, { dataDir: resolveDataDir(input.dataDir) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ironbooks-period-copy-'));
  const work = path.join(root, 'company');
  let result: PeriodCopyResult;
  try {
    await restorePortableCompanyFile(portable.buffer, work);
    const db = await getDb(work);
    const wctx: ServiceContext = { db, companyId: ctx.companyId, userId: ctx.userId };

    const trimmed = await trimCopy(db, ctx.companyId, to);

    // Opening balances: condense everything before the start date (the copy is closed through
    // the day before the start date for the duration, as Condense requires).
    let condensed: PeriodCopySummary['condensed'] = null;
    await setCopySettings(db, ctx.companyId, (s) => ({ ...s, closingDate: openingDay }));
    try {
      const res = await condensePeriod(wctx, { beforeDate: new Date(`${from}T00:00:00.000Z`), dataDir: work });
      condensed = {
        entries: res.entriesToCondense,
        summaryEntries: res.summaryEntriesToCreate,
        keptOpenDocumentEntries: res.keptOpenDocumentEntries,
      };
    } catch (err) {
      if (!(err instanceof ServiceError && err.code === 'VALIDATION' && /Nothing to condense/i.test(err.message))) throw err;
    }

    // Verify: the opening and closing trial balances match the original file, account by account.
    const copyOpening = await trialBalance(wctx, endOfDay(openingDay));
    const copyClosing = await trialBalance(wctx, endOfDay(to));
    const diff = sameTb(origOpening, copyOpening) ?? sameTb(origClosing, copyClosing);
    if (diff || !copyOpening.balanced || !copyClosing.balanced) {
      throw new ServiceError(
        'INTERNAL',
        'The Period Copy did not match the original books (trial balance check failed), so it was not created. Run Verify Data, then try again.',
        { account: diff },
      );
    }

    // The copy is about the period: closed through its end date, range recorded.
    await setCopySettings(db, ctx.companyId, (s) => ({
      ...s,
      closingDate: to,
      periodCopy: { from, to, createdAt: new Date().toISOString(), sourceCompany: co.name },
    }));
    await pruneHistory(db, ctx.companyId, work);

    // A fresh transaction log: the original one describes activity outside the period.
    await rawClient(db).exec('DELETE FROM transaction_log_anchor');
    fs.rmSync(path.join(work, TRANSACTION_LOG_FILE), { force: true });
    resetTransactionLogCache(work);

    const out = await createPortableCompanyFile(wctx, { dataDir: work });
    const safe = co.name.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').replace(/\s+/g, ' ').trim() || 'Company';
    result = {
      buffer: out.buffer,
      filename: `${safe.slice(0, 100)} (Period Copy ${from} to ${to}).bkp`,
      summary: {
        from,
        to,
        companyName: co.name,
        removedAfter: { journalEntries: trimmed.journalEntries, documents: trimmed.documents },
        condensed,
        otherCompaniesRemoved: trimmed.otherCompanies,
        verified: {
          openingTrialBalance: { totalDebit: copyOpening.totalDebit, totalCredit: copyOpening.totalCredit },
          closingTrialBalance: { totalDebit: copyClosing.totalDebit, totalCredit: copyClosing.totalCredit },
          accountsCompared: new Set([...copyOpening.rows, ...copyClosing.rows].map((r) => r.accountId)).size,
        },
      },
    };
  } finally {
    await closeDb(work).catch(() => undefined);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* temp folder: best effort */
    }
  }

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'period_copy',
    entityId: randomUUID(),
    newValues: { ...result.summary },
  });
  return result;
}
