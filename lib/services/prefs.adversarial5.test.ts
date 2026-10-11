/**
 * Wave 2 prefs QA re-test (adversarial5), after fix round 4.
 *
 * Earlier rounds covered payroll preference accounts, memorized-transaction runs, to-dos and
 * twice-a-month schedules (all of those pass now). This file covers what had not been tested yet:
 *  - J15 letters: customer and vendor balances must add up to the A/R and A/P control accounts;
 *    merge fields in a name are not expanded; another company's records never leak
 *  - J7  reminders: "money to deposit" total == Undeposited Funds; areas hidden by permission
 *  - J6  calendar: areas hidden by permission
 *  - A2  My Preferences: per person; two quick saves never lose a setting or fail
 *  - J9  Doc Center: filing a document needs a real record of this company
 *  - J8  Lead Center: a failed conversion rolls back everything
 *  - B11 form templates: one default per form; another company's template can't be copied
 *  - view-only members never leave a change behind (same rule the round-1 to-do fix applied)
 * The books must stay balanced (TB and balance sheet) throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { accounts, attachments, formTemplates, leads, todos, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { balanceSheet, trialBalance } from './reports';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice, voidInvoice } from './invoices';
import { receivePayment } from './payments';
import { createCreditMemo } from './creditMemos';
import { createBill } from './bills';
import { createVendorCredit } from './vendorCredits';
import { listRecipients, mergeLetters } from './letters';
import { getReminders } from './reminders';
import { getCalendar } from './calendar';
import { getMyPreferences, updateMyPreferences } from './preferences';
import { saveAttachment, updateAttachment } from './attachments';
import { convertLeadToCustomer, createLead, deleteLead, updateLead } from './leads';
import { createTodo } from './todos';
import { createFormTemplate, setFormTemplateLogo, updateFormTemplate } from './formTemplates';
import type { ServiceContext } from './_base';
import { calendarQuerySchema } from '@/lib/validation/prefs';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const FAKE_ID = '00000000-0000-4000-8000-000000000000';
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

async function books() {
  const tb = await trialBalance(t.ctx);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(t.ctx);
  expect(bs.balanced).toBe(true);
}

async function balanceOf(code: string): Promise<string> {
  const [row] = await t.db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(and(eq(accounts.companyId, t.ctx.companyId), eq(accounts.code, code)));
  return Money.of(row.balance).toFixed(2);
}

/** A member who can see everything except the given areas (permission-model context). */
function withoutAreas(...hidden: string[]): ServiceContext {
  const all = ['customers', 'vendors', 'banking', 'lists', 'inventory', 'payroll', 'accounting', 'company', 'reports'];
  const permissions: Record<string, string[]> = {};
  for (const a of all) if (!hidden.includes(a)) permissions[a] = ['view', 'create', 'modify', 'delete', 'print'];
  return {
    ...t.ctx,
    access: { roleKeys: ['custom'], permissions, flags: {}, isAdmin: false } as unknown as NonNullable<ServiceContext['access']>,
  };
}

beforeAll(async () => {
  t = await makeTestCompany('prefs-adv5');
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
});

// ---------------------------------------------------------------------------
// J15 letters — balances must tie to the control accounts
// ---------------------------------------------------------------------------
describe('letters: recipient balances tie to the books', () => {
  it('customer balances add up to Accounts Receivable (partial, over-payment, void, credit memo)', async () => {
    const a = await createCustomer(t.ctx, { displayName: 'Ledger Partial Co' });
    const b = await createCustomer(t.ctx, { displayName: 'Ledger Overpaid Co' });
    const c = await createCustomer(t.ctx, { displayName: 'Ledger Voided Co' });
    const d = await createCustomer(t.ctx, { displayName: 'Ledger Credited Co' });
    const line = (rate: string) => [{ description: 'Work', quantity: '1', rate }];

    const ia = await createInvoice(t.ctx, { customerId: a.id, date: day('2026-01-05'), dueDate: day('2026-02-04'), lines: line('200.00') });
    await receivePayment(t.ctx, {
      customerId: a.id, date: day('2026-02-10'), method: 'check', amount: '50.00',
      applications: [{ invoiceId: ia.id, amountApplied: '50.00' }],
    });
    const ib = await createInvoice(t.ctx, { customerId: b.id, date: day('2026-01-05'), dueDate: day('2026-02-04'), lines: line('100.00') });
    await receivePayment(t.ctx, {
      customerId: b.id, date: day('2026-02-10'), method: 'check', amount: '150.00',
      applications: [{ invoiceId: ib.id, amountApplied: '100.00' }],
    });
    const ic = await createInvoice(t.ctx, { customerId: c.id, date: day('2026-01-05'), dueDate: day('2026-02-04'), lines: line('80.00') });
    await voidInvoice(t.ctx, ic.id);
    await createInvoice(t.ctx, { customerId: d.id, date: day('2026-01-05'), dueDate: day('2026-02-04'), lines: line('100.00') });
    await createCreditMemo(t.ctx, { customerId: d.id, date: day('2026-02-15'), lines: [{ description: 'Credit', quantity: '1', rate: '30.00' }] });

    const rec = await listRecipients(t.ctx, { type: 'customer', includeInactive: true, today: '2026-06-01' });
    const byName = Object.fromEntries(rec.map((r) => [r.name, r]));
    expect(byName['Ledger Partial Co'].balance).toBe('150.00');
    expect(byName['Ledger Overpaid Co'].balance).toBe('-50.00');
    expect(byName['Ledger Voided Co'].balance).toBe('0.00');
    expect(byName['Ledger Credited Co'].balance).toBe('70.00');
    for (const r of rec) {
      // overdue is never negative and never more than what is owed
      expect(Money.of(r.overdueBalance!).isNegative()).toBe(false);
      if (Money.of(r.balance!).greaterThan(0)) expect(Money.of(r.overdueBalance!).lte(Money.of(r.balance!))).toBe(true);
      else expect(r.overdueBalance).toBe('0.00');
    }
    const sum = rec.reduce((s, r) => s.plus(Money.of(r.balance!)), Money.zero());
    expect(sum.toFixed(2)).toBe(await balanceOf('1200'));
    await books();
  });

  it('vendor balances are net of unapplied vendor credits and add up to Accounts Payable', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Ledger Supplier LLC' });
    await createBill(t.ctx, {
      vendorId: v.id, date: day('2026-03-01'), dueDate: day('2026-03-31'),
      lines: [{ accountId: t.acct['6400'], amount: '100.00' }],
    });
    await createVendorCredit(t.ctx, { vendorId: v.id, date: day('2026-03-05'), lines: [{ accountId: t.acct['6400'], amount: '40.00' }] });

    const rec = await listRecipients(t.ctx, { type: 'vendor', includeInactive: true });
    const mine = rec.find((r) => r.id === v.id)!;
    // QB's vendor balance (and a letter that quotes it) is what you actually owe: 100 - 40.
    expect(mine.balance).toBe('60.00');
    const sum = rec.reduce((s, r) => s.plus(Money.of(r.balance ?? '0')), Money.zero());
    expect(sum.toFixed(2)).toBe(await balanceOf('2000'));
    await books();
  });

  it('merge fields inside a customer name are printed literally, not expanded', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'Evil {{balance}} {{company.phone}} Inc' });
    const [m] = await mergeLetters(t.ctx, { recipientType: 'customer', recipientIds: [c.id], body: 'Dear {{recipient.name}}, you owe {{balance}}.', date: '2026-06-01' });
    expect(m.body).toContain('Dear Evil {{balance}} {{company.phone}} Inc,');
    expect(m.body).toContain('you owe $0.00.');
  });

  it("another company's customers never appear in letters, labels or recipients", async () => {
    const [u] = await t.db.insert(users).values({ email: `other-${Date.now()}@test.local`, name: 'Other', passwordHash: 'x' }).returning();
    const other = await createCompany(t.db, { name: 'Other Co', ownerId: u.id });
    const otherCtx: ServiceContext = { db: t.db, companyId: other.id, userId: u.id };
    const secret = await createCustomer(otherCtx, { displayName: 'Secret Customer of Other Co' });
    await expect(
      mergeLetters(t.ctx, { recipientType: 'customer', recipientIds: [secret.id], body: '{{recipient.name}} {{balance}}' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const rec = await listRecipients(t.ctx, { type: 'customer', includeInactive: true, ids: [secret.id] });
    expect(rec).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// J7 reminders / J6 calendar
// ---------------------------------------------------------------------------
describe('reminders and calendar', () => {
  it('"Money to deposit" total equals the Undeposited Funds balance', async () => {
    const r = await getReminders(t.ctx, { today: '2026-06-01' });
    const sec = r.sections.find((s) => s.key === 'moneyToDeposit');
    const uf = await balanceOf('1050');
    if (Money.of(uf).isZero()) expect(sec).toBeUndefined();
    else expect(sec?.total).toBe(uf);
  });

  it('a member who cannot see customers gets no invoice reminders or invoice calendar entries', async () => {
    const ctx = withoutAreas('customers');
    const r = await getReminders(ctx, { today: '2026-06-01' });
    for (const s of r.sections) expect(['overdueInvoices', 'invoicesToPrint', 'salesReceiptsToPrint', 'salesOrdersToPrint']).not.toContain(s.key);
    const cal = await getCalendar(ctx, { from: '2026-01-01', to: '2026-06-30', today: '2026-06-01' });
    const kinds = new Set(cal.days.flatMap((d) => d.events.map((e) => e.kind)));
    for (const k of ['invoice', 'payment', 'sales_receipt', 'estimate', 'sales_order']) expect(kinds.has(k as never)).toBe(false);
    // the owner does see them (the filter is not simply empty)
    const full = await getCalendar(t.ctx, { from: '2026-01-01', to: '2026-06-30', today: '2026-06-01' });
    expect(full.days.flatMap((d) => d.events).some((e) => e.kind === 'invoice')).toBe(true);
  });

  it('a member who cannot see vendors or banking gets no bill/check/deposit reminders', async () => {
    const ctx = withoutAreas('vendors', 'banking');
    const r = await getReminders(ctx, { today: '2026-06-01' });
    for (const s of r.sections) expect(['billsToPay', 'purchaseOrdersToPrint', 'checksToPrint', 'moneyToDeposit']).not.toContain(s.key);
    const cal = await getCalendar(ctx, { from: '2026-01-01', to: '2026-06-30', today: '2026-06-01' });
    const kinds = new Set(cal.days.flatMap((d) => d.events.map((e) => e.kind)));
    for (const k of ['bill', 'purchase_order', 'check', 'deposit']) expect(kinds.has(k as never)).toBe(false);
  });

  it('rejects impossible calendar ranges', async () => {
    // impossible dates are stopped by the route schema (the service only checks the shape)
    expect(calendarQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ from: '2026-03-01', to: '2026-13-01' }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ from: '2026-03-01', to: '2026-03-31' }).success).toBe(true);
    await expect(getCalendar(t.ctx, { from: '2026-03-02', to: '2026-03-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(getCalendar(t.ctx, { from: '2020-01-01', to: '2026-03-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
// A2 My Preferences
// ---------------------------------------------------------------------------
describe('My Preferences', () => {
  it("one person's settings never change another person's", async () => {
    const a = await addMember(t, 'accountant', 'mp-a');
    const b = await addMember(t, 'accountant', 'mp-b');
    const before = await getMyPreferences(b);
    await updateMyPreferences(a, { spellCheckEnabled: !before.spellCheckEnabled, beepOnRecord: !before.beepOnRecord });
    expect(await getMyPreferences(b)).toEqual(before);
    expect((await getMyPreferences(a)).spellCheckEnabled).toBe(!before.spellCheckEnabled);
  });

  it('two quick saves of different settings (first save for this person) both stick, no error', async () => {
    const u = await addMember(t, 'accountant', 'mp-race');
    const base = await getMyPreferences(u);
    const res = await Promise.allSettled([
      updateMyPreferences(u, { spellCheckEnabled: !base.spellCheckEnabled }),
      updateMyPreferences(u, { beepOnRecord: !base.beepOnRecord }),
    ]);
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const after = await getMyPreferences(u);
    expect(after.spellCheckEnabled).toBe(!base.spellCheckEnabled);
    expect(after.beepOnRecord).toBe(!base.beepOnRecord);
  });

  it('unknown keys are dropped and cannot overwrite company preferences', async () => {
    const u = await addMember(t, 'viewer', 'mp-viewer');
    const saved = await updateMyPreferences(u, { closingDate: '2099-01-01', isAdmin: true } as never);
    expect((saved as unknown as Record<string, unknown>).closingDate).toBeUndefined();
    expect((saved as unknown as Record<string, unknown>).isAdmin).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// J9 Doc Center
// ---------------------------------------------------------------------------
describe('Doc Center filing', () => {
  it('filing an inbox document needs a real record of this company; a refused filing leaves it in the inbox', async () => {
    const doc = await saveAttachment(t.ctx, { filename: 'receipt.png', mimeType: 'image/png', base64: PNG_1PX });
    expect(doc.entityId).toBeNull();
    await expect(updateAttachment(t.ctx, doc.id, { entityType: 'invoice', entityId: FAKE_ID })).rejects.toMatchObject({
      code: expect.stringMatching(/VALIDATION|NOT_FOUND/),
    });
    await expect(updateAttachment(t.ctx, doc.id, { entityType: 'no_such_thing', entityId: FAKE_ID })).rejects.toMatchObject({
      code: expect.stringMatching(/VALIDATION|NOT_FOUND/),
    });
    const [row] = await t.db.select().from(attachments).where(eq(attachments.id, doc.id));
    expect(row.entityId).toBeNull();
    // a real record works
    const cust = await createCustomer(t.ctx, { displayName: 'Doc Center Filing Co' });
    const filed = await updateAttachment(t.ctx, doc.id, { entityType: 'customer', entityId: cust.id });
    expect(filed.entityId).toBe(cust.id);
  });

  it('a view-only member cannot re-file or re-describe a document (nothing changes)', async () => {
    const doc = await saveAttachment(t.ctx, { filename: 'note.png', mimeType: 'image/png', base64: PNG_1PX, description: 'orig' });
    const viewer = await addMember(t, 'viewer', 'doc-viewer');
    await expect(updateAttachment(viewer, doc.id, { description: 'hijacked' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [row] = await t.db.select().from(attachments).where(eq(attachments.id, doc.id));
    expect(row.description).toBe('orig');
  });
});

// ---------------------------------------------------------------------------
// J8 Lead Center
// ---------------------------------------------------------------------------
describe('Lead Center', () => {
  it('a conversion that fails (name already a customer) changes nothing: lead stays a lead, to-dos stay on it', async () => {
    await createCustomer(t.ctx, { displayName: 'Taken Name LLC' });
    const lead = await createLead(t.ctx, { name: 'Pat', companyName: 'Taken Name LLC' });
    const todo = await createTodo(t.ctx, { title: 'Call Pat', entityType: 'lead', entityId: lead.id });
    await expect(convertLeadToCustomer(t.ctx, lead.id)).rejects.toBeTruthy();
    const [l] = await t.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.convertedCustomerId).toBeNull();
    expect(l.isActive).toBe(true);
    const [td] = await t.db.select().from(todos).where(eq(todos.id, todo.id));
    expect(td.entityType).toBe('lead');
    expect(td.entityId).toBe(lead.id);
  });

  it('a view-only member cannot delete or edit a lead (the lead and its to-dos survive)', async () => {
    const lead = await createLead(t.ctx, { name: 'Survivor Sam' });
    const todo = await createTodo(t.ctx, { title: 'Email Sam', entityType: 'lead', entityId: lead.id });
    const viewer = await addMember(t, 'viewer', 'lead-viewer5');
    await expect(updateLead(viewer, lead.id, { name: 'hijacked' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteLead(viewer, lead.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [l] = await t.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l?.name).toBe('Survivor Sam');
    const [td] = await t.db.select().from(todos).where(eq(todos.id, todo.id));
    expect(td).toBeDefined();
  });

  it('rejects malformed lead input', async () => {
    await expect(createLead(t.ctx, { name: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createLead(t.ctx, { name: 'x', email: 'not-an-email' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createLead(t.ctx, { name: 'x', status: 'boiling' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
// B11 form templates
// ---------------------------------------------------------------------------
describe('form templates', () => {
  it('two templates made default at the same moment leave exactly one default', async () => {
    const res = await Promise.allSettled([
      createFormTemplate(t.ctx, { formType: 'invoice', name: 'Race A', isDefault: true }),
      createFormTemplate(t.ctx, { formType: 'invoice', name: 'Race B', isDefault: true }),
    ]);
    expect(res.some((r) => r.status === 'fulfilled')).toBe(true);
    const defs = await t.db
      .select()
      .from(formTemplates)
      .where(and(eq(formTemplates.companyId, t.ctx.companyId), eq(formTemplates.formType, 'invoice'), eq(formTemplates.isDefault, true)));
    expect(defs.length).toBe(1);
    // switching the default moves it
    const c = await createFormTemplate(t.ctx, { formType: 'invoice', name: 'Race C' });
    await updateFormTemplate(t.ctx, c.id, { isDefault: true });
    const after = await t.db
      .select({ id: formTemplates.id })
      .from(formTemplates)
      .where(and(eq(formTemplates.companyId, t.ctx.companyId), eq(formTemplates.formType, 'invoice'), eq(formTemplates.isDefault, true)));
    expect(after.map((r) => r.id)).toEqual([c.id]);
  });

  it("cannot copy another company's template", async () => {
    const [u] = await t.db.insert(users).values({ email: `ft-${Date.now()}@test.local`, name: 'FT', passwordHash: 'x' }).returning();
    const other = await createCompany(t.db, { name: 'FT Other Co', ownerId: u.id });
    const theirs = await createFormTemplate({ db: t.db, companyId: other.id, userId: u.id }, { formType: 'invoice', name: 'Theirs' });
    await expect(createFormTemplate(t.ctx, { formType: 'invoice', name: 'Mine', copyFromId: theirs.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a logo that is not really an image', async () => {
    const tpl = await createFormTemplate(t.ctx, { formType: 'estimate', name: 'Logo test' });
    const html = Buffer.from('<html><script>x</script></html>').toString('base64');
    await expect(setFormTemplateLogo(t.ctx, tpl.id, { filename: 'logo.png', mimeType: 'image/png', base64: html })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(setFormTemplateLogo(t.ctx, tpl.id, { filename: 'logo.svg', mimeType: 'image/svg+xml', base64: html })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a view-only member cannot create a template or set a logo (nothing is left behind)', async () => {
    const viewer = await addMember(t, 'viewer', 'ft-viewer');
    const tpl = await createFormTemplate(t.ctx, { formType: 'statement', name: 'Viewer target' });
    const filesBefore = (await t.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.companyId, t.ctx.companyId))).length;
    await expect(setFormTemplateLogo(viewer, tpl.id, { filename: 'l.png', mimeType: 'image/png', base64: PNG_1PX })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const filesAfter = (await t.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.companyId, t.ctx.companyId))).length;
    expect(filesAfter).toBe(filesBefore);
    const [row] = await t.db.select().from(formTemplates).where(eq(formTemplates.id, tpl.id));
    expect(row.logoAttachmentId).toBeNull();

    await expect(createFormTemplate(viewer, { formType: 'statement', name: 'Viewer made' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const made = await t.db.select().from(formTemplates).where(and(eq(formTemplates.companyId, t.ctx.companyId), eq(formTemplates.name, 'Viewer made')));
    expect(made.length).toBe(0);
  });
});

describe('books after the whole run', () => {
  it('TB and balance sheet balanced', async () => {
    await books();
  });
});
