/**
 * Plain-language labels for the ids a changes file names (accounts, classes, customers / vendors /
 * other names / employees, items, and documents such as "Invoice #1004"), for the client's review
 * and the accountant's "changes so far" list. Records the changes file adds are labelled from the
 * file itself.
 */
import { and, eq } from 'drizzle-orm';
import {
  accounts,
  bills,
  classes,
  creditMemos,
  customers,
  employees,
  invoices,
  items,
  otherNames,
  paymentsReceived,
  purchaseOrders,
  salesReceipts,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { formatCurrency } from '@/lib/money';
import type { ServiceContext } from '../_base';
import type { Labels } from './docs';
import type { ChangesFileBody } from './format';

export interface LabelMaps {
  accounts: Map<string, string>;
  classes: Map<string, string>;
  names: Map<string, string>;
  items: Map<string, string>;
  docs: Map<string, string>;
}

export async function loadLabelMaps(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<LabelMaps> {
  const c = ctx.companyId;
  const m: LabelMaps = { accounts: new Map(), classes: new Map(), names: new Map(), items: new Map(), docs: new Map() };
  for (const a of await ctx.db.select({ id: accounts.id, code: accounts.code, name: accounts.name }).from(accounts).where(eq(accounts.companyId, c))) {
    m.accounts.set(a.id, `${a.code} · ${a.name}`);
  }
  for (const r of await ctx.db.select({ id: classes.id, n: classes.name }).from(classes).where(eq(classes.companyId, c))) m.classes.set(r.id, r.n);
  for (const r of await ctx.db.select({ id: customers.id, n: customers.displayName }).from(customers).where(eq(customers.companyId, c))) m.names.set(r.id, r.n);
  for (const r of await ctx.db.select({ id: vendors.id, n: vendors.displayName }).from(vendors).where(eq(vendors.companyId, c))) m.names.set(r.id, r.n);
  for (const r of await ctx.db.select({ id: otherNames.id, n: otherNames.name }).from(otherNames).where(eq(otherNames.companyId, c))) m.names.set(r.id, r.n);
  for (const r of await ctx.db.select({ id: employees.id, f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.companyId, c))) {
    m.names.set(r.id, `${r.f} ${r.l}`.trim());
  }
  for (const r of await ctx.db.select({ id: items.id, n: items.name }).from(items).where(eq(items.companyId, c))) m.items.set(r.id, r.n);
  const who = (id: string | null) => (id && m.names.get(id) ? ` (${m.names.get(id)})` : '');
  for (const r of await ctx.db
    .select({ id: invoices.id, ref: invoices.refNumber, n: invoices.invoiceNumber, cu: invoices.customerId })
    .from(invoices)
    .where(eq(invoices.companyId, c))) {
    m.docs.set(r.id, `invoice #${r.ref ?? r.n}${who(r.cu)}`);
  }
  for (const r of await ctx.db
    .select({ id: creditMemos.id, ref: creditMemos.refNumber, n: creditMemos.memoNumber, cu: creditMemos.customerId })
    .from(creditMemos)
    .where(eq(creditMemos.companyId, c))) {
    m.docs.set(r.id, `credit memo #${r.ref ?? r.n}${who(r.cu)}`);
  }
  for (const r of await ctx.db
    .select({ id: salesReceipts.id, ref: salesReceipts.refNumber, n: salesReceipts.receiptNumber, cu: salesReceipts.customerId })
    .from(salesReceipts)
    .where(eq(salesReceipts.companyId, c))) {
    m.docs.set(r.id, `sales receipt #${r.ref ?? r.n}${who(r.cu)}`);
  }
  for (const r of await ctx.db
    .select({ id: paymentsReceived.id, ref: paymentsReceived.reference, amount: paymentsReceived.amount, cu: paymentsReceived.customerId })
    .from(paymentsReceived)
    .where(eq(paymentsReceived.companyId, c))) {
    m.docs.set(r.id, `payment${r.ref ? ` #${r.ref}` : ''} of ${formatCurrency(r.amount)}${who(r.cu)}`);
  }
  for (const r of await ctx.db.select({ id: bills.id, ref: bills.billNumber, total: bills.total, v: bills.vendorId }).from(bills).where(eq(bills.companyId, c))) {
    m.docs.set(r.id, `bill${r.ref ? ` #${r.ref}` : ` of ${formatCurrency(r.total)}`}${who(r.v)}`);
  }
  for (const r of await ctx.db
    .select({ id: vendorCredits.id, ref: vendorCredits.refNumber, total: vendorCredits.total, v: vendorCredits.vendorId })
    .from(vendorCredits)
    .where(eq(vendorCredits.companyId, c))) {
    m.docs.set(r.id, `vendor credit${r.ref ? ` #${r.ref}` : ` of ${formatCurrency(r.total)}`}${who(r.v)}`);
  }
  for (const r of await ctx.db
    .select({ id: purchaseOrders.id, ref: purchaseOrders.refNumber, n: purchaseOrders.poNumber, v: purchaseOrders.vendorId })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.companyId, c)))) {
    m.docs.set(r.id, `purchase order #${r.ref ?? r.n}${who(r.v)}`);
  }
  return m;
}

/** Add the records a changes file creates (so the review can name them). */
export function addFileLabels(m: LabelMaps, file: Pick<ChangesFileBody, 'accounts' | 'classes' | 'names' | 'documents'>): void {
  for (const a of file.accounts) if (a.op === 'add') m.accounts.set(a.id, `${a.after.code} · ${a.after.name}`);
  for (const c of file.classes) m.classes.set(c.id, c.name);
  for (const n of file.names) {
    if (n.op !== 'add') continue;
    const label = String(n.after.displayName ?? n.after.name ?? '');
    if (n.type === 'item') m.items.set(n.id, label);
    else m.names.set(n.id, label);
  }
  const who = (id: unknown) => (typeof id === 'string' && m.names.get(id) ? ` (${m.names.get(id)})` : '');
  for (const d of file.documents) {
    if (d.op !== 'add') continue;
    const p = d.after;
    const ref = (k: string) => (p[k] ? ` #${p[k]}` : '');
    const text: Partial<Record<string, string>> = {
      invoice: `new invoice${ref('refNumber')}${who(p.customerId)}`,
      credit_memo: `new credit memo${ref('refNumber')}${who(p.customerId)}`,
      sales_receipt: `new sales receipt${ref('refNumber')}${who(p.customerId)}`,
      payment_received: `new payment of ${formatCurrency(String(p.amount ?? '0'))}${who(p.customerId)}`,
      bill: `new bill${ref('billNumber')}${who(p.vendorId)}`,
      vendor_credit: `new vendor credit${ref('refNumber')}${who(p.vendorId)}`,
      purchase_order: `new purchase order${ref('refNumber')}${who(p.vendorId)}`,
    };
    if (text[d.type]) m.docs.set(d.id, text[d.type]!);
  }
}

export function labelsOf(m: LabelMaps): Labels {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    account: (id) => (id ? m.accounts.get(s(id)) ?? '(an account not in this file)' : '(no account)'),
    cls: (id) => m.classes.get(s(id)) ?? '?',
    name: (id) => (id ? m.names.get(s(id)) ?? '(a name not in this file)' : '(no name)'),
    item: (id) => (id ? m.items.get(s(id)) ?? '(an item not in this file)' : '(no item)'),
    doc: (id) => m.docs.get(s(id)) ?? '(a form not in this file)',
  };
}
