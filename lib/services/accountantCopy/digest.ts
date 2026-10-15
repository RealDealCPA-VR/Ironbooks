/**
 * Record versions + substance digests for the Accountant's Copy (PARITY I1).
 *
 * A record's version (updated_at) moves on ANY change, including ones that only touch derived
 * values: a payment applied to an invoice, a bill paid, a sales order invoiced, an item's stock.
 * The Accountant's Copy must tell those apart from real edits, in both files:
 *  - accountant side: an invoice whose version moved only because the accountant applied a
 *    payment to it is not "changed" (the payment travels, the invoice does not);
 *  - client side: an invoice the client received a payment for (dated after the dividing date)
 *    was not changed by the client, so the accountant's edit of it can still be applied.
 * The digest is an md5 of the record's own columns and its lines with the derived columns left
 * out (balances, amounts paid / credited / invoiced, status, print / email flags, the posted
 * entry, ids of re-posted lines). Both files compute it with the same SQL on the same data, so
 * an unchanged record has the same digest everywhere.
 *
 * Names and items are the exception: their "digest" is the JSON of the columns a copy may change
 * (NAME_COLUMNS), not an md5 of it. It compares the same way, and it also says WHICH fields
 * changed, so a name both sides edited only conflicts when they changed the same field
 * (nameFieldValues / changedNameFields).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { ServiceContext } from '../_base';
import type { DocType, NameType } from './format';

interface ChildSpec {
  table: string;
  fk: string;
  exclude: string[];
  ordered?: boolean;
  /** Extra condition (e.g. only the application rows that belong to the record). */
  where?: string;
}

interface DigestSpec {
  table: string;
  /** Row columns left out of the digest (derived values). */
  exclude: string[];
  children: ChildSpec[];
  /** inventory_line_details.source_type of the document's lines (site / bin / serial / lot). */
  inv?: string;
  /** SQL (alias t) for the record's state: 'void' / 'draft' / 'live', or a status. */
  state: string;
  date: string;
}

const PRINT = ['last_emailed_at', 'to_be_printed', 'to_be_emailed'];
const VOID_BY_STATUS = `CASE WHEN t.status = 'void' THEN 'void' ELSE 'live' END`;
const APP_EXCLUDE = ['id', 'company_id', 'created_at', 'date', 'pair_id', 'journal_entry_id', 'payment_id', 'bill_payment_id'];

export const DOC_DIGEST: Record<Exclude<DocType, 'inventory_adjustment'>, DigestSpec> = {
  invoice: {
    table: 'invoices',
    exclude: ['updated_at', 'created_at', 'status', 'amount_paid', 'balance_due', 'posted_entry_id', ...PRINT],
    children: [{ table: 'invoice_lines', fk: 'invoice_id', exclude: ['id', 'invoice_id', 'pricing'], ordered: true }],
    inv: 'invoice',
    state: `CASE WHEN t.status = 'void' THEN 'void' WHEN t.status = 'draft' THEN 'draft' ELSE 'live' END`,
    date: 'date',
  },
  sales_receipt: {
    table: 'sales_receipts',
    exclude: ['updated_at', 'created_at', 'status', 'posted_entry_id', ...PRINT],
    children: [{ table: 'sales_receipt_lines', fk: 'sales_receipt_id', exclude: ['id', 'sales_receipt_id', 'pricing'], ordered: true }],
    inv: 'sales_receipt',
    state: VOID_BY_STATUS,
    date: 'date',
  },
  credit_memo: {
    table: 'credit_memos',
    exclude: ['updated_at', 'created_at', 'status', 'unapplied', 'refunded_amount', 'posted_entry_id', ...PRINT],
    children: [{ table: 'credit_memo_lines', fk: 'credit_memo_id', exclude: ['id', 'credit_memo_id', 'pricing'], ordered: true }],
    inv: 'credit_memo',
    state: VOID_BY_STATUS,
    date: 'date',
  },
  payment_received: {
    table: 'payments_received',
    exclude: ['updated_at', 'created_at', 'unapplied', 'posted_entry_id', 'voided_at', 'bounced_at'],
    children: [
      { table: 'payment_applications', fk: 'payment_id', exclude: ['id', 'payment_id', 'amount_home'] },
      { table: 'credit_applications', fk: 'payment_id', exclude: APP_EXCLUDE },
      { table: 'journal_item_applications', fk: 'payment_id', exclude: APP_EXCLUDE },
    ],
    state: `CASE WHEN t.voided_at IS NOT NULL THEN 'void' ELSE 'live' END`,
    date: 'date',
  },
  bill: {
    table: 'bills',
    exclude: ['updated_at', 'created_at', 'status', 'amount_paid', 'amount_credited', 'balance_due', 'posted_entry_id'],
    children: [{ table: 'bill_lines', fk: 'bill_id', exclude: ['id', 'bill_id', 'billed_invoice_id'], ordered: true }],
    inv: 'bill',
    state: VOID_BY_STATUS,
    date: 'date',
  },
  bill_payment: {
    table: 'bill_payments',
    exclude: ['updated_at', 'created_at', 'posted_entry_id', 'voided_at', 'to_print'],
    children: [
      { table: 'bill_payment_applications', fk: 'bill_payment_id', exclude: ['id', 'bill_payment_id', 'amount_home'] },
      { table: 'journal_item_applications', fk: 'bill_payment_id', exclude: APP_EXCLUDE },
    ],
    state: `CASE WHEN t.voided_at IS NOT NULL THEN 'void' ELSE 'live' END`,
    date: 'date',
  },
  vendor_credit: {
    table: 'vendor_credits',
    exclude: ['updated_at', 'created_at', 'status', 'unapplied', 'refunded_amount', 'home_unapplied', 'posted_entry_id'],
    children: [{ table: 'vendor_credit_lines', fk: 'vendor_credit_id', exclude: ['id', 'vendor_credit_id', 'cost_amount'], ordered: true }],
    state: VOID_BY_STATUS,
    date: 'date',
  },
  item_receipt: {
    table: 'item_receipts',
    exclude: ['updated_at', 'created_at', 'status', 'converted_bill_id', 'posted_entry_id', 'voided_at'],
    children: [{ table: 'item_receipt_lines', fk: 'item_receipt_id', exclude: ['id', 'item_receipt_id', 'quantity_billed'], ordered: true }],
    inv: 'item_receipt',
    state: `CASE WHEN t.voided_at IS NOT NULL OR t.status = 'void' THEN 'void' ELSE 'live' END`,
    date: 'date',
  },
  estimate: {
    table: 'estimates',
    exclude: ['updated_at', 'created_at', 'status', 'converted_invoice_id', 'amount_invoiced', 'prior_amount_invoiced', ...PRINT],
    children: [
      {
        table: 'estimate_lines',
        fk: 'estimate_id',
        exclude: ['id', 'estimate_id', 'pricing', 'prior_qty_invoiced', 'prior_amount_invoiced'],
        ordered: true,
      },
    ],
    state: 't.status::text',
    date: 'date',
  },
  sales_order: {
    table: 'sales_orders',
    exclude: ['updated_at', 'created_at', 'status', 'converted_invoice_id', ...PRINT],
    children: [{ table: 'sales_order_lines', fk: 'sales_order_id', exclude: ['id', 'sales_order_id', 'pricing', 'quantity_invoiced'], ordered: true }],
    state: 't.status::text',
    date: 'date',
  },
  purchase_order: {
    table: 'purchase_orders',
    exclude: ['updated_at', 'created_at', 'status', 'converted_bill_id'],
    children: [
      {
        table: 'purchase_order_lines',
        fk: 'purchase_order_id',
        exclude: ['id', 'purchase_order_id', 'quantity_billed', 'quantity_received_unbilled'],
        ordered: true,
      },
    ],
    state: 't.status::text',
    date: 'date',
  },
};

/**
 * Name / item columns an Accountant's Copy may edit (payload key → column). Every column the
 * name / item screens the copy allows can change is here (or refused as structural in guard.ts),
 * so no edit goes unnoticed.
 */
export const NAME_COLUMNS: Record<NameType, { table: string; cols: Record<string, string> }> = {
  customer: {
    table: 'customers',
    cols: {
      displayName: 'display_name', companyName: 'company_name', email: 'email', phone: 'phone',
      billingAddress: 'billing_address', shippingAddress: 'shipping_address', terms: 'terms', termsId: 'terms_id',
      creditLimit: 'credit_limit', taxable: 'taxable', taxRateId: 'tax_rate_id', salesTaxCodeId: 'sales_tax_code_id',
      resaleNumber: 'resale_number', taxExemptionReason: 'tax_exemption_reason', notes: 'notes',
      customFields: 'custom_fields', customerTypeId: 'customer_type_id',
    },
  },
  vendor: {
    table: 'vendors',
    cols: {
      displayName: 'display_name', companyName: 'company_name', email: 'email', phone: 'phone', address: 'address',
      terms: 'terms', termsId: 'terms_id', is1099: 'is_1099', defaultExpenseAccountId: 'default_expense_account_id',
      notes: 'notes', printOnCheckAs: 'print_on_check_as', accountNumber: 'account_number', prefillAccountIds: 'prefill_account_ids',
      customFields: 'custom_fields',
    },
  },
  item: {
    table: 'items',
    cols: {
      name: 'name', sku: 'sku', description: 'description', salesPrice: 'sales_price', purchaseCost: 'purchase_cost',
      taxable: 'taxable', salesTaxCodeId: 'sales_tax_code_id', unitOfMeasure: 'unit_of_measure', barcode: 'barcode',
      weight: 'weight', preferredVendorId: 'preferred_vendor_id', reorderPoint: 'reorder_point', customFields: 'custom_fields',
    },
  },
  other_name: {
    table: 'other_names',
    cols: {
      name: 'name', companyName: 'company_name', email: 'email', phone: 'phone', address: 'address',
      accountNumber: 'account_number', notes: 'notes',
    },
  },
};

const minus = (cols: string[]) => cols.map((c) => ` - '${c}'`).join('');

function docDigestSql(spec: DigestSpec): string {
  const parts = [`(to_jsonb(t)${minus(spec.exclude)})::text`];
  for (const c of spec.children) {
    const j = `(to_jsonb(c)${minus(c.exclude)})`;
    const order = c.ordered ? `c.line_order, ${j}::text` : `${j}::text`;
    parts.push(
      `coalesce((SELECT string_agg(${j}::text, '|' ORDER BY ${order}) FROM ${c.table} c WHERE c.${c.fk} = t.id${c.where ? ` AND ${c.where}` : ''}), '')`,
    );
  }
  if (spec.inv) {
    const j = `(to_jsonb(d) - 'id' - 'company_id' - 'created_at' - 'source_id' - 'source_type')`;
    parts.push(
      `coalesce((SELECT string_agg(${j}::text, '|' ORDER BY d.line_order, ${j}::text) FROM inventory_line_details d WHERE d.source_type = '${spec.inv}' AND d.source_id = t.id), '')`,
    );
  }
  return `md5(${parts.join(` || '#' || `)})`;
}

function nameDigestSql(type: NameType): string {
  const { cols } = NAME_COLUMNS[type];
  const args = Object.entries(cols)
    .map(([k, c]) => `'${k}', t.${c}`)
    .join(', ');
  return `jsonb_build_object(${args})::text`;
}

/** The field values a name / item "digest" holds (null for an md5 digest of an older copy). */
export function nameFieldValues(digest: string | null | undefined): Record<string, unknown> | null {
  if (!digest || !digest.startsWith('{')) return null;
  try {
    const v = JSON.parse(digest) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Fields of `type` whose values differ between two name / item digests (null when unknown). */
export function changedNameFields(type: NameType, a: string | null | undefined, b: string | null | undefined): string[] | null {
  const x = nameFieldValues(a);
  const y = nameFieldValues(b);
  if (!x || !y) return null;
  return Object.keys(NAME_COLUMNS[type].cols).filter((k) => JSON.stringify(x[k] ?? null) !== JSON.stringify(y[k] ?? null));
}

export type VersionedType = Exclude<DocType, 'inventory_adjustment'> | NameType;

export const DIGEST_TYPES: VersionedType[] = [
  ...(Object.keys(DOC_DIGEST) as Array<Exclude<DocType, 'inventory_adjustment'>>),
  ...(Object.keys(NAME_COLUMNS) as NameType[]),
];

function tableOf(type: VersionedType): string {
  return type in DOC_DIGEST ? DOC_DIGEST[type as keyof typeof DOC_DIGEST].table : NAME_COLUMNS[type as NameType].table;
}

function selectSql(type: VersionedType): { digest: string; state: string; date: string } {
  if (type in DOC_DIGEST) {
    const spec = DOC_DIGEST[type as keyof typeof DOC_DIGEST];
    return { digest: docDigestSql(spec), state: spec.state, date: `t.${spec.date}` };
  }
  return { digest: nameDigestSql(type as NameType), state: `CASE WHEN t.is_active THEN 'live' ELSE 'inactive' END`, date: 'NULL::timestamp' };
}

/** INSERT … SELECT of the baseline rows (version, digest, state) of every record of one type. */
export function baselineInsertSql(type: VersionedType, copyId: string, companyId: string): SQL {
  const s = selectSql(type);
  return sql`INSERT INTO accountant_copy_baseline (copy_id, entity_type, entity_id, version, digest, state)
    SELECT ${copyId}::uuid, ${type}, t.id, t.updated_at, ${sql.raw(s.digest)}, ${sql.raw(s.state)}
      FROM ${sql.raw(tableOf(type))} t WHERE t.company_id = ${companyId}::uuid`;
}

export interface RecordState {
  id: string;
  digest: string;
  state: string;
  /** 'YYYY-MM-DD' of the record (null for names / items). */
  day: string | null;
}

/** Current digest / state / date of records of one type (all of them when `ids` is omitted). */
export async function recordStates(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  type: VersionedType,
  ids?: string[],
): Promise<Map<string, RecordState>> {
  const out = new Map<string, RecordState>();
  if (ids && ids.length === 0) return out;
  const s = selectSql(type);
  const idFilter = ids ? sql` AND t.id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``;
  const res = await ctx.db.execute(
    sql`SELECT t.id::text AS id, ${sql.raw(s.digest)} AS digest, ${sql.raw(s.state)} AS state, to_char(${sql.raw(s.date)}, 'YYYY-MM-DD') AS day
          FROM ${sql.raw(tableOf(type))} t WHERE t.company_id = ${ctx.companyId}::uuid${idFilter}`,
  );
  for (const r of (res as unknown as { rows: Array<{ id: string; digest: string; state: string; day: string | null }> }).rows) {
    out.set(r.id, { id: r.id, digest: r.digest, state: r.state, day: r.day });
  }
  return out;
}
