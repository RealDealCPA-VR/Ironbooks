/**
 * Accountant's Copy (PARITY I1) — the client's own work after the dividing date that stands in the
 * way of the accountant's changes.
 *
 * While the copy is out the client keeps working (after the dividing date): it reconciles, receives
 * and applies payments, deposits, pays bills, applies and refunds credits. None of that changes the
 * records the accountant edits enough to trip record locking, yet the services the import goes
 * through refuse a change that would undo it:
 *
 *  - an edit / void of a transaction whose lines one of the client's completed reconciliations
 *    cleared (an edit that leaves the ledger as it is — a memo, a check number — still goes in);
 *  - a void (or a refused edit) of an invoice, bill, credit memo, vendor credit or payment the client
 *    has since paid, applied, deposited, refunded or recorded as bounced;
 *  - a payment, credit or application that no longer fits because the client's later payments
 *    and credits have already used up the invoice's / bill's balance or the credit
 *    (walked in the import's order, after the file's own removals);
 *  - a deposit holding a payment or sales receipt the client has already deposited.
 *
 * clientWorkConflicts names each one in plain language — the client's own record and the way out —
 * keyed by the review item it belongs to. The review shows the text as that item's problem and the
 * import refuses with the same text before changing anything.
 */
import { type SQL, sql } from 'drizzle-orm';
import { formatCurrency, Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from '../_base';
import { expensePayload } from './accountant';
import { depositPayloadOf } from './client';
import { DOC_LABEL, docPayload, type Labels } from './docs';
import type { ApplicationChange, ChangesFile, DocChange, DocType, LineRef, TxnType } from './format';

type Ctx = Pick<ServiceContext, 'db' | 'companyId'>;
type Row = Record<string, unknown>;
type Dec = ReturnType<typeof Money.zero>;

const day = (v: unknown) => new Date(v as string).toISOString().slice(0, 10);
const money = (v: Dec | string) => formatCurrency(toAmountString(v));
const dec = (v: unknown) => Money.of(v == null || v === '' ? '0' : String(v));

async function q(ctx: Ctx, query: SQL): Promise<Row[]> {
  return ((await ctx.db.execute(query)) as unknown as { rows: Row[] }).rows;
}

/** Review key of an application change (client.ts uses the same). */
export function applicationKey(a: ApplicationChange): string {
  return `application:${a.kind}:${a.op}:${a.id}:${a.kind === 'vendor_credit' ? a.billId : ''}`;
}

const TXN_WHAT: Record<TxnType, string> = {
  journal_entry: 'journal entry',
  expense: 'check / expense',
  transfer: 'transfer',
  deposit: 'deposit',
};
const docWhat = (t: DocType) => DOC_LABEL[t].toLowerCase();

function joinList(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The client's later work on one record
// ---------------------------------------------------------------------------

type LaterKind = 'invoice' | 'bill' | 'credit_memo' | 'vendor_credit' | 'payment' | 'sales_receipt' | 'line';

interface Later {
  text: string;
  amount: Dec;
  /** A deposit holding the record (payments / sales receipts): its date. */
  depositDay?: string;
}

class LaterWork {
  private cache = new Map<string, Later[]>();
  constructor(
    private ctx: Ctx,
    private dividingDate: string,
    private L: Labels,
  ) {}

  private later(d: unknown): boolean {
    return d != null && day(d) > this.dividingDate;
  }

  private async refunds(id: string): Promise<Later[]> {
    const rows = await q(
      this.ctx,
      sql`SELECT je.date, COALESCE((SELECT SUM(CAST(l.debit AS NUMERIC)) FROM journal_entry_lines l WHERE l.journal_entry_id = je.id), 0) AS amount
          FROM journal_entries je
          WHERE je.company_id = ${this.ctx.companyId}::uuid AND je.source_ref = ${`refund:${id}`} AND je.status = 'posted'`,
    );
    return rows.filter((r) => this.later(r.date)).map((r) => ({ text: `your refund of ${money(dec(r.amount))} on ${day(r.date)}`, amount: dec(r.amount) }));
  }

  async of(kind: LaterKind, id: string): Promise<Later[]> {
    const k = `${kind}:${id}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    const out = await this.load(kind, id);
    this.cache.set(k, out);
    return out;
  }

  private async load(kind: LaterKind, id: string): Promise<Later[]> {
    const c = this.ctx.companyId;
    const L = this.L;
    const out: Later[] = [];
    if (kind === 'invoice') {
      for (const r of await q(
        this.ctx,
        sql`SELECT p.id, p.date, pa.amount_applied, pa.discount_amount FROM payment_applications pa
            JOIN payments_received p ON p.id = pa.payment_id
            WHERE pa.invoice_id = ${id}::uuid AND p.company_id = ${c}::uuid AND p.voided_at IS NULL`,
      )) {
        if (!this.later(r.date)) continue;
        const amt = dec(r.amount_applied).plus(dec(r.discount_amount));
        out.push({ text: `your ${L.doc(r.id)} received ${day(r.date)} (${money(amt)} applied)`, amount: amt });
      }
      for (const r of await q(
        this.ctx,
        sql`SELECT credit_memo_id, amount, date FROM credit_applications WHERE invoice_id = ${id}::uuid AND company_id = ${c}::uuid`,
      )) {
        if (!this.later(r.date)) continue;
        out.push({ text: `your ${L.doc(r.credit_memo_id)} applied ${day(r.date)} (${money(dec(r.amount))})`, amount: dec(r.amount) });
      }
      out.push(...(await this.journalApps(sql`a.invoice_id = ${id}::uuid`, 'applied')));
    } else if (kind === 'bill') {
      for (const r of await q(
        this.ctx,
        sql`SELECT bp.id, bp.date, bpa.amount_applied FROM bill_payment_applications bpa
            JOIN bill_payments bp ON bp.id = bpa.bill_payment_id
            WHERE bpa.bill_id = ${id}::uuid AND bp.company_id = ${c}::uuid AND bp.voided_at IS NULL`,
      )) {
        if (!this.later(r.date)) continue;
        out.push({ text: `your ${L.doc(r.id)} dated ${day(r.date)} (${money(dec(r.amount_applied))} applied)`, amount: dec(r.amount_applied) });
      }
      const byCredit = new Map<string, { amount: Dec; last: string }>();
      for (const r of await q(
        this.ctx,
        sql`SELECT vendor_credit_id, amount, date FROM vendor_credit_applications WHERE bill_id = ${id}::uuid AND company_id = ${c}::uuid`,
      )) {
        if (!this.later(r.date)) continue;
        const cur = byCredit.get(String(r.vendor_credit_id)) ?? { amount: Money.zero(), last: '' };
        byCredit.set(String(r.vendor_credit_id), { amount: cur.amount.plus(dec(r.amount)), last: [cur.last, day(r.date)].sort().at(-1)! });
      }
      for (const [vc, x] of byCredit) {
        if (x.amount.greaterThan(0)) out.push({ text: `your ${L.doc(vc)} applied ${x.last} (${money(x.amount)})`, amount: x.amount });
      }
      out.push(...(await this.journalApps(sql`a.bill_id = ${id}::uuid`, 'applied')));
    } else if (kind === 'credit_memo') {
      for (const r of await q(
        this.ctx,
        sql`SELECT invoice_id, amount, date FROM credit_applications WHERE credit_memo_id = ${id}::uuid AND company_id = ${c}::uuid`,
      )) {
        if (!this.later(r.date)) continue;
        out.push({ text: `${money(dec(r.amount))} applied to your ${L.doc(r.invoice_id)} on ${day(r.date)}`, amount: dec(r.amount) });
      }
      out.push(...(await this.refunds(id)));
    } else if (kind === 'vendor_credit') {
      const byBill = new Map<string, { amount: Dec; last: string }>();
      for (const r of await q(
        this.ctx,
        sql`SELECT bill_id, amount, date FROM vendor_credit_applications WHERE vendor_credit_id = ${id}::uuid AND company_id = ${c}::uuid`,
      )) {
        if (!this.later(r.date)) continue;
        const cur = byBill.get(String(r.bill_id)) ?? { amount: Money.zero(), last: '' };
        byBill.set(String(r.bill_id), { amount: cur.amount.plus(dec(r.amount)), last: [cur.last, day(r.date)].sort().at(-1)! });
      }
      for (const [bill, x] of byBill) {
        if (x.amount.greaterThan(0)) out.push({ text: `${money(x.amount)} applied to your ${L.doc(bill)} on ${x.last}`, amount: x.amount });
      }
      out.push(...(await this.refunds(id)));
    } else if (kind === 'payment') {
      for (const r of await q(
        this.ctx,
        sql`SELECT d.id, d.date, d.total, d.deposit_account_id, dl.amount FROM deposit_lines dl
            JOIN deposits d ON d.id = dl.deposit_id
            WHERE dl.payment_id = ${id}::uuid AND d.company_id = ${c}::uuid AND d.voided_at IS NULL`,
      )) {
        if (!this.later(r.date)) continue;
        out.push({
          text: `your deposit of ${money(dec(r.total))} on ${day(r.date)} to ${L.account(r.deposit_account_id)}`,
          amount: dec(r.amount),
          depositDay: day(r.date),
        });
      }
      for (const r of await q(
        this.ctx,
        sql`SELECT pa.invoice_id, pa.amount_applied, pa.discount_amount, i.date FROM payment_applications pa
            JOIN invoices i ON i.id = pa.invoice_id
            WHERE pa.payment_id = ${id}::uuid AND i.company_id = ${c}::uuid`,
      )) {
        if (!this.later(r.date)) continue;
        const amt = dec(r.amount_applied).plus(dec(r.discount_amount));
        out.push({ text: `${money(amt)} of it applied to your ${L.doc(r.invoice_id)} dated ${day(r.date)}`, amount: amt });
      }
      out.push(...(await this.refunds(id)));
      for (const r of await q(
        this.ctx,
        sql`SELECT date, amount FROM bounced_checks WHERE payment_id = ${id}::uuid AND company_id = ${c}::uuid`,
      )) {
        if (!this.later(r.date)) continue;
        out.push({ text: `your bounced check record of ${day(r.date)}`, amount: dec(r.amount) });
      }
    } else if (kind === 'sales_receipt') {
      for (const r of await q(
        this.ctx,
        sql`SELECT d.id, d.date, d.total, d.deposit_account_id, dl.amount FROM deposit_lines dl
            JOIN deposits d ON d.id = dl.deposit_id
            WHERE dl.description = ${`salesReceipt:${id}`} AND d.company_id = ${c}::uuid AND d.voided_at IS NULL`,
      )) {
        if (!this.later(r.date)) continue;
        out.push({
          text: `your deposit of ${money(dec(r.total))} on ${day(r.date)} to ${L.account(r.deposit_account_id)}`,
          amount: dec(r.amount),
          depositDay: day(r.date),
        });
      }
    } else {
      out.push(...(await this.journalApps(sql`a.journal_line_id = ${id}::uuid`, 'used')));
    }
    return out;
  }

  /** General Journal applications (credits applied, charges paid) dated after the dividing date. */
  private async journalApps(where: SQL, verb: string): Promise<Later[]> {
    const rows = await q(
      this.ctx,
      sql`SELECT a.amount, a.date, a.invoice_id, a.bill_id, a.payment_id, a.bill_payment_id, je.entry_number
          FROM journal_item_applications a JOIN journal_entries je ON je.id = a.journal_entry_id
          WHERE a.company_id = ${this.ctx.companyId}::uuid AND ${where}`,
    );
    return rows
      .filter((r) => this.later(r.date))
      .map((r) => {
        const on = r.invoice_id ? ` on your ${this.L.doc(r.invoice_id)}` : r.bill_id ? ` on your ${this.L.doc(r.bill_id)}` : '';
        const by = r.payment_id ? ` with your ${this.L.doc(r.payment_id)}` : r.bill_payment_id ? ` with your ${this.L.doc(r.bill_payment_id)}` : '';
        return {
          text: `${money(dec(r.amount))} of your General Journal #${r.entry_number} ${verb}${on}${by} on ${day(r.date)}`,
          amount: dec(r.amount),
        };
      });
  }
}

// ---------------------------------------------------------------------------
// Reconciled lines
// ---------------------------------------------------------------------------

const ENTRY_TABLE: Partial<Record<string, string>> = {
  expense: 'expenses',
  transfer: 'transfers',
  deposit: 'deposits',
  invoice: 'invoices',
  sales_receipt: 'sales_receipts',
  credit_memo: 'credit_memos',
  payment_received: 'payments_received',
  bill: 'bills',
  bill_payment: 'bill_payments',
  vendor_credit: 'vendor_credits',
  item_receipt: 'item_receipts',
};

async function postedEntryOf(ctx: Ctx, type: string, id: string): Promise<string | null> {
  if (type === 'journal_entry') return id;
  const table = ENTRY_TABLE[type];
  if (!table) return null;
  const [r] = await q(ctx, sql`SELECT posted_entry_id FROM ${sql.raw(table)} WHERE id = ${id}::uuid AND company_id = ${ctx.companyId}::uuid`);
  return (r?.posted_entry_id as string | null) ?? null;
}

/** The client's completed reconciliations that cleared a line of the entry (less the ones the file undoes). */
async function reconciliationsClearing(ctx: Ctx, entryId: string, undone: Set<string>): Promise<Array<{ accountId: string; statementDay: string }>> {
  const rows = await q(
    ctx,
    sql`SELECT DISTINCT r.id, r.statement_date, ba.account_id FROM reconciliation_items ri
        JOIN reconciliations r ON r.id = ri.reconciliation_id
        JOIN bank_accounts ba ON ba.id = r.bank_account_id
        JOIN journal_entry_lines l ON l.id = ri.journal_entry_line_id
        WHERE l.journal_entry_id = ${entryId}::uuid AND ri.is_cleared = true AND r.status = 'completed' AND ba.company_id = ${ctx.companyId}::uuid`,
  );
  return rows
    .filter((r) => !undone.has(String(r.id)))
    .map((r) => ({ accountId: String(r.account_id), statementDay: day(r.statement_date) }))
    .sort((a, b) => a.statementDay.localeCompare(b.statementDay));
}

/** Normalized comparable form: dates as days, amounts without trailing zeros, arrays order-free. */
function norm(v: unknown): unknown {
  if (v == null || v === '') return null;
  if (v instanceof Date) return day(v);
  if (typeof v === 'number') return Money.of(v).toString();
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return v.slice(0, 10);
    if (/^-?\d+(\.\d+)?$/.test(v)) return Money.of(v).toString();
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => JSON.stringify(norm(x))).sort();
  if (typeof v === 'object') {
    const out: Row = {};
    for (const k of Object.keys(v as Row).sort()) {
      const n = norm((v as Row)[k]);
      if (n !== null) out[k] = n;
    }
    return out;
  }
  return v;
}

function pick(p: Row, keys: string[], lineKeys: string[]): Row {
  const sub = (x: unknown) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return x;
    const o: Row = {};
    for (const k of lineKeys) o[k] = (x as Row)[k];
    return o;
  };
  const out: Row = {};
  for (const k of keys) {
    const v = p[k];
    out[k] = Array.isArray(v) ? v.map(sub) : sub(v);
  }
  return out;
}

const same = (a: Row, b: Row) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/**
 * Whether the accountant's edit changes what the service would re-post. Journal entries, sales /
 * purchase forms and received payments are always voided and re-posted on an edit; checks,
 * transfers, deposits and vendor credits keep their entry when the date and ledger lines stay;
 * a bill payment when only its number / print flag change.
 */
async function editChangesLedger(ctx: ServiceContext, type: string, id: string, after: Row): Promise<boolean> {
  try {
    if (type === 'expense') {
      const keys = ['date', 'paymentAccountId', 'total', 'currency', 'exchangeRate', 'lines'];
      return !same(pick((await expensePayload(ctx, id)) as unknown as Row, keys, ['accountId', 'itemId', 'amount', 'classId']), pick(after, keys, ['accountId', 'itemId', 'amount', 'classId']));
    }
    if (type === 'transfer') {
      const [r] = await q(ctx, sql`SELECT date, from_account_id, to_account_id, amount FROM transfers WHERE id = ${id}::uuid AND company_id = ${ctx.companyId}::uuid`);
      if (!r) return true;
      return !same(
        { date: r.date, fromAccountId: r.from_account_id, toAccountId: r.to_account_id, amount: r.amount },
        { date: after.date, fromAccountId: after.fromAccountId, toAccountId: after.toAccountId, amount: after.amount },
      );
    }
    if (type === 'deposit') {
      const keys = ['date', 'depositAccountId', 'total', 'exchangeRate', 'paymentIds', 'salesReceiptIds', 'extraLines', 'cashBack'];
      return !same(pick((await depositPayloadOf(ctx, id)) as unknown as Row, keys, ['accountId', 'amount']), pick(after, keys, ['accountId', 'amount']));
    }
    if (type === 'vendor_credit') {
      const keys = ['date', 'total', 'exchangeRate', 'lines'];
      const lk = ['accountId', 'itemId', 'amount', 'quantity', 'unitCost', 'classId'];
      return !same(pick(await docPayload(ctx, 'vendor_credit', id), keys, lk), pick(after, keys, lk));
    }
    if (type === 'bill_payment') {
      const cur = { ...(await docPayload(ctx, 'bill_payment', id)) };
      const nxt = { ...after };
      for (const k of ['reference', 'toPrint']) {
        delete cur[k];
        delete nxt[k];
      }
      return !same(cur, nxt);
    }
  } catch {
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Running balances (the import's order)
// ---------------------------------------------------------------------------

type BalKind = 'invoice' | 'bill' | 'credit_memo' | 'vendor_credit' | 'payment' | 'line';

const BAL_SQL: Record<Exclude<BalKind, 'line'>, (id: string, c: string) => SQL> = {
  invoice: (id, c) => sql`SELECT balance_due AS open FROM invoices WHERE id = ${id}::uuid AND company_id = ${c}::uuid AND status <> 'void'`,
  bill: (id, c) => sql`SELECT balance_due AS open FROM bills WHERE id = ${id}::uuid AND company_id = ${c}::uuid AND status <> 'void'`,
  credit_memo: (id, c) => sql`SELECT unapplied AS open FROM credit_memos WHERE id = ${id}::uuid AND company_id = ${c}::uuid AND status <> 'void'`,
  vendor_credit: (id, c) => sql`SELECT unapplied AS open FROM vendor_credits WHERE id = ${id}::uuid AND company_id = ${c}::uuid AND status <> 'void'`,
  payment: (id, c) => sql`SELECT unapplied AS open FROM payments_received WHERE id = ${id}::uuid AND company_id = ${c}::uuid AND voided_at IS NULL`,
};

class Balances {
  private open = new Map<string, Dec | null>();
  constructor(private ctx: Ctx) {}

  /** What is still open on a record of the client's file now (null: not in this file / void). */
  async get(kind: BalKind, id: string): Promise<Dec | null> {
    const k = `${kind}:${id}`;
    if (this.open.has(k)) return this.open.get(k)!;
    let v: Dec | null = null;
    if (/^[0-9a-f-]{36}$/i.test(id)) {
      if (kind === 'line') {
        const [r] = await q(
          this.ctx,
          sql`SELECT l.debit, l.credit,
                COALESCE((SELECT SUM(CAST(a.amount AS NUMERIC)) FROM journal_item_applications a WHERE a.journal_line_id = l.id), 0) AS applied
              FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
              WHERE l.id = ${id}::uuid AND je.company_id = ${this.ctx.companyId}::uuid AND je.status = 'posted'`,
        );
        if (r) v = dec(r.debit).minus(dec(r.credit)).abs().minus(dec(r.applied));
      } else {
        const [r] = await q(this.ctx, BAL_SQL[kind](id, this.ctx.companyId));
        if (r) v = dec(r.open);
      }
    }
    this.open.set(k, v);
    return v;
  }

  async add(kind: BalKind, id: string, delta: Dec): Promise<{ before: Dec; after: Dec } | null> {
    const cur = await this.get(kind, id);
    if (cur === null) return null;
    const next = cur.plus(delta);
    this.open.set(`${kind}:${id}`, next);
    return { before: cur, after: next };
  }

  gone(kind: BalKind, id: string) {
    this.open.set(`${kind}:${id}`, null);
  }
}

/** One amount a change takes from (or gives back to) a record's open balance. */
interface Use {
  kind: BalKind;
  id: string;
  amount: Dec;
}

const arr = (p: Row, k: string) => (Array.isArray(p[k]) ? (p[k] as Row[]) : []);
const lineId = (r: unknown) => (r && typeof r === 'object' ? String((r as LineRef).lineId) : '');

/** What a received payment / bill payment payload takes from invoices, bills, credits and journal lines. */
function paymentUses(type: DocType, p: Row): Use[] {
  const out: Use[] = [];
  if (type === 'payment_received') {
    for (const a of arr(p, 'applications')) out.push({ kind: 'invoice', id: String(a.invoiceId), amount: dec(a.amountApplied).plus(dec(a.discountAmount)) });
    for (const c of arr(p, 'credits')) {
      out.push({ kind: 'credit_memo', id: String(c.creditMemoId), amount: dec(c.amount) });
      out.push({ kind: 'invoice', id: String(c.invoiceId), amount: dec(c.amount) });
    }
    for (const j of arr(p, 'journalCredits')) {
      out.push({ kind: 'line', id: lineId(j.line), amount: dec(j.amount) });
      out.push({ kind: 'invoice', id: String(j.invoiceId), amount: dec(j.amount) });
    }
  } else {
    for (const a of arr(p, 'applications')) out.push({ kind: 'bill', id: String(a.billId), amount: dec(a.amountApplied).plus(dec(a.discountTaken)) });
    for (const j of arr(p, 'journalCredits')) {
      out.push({ kind: 'line', id: lineId(j.line), amount: dec(j.amount) });
      out.push({ kind: 'bill', id: String(j.billId), amount: dec(j.amount) });
    }
  }
  for (const j of arr(p, 'journalItems')) out.push({ kind: 'line', id: lineId(j.line), amount: dec(j.amount) });
  for (const j of arr(p, 'journalOffsets')) {
    out.push({ kind: 'line', id: lineId(j.line), amount: dec(j.amount) });
    out.push({ kind: 'line', id: lineId(j.chargeLine), amount: dec(j.amount) });
  }
  return out;
}

function applicationUses(a: ApplicationChange): Use[] {
  if (a.kind === 'credit_memo') {
    return [
      { kind: 'credit_memo', id: a.creditMemoId, amount: dec(a.amount) },
      { kind: 'invoice', id: a.invoiceId, amount: dec(a.amount) },
    ];
  }
  if (a.kind === 'vendor_credit') {
    return [
      { kind: 'vendor_credit', id: a.vendorCreditId, amount: dec(a.amount) },
      { kind: 'bill', id: a.billId, amount: dec(a.amount) },
    ];
  }
  if (a.op === 'unapply') return [];
  return [
    { kind: 'line', id: a.line.lineId, amount: dec(a.amount) },
    ...(a.invoiceId ? [{ kind: 'invoice' as const, id: a.invoiceId, amount: dec(a.amount) }] : []),
    ...(a.billId ? [{ kind: 'bill' as const, id: a.billId, amount: dec(a.amount) }] : []),
    ...(a.chargeLine ? [{ kind: 'line' as const, id: a.chargeLine.lineId, amount: dec(a.amount) }] : []),
  ];
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Every change of the file the client's own later work blocks, as review key → plain-language
 * problem (the client's record and the way out). In the review's item order.
 */
export async function clientWorkConflicts(
  ctx: ServiceContext,
  file: ChangesFile,
  copy: { dividingDate: string },
  L: Labels,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const flag = (key: string, text: string) => {
    if (!out.has(key)) out.set(key, text);
  };
  const later = new LaterWork(ctx, copy.dividingDate, L);
  const undone = new Set(file.reconciliations.filter((r) => r.op === 'undo').map((r) => r.id));
  const label = (kind: BalKind, id: string) => (kind === 'line' ? 'General Journal credit' : L.doc(id));
  const texts = (xs: Later[]) => joinList(xs.map((x) => x.text));
  const them = (xs: Later[]) => (xs.length === 1 ? 'it' : 'them');

  // 1. Transactions the client's reconciliations cleared.
  const reconciled = async (key: string, type: string, id: string, op: 'edit' | 'void', what: string, after: Row | null) => {
    const entryId = await postedEntryOf(ctx, type, id);
    if (!entryId) return;
    const recs = await reconciliationsClearing(ctx, entryId, undone);
    if (!recs.length) return;
    if (op === 'edit' && !(await editChangesLedger(ctx, type, id, after ?? {}))) return;
    const first = recs[0];
    const acct = L.account(first.accountId);
    const ends = joinList([...new Set(recs.map((r) => r.statementDay))]);
    flag(
      key,
      `This ${what} was cleared in your reconciliation of ${acct} for the statement ending ${ends}, so ` +
        (op === 'void' ? "your accountant's void of it can't be made" : "your accountant's change to its amount, accounts or date can't be made") +
        ` while it stays reconciled. To import: open Reconcile for ${acct} and use Undo Last Reconciliation until the statement ending ${first.statementDay} is undone, ` +
        `import these changes, then reconcile that statement again — or ask your accountant to leave this ${what} as it is.`,
    );
  };
  for (const t of file.transactions) {
    if (t.op === 'add') continue;
    await reconciled(`${t.type}:${t.op}:${t.id}`, t.type, t.id, t.op, TXN_WHAT[t.type], t.op === 'edit' ? (t.after as unknown as Row) : null);
  }
  for (const d of file.documents) {
    if (d.op === 'add' || d.type === 'inventory_adjustment') continue;
    await reconciled(`${d.type}:${d.op}:${d.id}`, d.type, d.id, d.op, docWhat(d.type), d.op === 'edit' ? d.after : null);
  }

  // 2. Voids / edits of records the client has since paid, applied, deposited or refunded.
  const current = async (table: string, id: string) =>
    (await q(ctx, sql`SELECT * FROM ${sql.raw(table)} WHERE id = ${id}::uuid AND company_id = ${ctx.companyId}::uuid`))[0] ?? null;
  for (const d of file.documents) {
    if (d.op === 'add') continue;
    const key = `${d.type}:${d.op}:${d.id}`;
    const what = docWhat(d.type);
    const verb = d.op === 'void' ? 'voided' : 'changed';
    // Invoices / bills carry the client's payments; credits and payments were used by the client.
    const target = d.type === 'invoice' || d.type === 'bill';
    const blocked = (xs: Later[], why: string, undo: string) =>
      flag(
        key,
        (target
          ? `Your file has ${texts(xs)} on this ${what} (${L.doc(d.id)}), dated after the dividing date, so ${why}. `
          : `Since the dividing date your file has used this ${what} (${L.doc(d.id)}): ${texts(xs)}. So ${why}. `) +
          `To import: ${undo}, import these changes, then redo ${them(xs)} — or ask your accountant to leave this ${what} as it is.`,
      );
    if (d.type === 'invoice') {
      const xs = await later.of('invoice', d.id);
      if (!xs.length) continue;
      if (d.op === 'void') {
        blocked(xs, "it can't be voided", `take ${them(xs)} off this invoice (unapply or void ${them(xs)})`);
        continue;
      }
      const cur = await current('invoices', d.id);
      const after = d.after;
      if (cur && (String(after.customerId) !== String(cur.customer_id) || (after.currency ?? null) !== (cur.currency ?? null))) {
        blocked(xs, "its customer and currency can't be changed", `take ${them(xs)} off this invoice (unapply or void ${them(xs)})`);
      }
    } else if (d.type === 'bill') {
      const xs = await later.of('bill', d.id);
      if (xs.length) blocked(xs, `it can't be ${verb}`, `take ${them(xs)} off this bill (unapply or void ${them(xs)})`);
    } else if (d.type === 'credit_memo') {
      const xs = await later.of('credit_memo', d.id);
      if (xs.length && d.op === 'void') blocked(xs, "it can't be voided", `take that credit off again (unapply it, or void the refund)`);
    } else if (d.type === 'vendor_credit') {
      const xs = await later.of('vendor_credit', d.id);
      if (!xs.length) continue;
      if (d.op === 'void' || (await editChangesLedger(ctx, 'vendor_credit', d.id, d.after))) {
        blocked(xs, d.op === 'void' ? "it can't be voided" : "its amount and accounts can't be changed", 'take that credit off again (unapply it, or void the refund)');
      }
    } else if (d.type === 'payment_received') {
      const xs = await later.of('payment', d.id);
      if (!xs.length) continue;
      const deposits = xs.filter((x) => x.depositDay);
      const others = xs.filter((x) => !x.depositDay);
      if (d.op === 'void' || others.length) {
        blocked(
          xs,
          d.op === 'void' ? "it can't be voided" : "your accountant's version of it would undo that",
          deposits.length ? `remove it from your deposit (or void that deposit)${others.length ? ' and undo the rest' : ''}` : `undo ${them(xs)}`,
        );
        continue;
      }
      const cur = await current('payments_received', d.id);
      const after = d.after;
      const lastDeposit = deposits.map((x) => x.depositDay!).sort()[0];
      if (
        cur &&
        (!dec(after.amount).equals(dec(cur.amount)) ||
          String(after.depositAccountId ?? '') !== String(cur.deposit_account_id ?? '') ||
          (after.currency ?? null) !== (cur.currency ?? null) ||
          day(after.date) > lastDeposit)
      ) {
        blocked(deposits, "its amount, deposit account and a date after that deposit can't be changed", 'remove it from your deposit (or void that deposit)');
      }
    } else if (d.type === 'sales_receipt' && d.op === 'edit') {
      const xs = await later.of('sales_receipt', d.id);
      if (!xs.length) continue;
      const cur = await current('sales_receipts', d.id);
      if (cur && (!dec(d.after.total).equals(dec(cur.total)) || String(d.after.depositAccountId ?? '') !== String(cur.deposit_account_id ?? ''))) {
        blocked(xs, "its total and deposit account can't be changed", 'remove it from your deposit (or void that deposit)');
      }
    }
  }

  // 3. Balances: walk the file in the import's order; a payment, credit or application that takes
  //    more than is still open — because the client's later work already took it — is named.
  const bal = new Balances(ctx);
  const take = async (key: string, what: string, uses: Use[]) => {
    for (const u of uses) {
      const r = await bal.add(u.kind, u.id, u.amount.negated());
      if (!r || !r.after.lessThan(-0.005)) continue;
      const kindOf: LaterKind = u.kind;
      const xs = await later.of(kindOf, u.id);
      if (!xs.length) continue;
      const open = r.before.greaterThan(0) ? r.before : Money.zero();
      const target = u.kind === 'invoice' || u.kind === 'bill';
      flag(
        key,
        target
          ? `Your file already has ${texts(xs)} on ${label(u.kind, u.id)}, dated after the dividing date, so only ${money(open)} of it is still open and your accountant's ${what} of ${money(u.amount)} to it doesn't fit. ` +
              `To import: take ${them(xs)} off ${label(u.kind, u.id)} (unapply or void ${them(xs)}), import these changes, then apply what is still open — or ask your accountant to change this ${what}.`
          : `Your file has already used ${label(u.kind, u.id)}: ${texts(xs)}, dated after the dividing date, so only ${money(open)} of it is left and your accountant's ${what} of ${money(u.amount)} from it doesn't fit. ` +
              `To import: take that off again (unapply it), import these changes, then use what is left — or ask your accountant to change this ${what}.`,
      );
    }
  };
  const give = async (uses: Use[]) => {
    for (const u of uses) await bal.add(u.kind, u.id, u.amount);
  };
  const isPayment = (d: DocChange) => d.type === 'payment_received' || d.type === 'bill_payment';
  const currentUses = async (d: DocChange) => {
    try {
      return paymentUses(d.type, await docPayload(ctx, d.type, d.id));
    } catch {
      return [];
    }
  };

  //  a. credits taken off
  for (const a of file.applications) {
    if (a.op !== 'unapply') continue;
    if (a.kind === 'journal') {
      for (const r of await q(
        ctx,
        sql`SELECT x.journal_line_id, x.invoice_id, x.bill_id, x.amount FROM journal_item_applications x
            WHERE x.company_id = ${ctx.companyId}::uuid AND (x.id = ${a.id}::uuid OR x.pair_id = (SELECT pair_id FROM journal_item_applications WHERE id = ${a.id}::uuid))`,
      )) {
        await bal.add('line', String(r.journal_line_id), dec(r.amount));
        if (r.invoice_id) await bal.add('invoice', String(r.invoice_id), dec(r.amount));
        if (r.bill_id) await bal.add('bill', String(r.bill_id), dec(r.amount));
      }
    } else await give(applicationUses(a));
  }
  //  b. voids: payments give back what they applied; voided forms are gone
  for (const d of file.documents) {
    if (d.op !== 'void') continue;
    if (isPayment(d)) await give(await currentUses(d));
    else if (d.type === 'invoice' || d.type === 'bill' || d.type === 'credit_memo' || d.type === 'vendor_credit') bal.gone(d.type, d.id);
  }
  //  c. form edits change what is open on them
  for (const d of file.documents) {
    if (d.op !== 'edit' || isPayment(d)) continue;
    const table = { invoice: 'invoices', bill: 'bills', credit_memo: 'credit_memos', vendor_credit: 'vendor_credits' }[d.type as string];
    if (!table) continue;
    const cur = await current(table, d.id);
    if (!cur) continue;
    const kind = d.type as BalKind;
    const delta = dec(d.after.total).minus(dec(cur.total));
    const r = await bal.add(kind, d.id, delta);
    if (!r || !r.after.lessThan(-0.005) || out.has(`${d.type}:edit:${d.id}`)) continue;
    const xs = await later.of(kind as LaterKind, d.id);
    if (!xs.length) continue;
    flag(
      `${d.type}:edit:${d.id}`,
      `Your file has ${texts(xs)} on this ${docWhat(d.type)} (${L.doc(d.id)}), dated after the dividing date, so your accountant's new total of ${money(dec(d.after.total))} would be less than what is already applied to it. ` +
        `To import: take ${them(xs)} off (unapply or void ${them(xs)}), import these changes, then apply what is still open — or ask your accountant to leave this ${docWhat(d.type)}'s total as it is.`,
    );
  }
  //  d. payments: an edit gives back the old applications, then takes the new ones
  for (const op of ['edit', 'add'] as const) {
    for (const d of file.documents) {
      if (d.op !== op || !isPayment(d)) continue;
      if (op === 'edit') await give(await currentUses(d));
      await take(`${d.type}:${d.op}:${d.id}`, docWhat(d.type), paymentUses(d.type, d.after));
    }
  }
  //  e. credits applied outside a payment
  for (const a of file.applications) {
    if (a.op !== 'apply') continue;
    await take(applicationKey(a), 'application', applicationUses(a));
  }

  // 4. Deposits holding a payment / sales receipt the client already deposited.
  const voidedDeposits = new Set(file.transactions.filter((t) => t.type === 'deposit' && t.op === 'void').map((t) => t.id));
  for (const t of file.transactions) {
    if (t.type !== 'deposit' || t.op === 'void') continue;
    const key = `${t.type}:${t.op}:${t.id}`;
    const held: Array<{ id: string; where: SQL }> = [
      ...t.after.paymentIds.map((id) => ({ id, where: sql`dl.payment_id = ${id}::uuid` })),
      ...t.after.salesReceiptIds.map((id) => ({ id, where: sql`dl.description = ${`salesReceipt:${id}`}` })),
    ];
    for (const h of held) {
      if (!/^[0-9a-f-]{36}$/i.test(h.id)) continue;
      const rows = (
        await q(
          ctx,
          sql`SELECT d.id, d.date, d.total, d.deposit_account_id FROM deposit_lines dl JOIN deposits d ON d.id = dl.deposit_id
              WHERE ${h.where} AND d.company_id = ${ctx.companyId}::uuid AND d.voided_at IS NULL`,
        )
      ).filter((r) => String(r.id) !== t.id && !voidedDeposits.has(String(r.id)));
      if (!rows.length) continue;
      const r = rows[0];
      flag(
        key,
        `Your ${L.doc(h.id)} is already in your deposit of ${money(dec(r.total))} on ${day(r.date)} to ${L.account(r.deposit_account_id)}, so your accountant's deposit can't hold it too. ` +
          `To import: remove it from your deposit (or void that deposit), import these changes, then deposit anything still waiting in Undeposited Funds — or ask your accountant to take it out of this deposit.`,
      );
      break;
    }
  }

  return out;
}

