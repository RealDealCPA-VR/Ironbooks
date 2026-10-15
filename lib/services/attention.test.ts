/**
 * "Needs attention" inbox (team home): every item kind from seeded data, most-urgent-first
 * ordering, per-person snooze / dismiss, permission filtering, the one-click actions
 * (categorize, mark done, back up now, payment reminder without SMTP) and the route map.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { BUILTIN_ROLES, unionRoles } from '@/lib/permissions/model';
import { apiRuleFor } from '@/lib/permissions/routes';
import { bankAccounts, bankTransactions, companies, errorDetections } from '@/lib/db/schema';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { receivePayment } from './payments';
import { postJournalEntry } from './posting';
import { categorize } from './bankCategorize';
import { createTodo, updateTodo } from './todos';
import {
  ATTENTION_KINDS,
  attentionCount,
  backupNow,
  getAttention,
  lastMonthEnd,
  paymentReminderText,
  sendPaymentReminder,
  setAttentionState,
  type AttentionItem,
  type AttentionKind,
} from './attention';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';
import type { ServiceContext } from './_base';

let t: TestCompany;
let other: ServiceContext;
const TODAY = '2026-06-15';
const NOW = new Date('2026-06-15T12:00:00.000Z');
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ids: Record<string, string> = {};

const kinds = (items: AttentionItem[]) => new Set(items.map((i) => i.kind));
const ofKind = (items: AttentionItem[], k: AttentionKind) => items.filter((i) => i.kind === k);
const roleCtx = (key: string): ServiceContext => ({ ...t.ctx, access: unionRoles(BUILTIN_ROLES.filter((r) => r.key === key)) });

describe('Needs attention inbox (integration)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('attention');
    other = await addMember(t, 'admin', 'teammate');
    // The company file is older than a week and has never been backed up.
    await t.db.update(companies).set({ createdAt: day('2026-04-01') }).where(eq(companies.id, t.ctx.companyId));

    // ---- Bank feed: one line sorted earlier (history), two waiting.
    const [ba] = await t.db
      .insert(bankAccounts)
      .values({ companyId: t.ctx.companyId, accountId: t.acct['1000'], bankName: 'First Bank', accountNumber: '000123' })
      .returning();
    ids.bankAccount = ba.id;
    const [old] = await t.db
      .insert(bankTransactions)
      .values({ companyId: t.ctx.companyId, bankAccountId: ba.id, date: day('2026-04-10'), description: 'COFFEE SHOP #12', payee: 'Coffee Shop', amount: '-12.00' })
      .returning();
    await categorize(t.ctx, { bankTransactionId: old.id, accountId: t.acct['6300'] });
    const [coffee] = await t.db
      .insert(bankTransactions)
      .values({ companyId: t.ctx.companyId, bankAccountId: ba.id, date: day('2026-06-01'), description: 'COFFEE SHOP #12', payee: 'Coffee Shop', amount: '-45.00' })
      .returning();
    ids.coffee = coffee.id;
    const [dep] = await t.db
      .insert(bankTransactions)
      .values({ companyId: t.ctx.companyId, bankAccountId: ba.id, date: day('2026-06-14'), description: 'MOBILE DEPOSIT', amount: '500.00', suggestedAccountId: t.acct['4100'] })
      .returning();
    ids.deposit = dep.id;

    // ---- Customers: one invoice 45 days late, one 5 days late (partly paid, payment undeposited).
    const cust = await createCustomer(t.ctx, { displayName: 'Late Payer LLC', email: 'ap@latepayer.test' });
    const inv1 = await createInvoice(t.ctx, {
      customerId: cust.id,
      date: day('2026-04-01'),
      dueDate: day('2026-05-01'),
      lines: [{ description: 'Old work', quantity: '1', rate: '300.00' }],
    });
    ids.inv1 = (inv1 as { id: string }).id;
    const inv2 = await createInvoice(t.ctx, {
      customerId: cust.id,
      date: day('2026-05-10'),
      dueDate: day('2026-06-10'),
      lines: [{ description: 'New work', quantity: '1', rate: '250.00' }],
    });
    ids.inv2 = (inv2 as { id: string }).id;
    await createInvoice(t.ctx, {
      customerId: cust.id,
      date: day('2026-06-10'),
      dueDate: day('2026-07-10'),
      lines: [{ description: 'Not due yet', quantity: '1', rate: '99.00' }],
    });
    await receivePayment(t.ctx, {
      customerId: cust.id,
      date: day('2026-06-05'),
      method: 'check',
      amount: '100.00',
      applications: [{ invoiceId: ids.inv2, amountApplied: '100.00' }],
    });

    // ---- Vendors: one bill 5 days overdue, one due in 5 days, one far off.
    const vendor = await createVendor(t.ctx, { displayName: 'Power Co' });
    ids.vendor = vendor.id;
    const b1 = await createBill(t.ctx, { vendorId: vendor.id, billNumber: 'P-1', date: day('2026-05-10'), dueDate: day('2026-06-10'), lines: [{ accountId: t.acct['6600'], amount: '120.00' }] });
    ids.bill1 = (b1 as { id: string }).id;
    await createBill(t.ctx, { vendorId: vendor.id, billNumber: 'P-2', date: day('2026-06-01'), dueDate: day('2026-06-20'), lines: [{ accountId: t.acct['6600'], amount: '80.00' }] });
    await createBill(t.ctx, { vendorId: vendor.id, billNumber: 'P-3', date: day('2026-06-01'), dueDate: day('2026-07-30'), lines: [{ accountId: t.acct['6600'], amount: '70.00' }] });

    // ---- Error scan findings: one critical, one low, one already fixed.
    const [crit] = await t.db
      .insert(errorDetections)
      .values({ companyId: t.ctx.companyId, errorType: 'unbalanced', severity: 'critical', description: 'Entry #9 is off by $10.00' })
      .returning();
    ids.crit = crit.id;
    await t.db.insert(errorDetections).values({ companyId: t.ctx.companyId, errorType: 'missing_field', severity: 'low', description: 'Entry #3 has no description' });
    await t.db.insert(errorDetections).values({ companyId: t.ctx.companyId, errorType: 'duplicate', severity: 'high', description: 'Fixed already', resolvedAt: day('2026-06-01') });

    // ---- Payroll liabilities: April accrual paid in May; May accrual (200) due June 15.
    await postJournalEntry(t.ctx, { date: day('2026-04-20'), description: 'Payroll April', lines: [{ accountId: t.acct['6500'], debit: '300.00' }, { accountId: t.acct['2300'], credit: '300.00' }] });
    await postJournalEntry(t.ctx, { date: day('2026-05-10'), description: 'Deposit April taxes', lines: [{ accountId: t.acct['2300'], debit: '300.00' }, { accountId: t.acct['1000'], credit: '300.00' }] });
    await postJournalEntry(t.ctx, { date: day('2026-05-20'), description: 'Payroll May', lines: [{ accountId: t.acct['6500'], debit: '200.00' }, { accountId: t.acct['2300'], credit: '200.00' }] });

    // ---- To-dos: mine overdue, mine later, a teammate's overdue one.
    const todo = await createTodo(t.ctx, { title: 'Call Late Payer about invoice', dueDate: '2026-06-14', kind: 'call' });
    ids.todo = todo.id;
    await createTodo(t.ctx, { title: 'Plan next year', dueDate: '2026-09-01' });
    await createTodo(t.ctx, { title: "Teammate's errand", dueDate: '2026-06-10', assignedUserId: other.userId });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it('returns every item kind from seeded data', async () => {
    const r = await getAttention(t.ctx, { today: TODAY, now: NOW });
    expect(r.asOf).toBe(TODAY);
    expect([...kinds(r.items)].sort()).toEqual([...ATTENTION_KINDS].sort());

    // Bank feed: the two unsorted lines, suggestion from history (Coffee Shop → 6300) and the rule.
    const bank = ofKind(r.items, 'bank_txn');
    expect(bank.map((i) => i.data.bankTransactionId).sort()).toEqual([ids.coffee, ids.deposit].sort());
    const coffee = bank.find((i) => i.data.bankTransactionId === ids.coffee)!;
    expect(coffee.amount).toBe('45.00');
    expect(coffee.data.direction).toBe('out');
    expect(coffee.data.suggestedAccountId).toBe(t.acct['6300']);
    expect(coffee.data.suggestionSource).toBe('history');
    expect(bank.find((i) => i.data.bankTransactionId === ids.deposit)!.data.suggestionSource).toBe('rule');
    expect(r.accountOptions.some((a) => a.id === t.acct['6300'])).toBe(true);

    // Overdue invoices with days overdue; the not-yet-due one is left out.
    const inv = ofKind(r.items, 'overdue_invoice');
    expect(inv).toHaveLength(2);
    const first = inv.find((i) => i.data.invoiceId === ids.inv1)!;
    expect(first.data.daysOverdue).toBe(45);
    expect(first.amount).toBe('300.00');
    expect(first.title).toMatch(/45 days late/);
    expect((first.data.reminder as { body: string }).body).toMatch(/\$300\.00/);
    expect(inv.find((i) => i.data.invoiceId === ids.inv2)!.amount).toBe('150.00');

    // Bills: overdue + due within 7 days; the July one is not shown.
    const bills = ofKind(r.items, 'bill_due');
    expect(bills.map((b) => b.amount).sort()).toEqual(['120.00', '80.00']);
    const overdueBill = bills.find((b) => b.data.billId === ids.bill1)!;
    expect(overdueBill.title).toMatch(/5 days overdue/);
    expect(overdueBill.action).toEqual({ type: 'open', label: 'Pay', href: `/pay-bills?vendor=${ids.vendor}&bill=${ids.bill1}` });

    // AI review: only open findings.
    const errs = ofKind(r.items, 'ai_error');
    expect(errs.map((e) => e.data.severity).sort()).toEqual(['critical', 'low']);
    expect(errs.find((e) => e.data.severity === 'critical')!.href).toBe(`/errors?focus=${ids.crit}`);

    // Reconcile: Checking has activity since April and was never reconciled.
    const rec = ofKind(r.items, 'reconcile');
    expect(rec).toHaveLength(1);
    expect(lastMonthEnd(TODAY)).toBe('2026-05-31');
    expect(rec[0].key).toBe(`reconcile:${ids.bankAccount}:2026-05-31`);
    expect(rec[0].href).toBe(`/reconcile?account=${ids.bankAccount}&through=2026-05-31`);

    // Payroll: only May's 200.00 is still owed, due June 15.
    const pay = ofKind(r.items, 'payroll_tax');
    expect(pay).toHaveLength(1);
    expect(pay[0].amount).toBe('200.00');
    expect(pay[0].date).toBe('2026-06-15');
    expect(pay[0].title).toMatch(/May 2026/);

    // To-dos: my overdue one only.
    expect(ofKind(r.items, 'todo').map((i) => i.title)).toEqual(['Call Late Payer about invoice']);

    // Backup: never backed up, company is older than a week.
    expect(ofKind(r.items, 'backup')[0].key).toBe('backup:never');

    // Undeposited: the June 5 check (10 days old).
    const und = ofKind(r.items, 'undeposited');
    expect(und).toHaveLength(1);
    expect(und[0].amount).toBe('100.00');

    expect(r.total).toBe(r.items.length);
    expect(r.counts.bank_txn).toBe(2);
    expect(await attentionCount(t.ctx, { today: TODAY, now: NOW })).toBe(r.total);
  });

  it('orders the list most urgent first', async () => {
    const r = await getAttention(t.ctx, { today: TODAY, now: NOW });
    for (let i = 1; i < r.items.length; i++) expect(r.items[i - 1].urgency).toBeGreaterThanOrEqual(r.items[i].urgency);
    const pos = (pred: (i: AttentionItem) => boolean) => r.items.findIndex(pred);
    expect(pos((i) => i.data.severity === 'critical')).toBeLessThan(pos((i) => i.data.invoiceId === ids.inv1));
    expect(pos((i) => i.data.invoiceId === ids.inv1)).toBeLessThan(pos((i) => i.data.invoiceId === ids.inv2));
    expect(pos((i) => i.data.billId === ids.bill1)).toBeLessThan(pos((i) => i.kind === 'bill_due' && i.data.billId !== ids.bill1));
    expect(r.items[r.items.length - 1].data.severity).toBe('low');
    expect(r.items[0].severity).toBe('urgent');
  });

  it('snooze and dismiss are per person and persist', async () => {
    const key = `overdue_invoice:${ids.inv1}`;
    await setAttentionState(t.ctx, { key, action: 'snooze', days: 1 }, NOW);
    let r = await getAttention(t.ctx, { today: TODAY, now: NOW });
    expect(r.items.some((i) => i.key === key)).toBe(false);
    expect(r.hiddenCount).toBe(1);
    // Someone else still sees it.
    const theirs = await getAttention(other, { today: TODAY, now: NOW });
    expect(theirs.items.some((i) => i.key === key)).toBe(true);
    // Back after the snooze runs out.
    r = await getAttention(t.ctx, { today: TODAY, now: new Date(NOW.getTime() + 2 * 86_400_000) });
    expect(r.items.some((i) => i.key === key)).toBe(true);

    // Dismiss a bank line: it leaves the list and the count, and shows under hidden.
    const bankKey = `bank_txn:${ids.deposit}`;
    await setAttentionState(t.ctx, { key: bankKey, action: 'dismiss' }, NOW);
    r = await getAttention(t.ctx, { today: TODAY, now: new Date(NOW.getTime() + 30 * 86_400_000), includeHidden: true });
    expect(r.items.some((i) => i.key === bankKey)).toBe(false);
    expect(r.counts.bank_txn).toBe(1);
    expect(r.hidden!.find((i) => i.key === bankKey)!.hidden).toEqual({ dismissed: true, snoozedUntil: null });

    // Bring it back.
    await setAttentionState(t.ctx, { key: bankKey, action: 'restore' }, NOW);
    r = await getAttention(t.ctx, { today: TODAY, now: NOW });
    expect(r.items.some((i) => i.key === bankKey)).toBe(true);
    expect(r.counts.bank_txn).toBe(2);
    await setAttentionState(t.ctx, { key, action: 'restore' }, NOW);

    // Bad input is refused.
    await expect(setAttentionState(t.ctx, { key: 'nonsense', action: 'dismiss' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(setAttentionState(t.ctx, { key, action: 'snooze', days: 3 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('only lists what the person can act on', async () => {
    const sales = await getAttention(roleCtx('sales'), { today: TODAY, now: NOW });
    expect([...kinds(sales.items)].sort()).toEqual(['overdue_invoice', 'todo']);
    expect(sales.counts.bank_txn).toBe(0);
    expect(sales.accountOptions).toEqual([]);

    const viewer = await getAttention(roleCtx('view_only'), { today: TODAY, now: NOW });
    // Look-only roles can see invoices and errors but can't pay, sort, reconcile or back up.
    expect(kinds(viewer.items).has('bank_txn')).toBe(false);
    expect(kinds(viewer.items).has('bill_due')).toBe(false);
    expect(kinds(viewer.items).has('reconcile')).toBe(false);
    expect(kinds(viewer.items).has('backup')).toBe(false);
    expect(kinds(viewer.items).has('ai_error')).toBe(true);
    // ...and can't email reminders (View-Only has no print permission on customers).
    const inv = ofKind(viewer.items, 'overdue_invoice')[0];
    expect(inv.action.type).toBe('open');

    const banking = await getAttention(roleCtx('banking'), { today: TODAY, now: NOW });
    expect(kinds(banking.items).has('bank_txn')).toBe(true);
    expect(kinds(banking.items).has('reconcile')).toBe(true);
    expect(kinds(banking.items).has('bill_due')).toBe(false); // vendors: view only
    expect(kinds(banking.items).has('payroll_tax')).toBe(false);
  });

  it('one-click fixes clear their items', async () => {
    // Categorize inline with the suggestion.
    let r = await getAttention(t.ctx, { today: TODAY, now: NOW });
    const coffee = r.items.find((i) => i.key === `bank_txn:${ids.coffee}`)!;
    await categorize(t.ctx, { bankTransactionId: ids.coffee, accountId: coffee.data.suggestedAccountId as string });
    // Mark the to-do done.
    await updateTodo(t.ctx, ids.todo, { done: true });
    // Back up now (to a scratch folder beside the test company).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-attention-backups-'));
    try {
      const b = await backupNow(t.ctx, { dir, dataDir: t.dir });
      expect(fs.existsSync(path.join(dir, b.filename))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    r = await getAttention(t.ctx, { today: TODAY, now: NOW });
    expect(r.items.some((i) => i.key === `bank_txn:${ids.coffee}`)).toBe(false);
    expect(ofKind(r.items, 'todo')).toHaveLength(0);
    expect(ofKind(r.items, 'backup')).toHaveLength(0);
    // A week later the backup is stale again (new key, so an old dismissal wouldn't hide it).
    const later = await getAttention(t.ctx, { today: '2026-12-01', now: new Date('2026-12-01T12:00:00Z') });
    const backup = ofKind(later.items, 'backup')[0];
    expect(backup.key).not.toBe('backup:never');
  });

  it('payment reminder: plain text always, email only when SMTP is set up', async () => {
    const txt = paymentReminderText({ customerName: 'Late Payer LLC', invoiceNumber: '1001', balance: '300.00', dueDate: '2026-05-01', daysOverdue: 45, companyName: 'Acme' });
    expect(txt.subject).toBe('Payment reminder: invoice 1001 from Acme');
    expect(txt.body).toMatch(/was due on May 1, 2026 \(45 days ago\)/);
    const saved = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      await expect(sendPaymentReminder(t.ctx, ids.inv1)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/SMTP/) });
      const r = await getAttention(t.ctx, { today: TODAY, now: NOW });
      expect(r.emailConfigured).toBe(false);
    } finally {
      if (saved !== undefined) process.env.SMTP_HOST = saved;
    }
    await expect(sendPaymentReminder(t.ctx, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is company-scoped', async () => {
    const t2 = await makeTestCompany('attention-other');
    try {
      const r = await getAttention(t2.ctx, { today: TODAY, now: NOW });
      expect(r.items.filter((i) => i.kind !== 'backup')).toEqual([]);
      await expect(sendPaymentReminder(t2.ctx, ids.inv1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await t2.cleanup();
      process.env.BKA_DATA_DIR = t.dir;
    }
  });
});

describe('attention routes in the permission map', () => {
  it('maps every inbox route with the right area', () => {
    expect(apiRuleFor('/api/attention', 'GET')).toBe('member');
    expect(apiRuleFor('/api/attention/count', 'GET')).toBe('member');
    expect(apiRuleFor('/api/attention/state', 'POST')).toBe('member');
    expect(apiRuleFor('/api/attention/invoice-reminder', 'POST')).toEqual({ area: 'customers', action: 'print' });
    expect(apiRuleFor('/api/attention/backup', 'POST')).toEqual({ area: 'file_utilities', action: 'create' });
    // Unmapped methods stay denied (fail closed).
    expect(apiRuleFor('/api/attention', 'DELETE')).toBeNull();
    expect(apiRuleFor('/api/attention/backup', 'GET')).toBeNull();
  });
});
