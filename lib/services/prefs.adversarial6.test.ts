/**
 * Wave 2 prefs QA re-test (adversarial6), after fix round 5.
 *
 * Round 5 fixed: vendor letters net of vendor credits, atomic My Preferences upsert, Doc Center
 * filing checks, viewer guards on attachments / leads / form templates. This file pushes on the
 * edges of those fixes and on siblings that follow the same rules:
 *  - J15 vendor balances tie to A/P through apply / unapply / refund / void of vendor credits
 *  - A2  many overlapping My Preferences saves, including a view-only member's own settings
 *  - J9  filing to another company's record, unfiling, uploads straight to a record, viewer delete
 *  - J8  view-only members cannot add a lead or convert one
 *  - B11 view-only members cannot delete a template or remove its logo
 *  - J15 view-only members cannot add, change or delete letter templates
 * The books must stay balanced (TB and balance sheet) throughout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { accounts, attachments, customers, formTemplates, leads, letterTemplates, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { balanceSheet, trialBalance } from './reports';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { applyToBill, createVendorCredit, refundVendorCredit, unapplyFromBill, voidVendorCredit } from './vendorCredits';
import { createLetterTemplate, deleteLetterTemplate, listRecipients, updateLetterTemplate } from './letters';
import { getMyPreferences, updateMyPreferences } from './preferences';
import { deleteAttachment, listUnfiledAttachments, saveAttachment, updateAttachment } from './attachments';
import { convertLeadToCustomer, createLead } from './leads';
import { deleteFormTemplate, createFormTemplate, removeFormTemplateLogo, setFormTemplateLogo } from './formTemplates';
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

async function vendorTie(vendorId: string, expected: string) {
  const rec = await listRecipients(t.ctx, { type: 'vendor', includeInactive: true });
  expect(rec.find((r) => r.id === vendorId)!.balance).toBe(expected);
  const sum = rec.reduce((s, r) => s.plus(Money.of(r.balance ?? '0')), Money.zero());
  expect(sum.toFixed(2)).toBe(await balanceOf('2000'));
  await books();
}

async function otherCompany(label: string) {
  const [u] = await t.db
    .insert(users)
    .values({ email: `${label}-${Date.now()}-${Math.random()}@test.local`, name: label, passwordHash: 'x' })
    .returning();
  const co = await createCompany(t.db, { name: `${label} Co`, ownerId: u.id });
  return { db: t.db, companyId: co.id, userId: u.id };
}

beforeAll(async () => {
  t = await makeTestCompany('prefs-adv6');
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
});

// ---------------------------------------------------------------------------
// J15 vendor balances through the whole vendor-credit life cycle
// ---------------------------------------------------------------------------
describe('letters: vendor balances tie to A/P through credit apply / unapply / refund / void', () => {
  it('stays equal to Accounts Payable at every step', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Lifecycle Supplies' });
    const bill = await createBill(t.ctx, {
      vendorId: v.id, date: day('2026-03-01'), dueDate: day('2026-03-31'),
      lines: [{ accountId: t.acct['6400'], amount: '100.00' }],
    });
    const vc = await createVendorCredit(t.ctx, {
      vendorId: v.id, date: day('2026-03-05'), lines: [{ accountId: t.acct['6400'], amount: '40.00' }],
    });
    await vendorTie(v.id, '60.00');

    await applyToBill(t.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '25.00' });
    await vendorTie(v.id, '60.00');

    await unapplyFromBill(t.ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '25.00' });
    await vendorTie(v.id, '60.00');

    await voidVendorCredit(t.ctx, vc.id);
    await vendorTie(v.id, '100.00');
  });

  it('a vendor with only a credit shows what they owe us (negative), and a refund clears it', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Credit Only Vendor' });
    const vc = await createVendorCredit(t.ctx, {
      vendorId: v.id, date: day('2026-04-01'), lines: [{ accountId: t.acct['6400'], amount: '33.33' }],
    });
    await vendorTie(v.id, '-33.33');
    const bank = Object.entries(t.acct).find(([code]) => code === '1000')?.[1];
    expect(bank).toBeTruthy();
    await refundVendorCredit(t.ctx, { vendorCreditId: vc.id, bankAccountId: bank!, amount: '33.33', date: day('2026-04-10') });
    await vendorTie(v.id, '0.00');
  });

  it("another company's vendor credits never reduce this company's vendor balances", async () => {
    const v = await createVendor(t.ctx, { displayName: 'Isolated Vendor' });
    await createBill(t.ctx, {
      vendorId: v.id, date: day('2026-05-01'), dueDate: day('2026-05-31'),
      lines: [{ accountId: t.acct['6400'], amount: '10.00' }],
    });
    const other = await otherCompany('vc-other');
    const ov = await createVendor(other, { displayName: 'Isolated Vendor' });
    const [exp] = await t.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, other.companyId), eq(accounts.code, '6400')));
    await createVendorCredit(other, { vendorId: ov.id, date: day('2026-05-02'), lines: [{ accountId: exp.id, amount: '10.00' }] });
    await vendorTie(v.id, '10.00');
    const rec = await listRecipients(t.ctx, { type: 'vendor', includeInactive: true });
    expect(rec.some((r) => r.id === ov.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A2 My Preferences: overlapping saves
// ---------------------------------------------------------------------------
describe('My Preferences: overlapping saves', () => {
  it('six overlapping first saves of different settings all stick, none fails', async () => {
    const u = await addMember(t, 'accountant', 'burst');
    const res = await Promise.allSettled([
      updateMyPreferences(u, { spellCheckEnabled: false }),
      updateMyPreferences(u, { beepOnRecord: false }),
      updateMyPreferences(u, { spellCheckEnabled: false }),
      updateMyPreferences(u, { beepOnRecord: false }),
      updateMyPreferences(u, { spellCheckEnabled: false }),
      updateMyPreferences(u, { beepOnRecord: false }),
    ] as never[]);
    expect(res.map((r) => r.status)).toEqual(Array(6).fill('fulfilled'));
    const mine = (await getMyPreferences(u)) as unknown as Record<string, unknown>;
    expect(mine.spellCheckEnabled).toBe(false);
    expect(mine.beepOnRecord).toBe(false);
  });

  it('a later save of one setting keeps the others; the save returns the merged settings', async () => {
    const u = await addMember(t, 'accountant', 'merge');
    await updateMyPreferences(u, { spellCheckEnabled: false, beepOnRecord: false } as never);
    const out = (await updateMyPreferences(u, { beepOnRecord: true } as never)) as unknown as Record<string, unknown>;
    expect(out.spellCheckEnabled).toBe(false);
    expect(out.beepOnRecord).toBe(true);
    const mine = (await getMyPreferences(u)) as unknown as Record<string, unknown>;
    expect(mine.spellCheckEnabled).toBe(false);
    expect(mine.beepOnRecord).toBe(true);
  });

  it('a view-only member may still change their own settings', async () => {
    const v = await addMember(t, 'viewer', 'pref-viewer6');
    await updateMyPreferences(v, { spellCheckEnabled: false } as never);
    const mine = (await getMyPreferences(v)) as unknown as Record<string, unknown>;
    expect(mine.spellCheckEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// J9 Doc Center
// ---------------------------------------------------------------------------
describe('Doc Center', () => {
  it("cannot file a document to another company's record", async () => {
    const other = await otherCompany('doc-other');
    const theirs = await createCustomer(other, { displayName: 'Their Customer' });
    const doc = await saveAttachment(t.ctx, { filename: 'x.png', mimeType: 'image/png', base64: PNG_1PX });
    await expect(updateAttachment(t.ctx, doc.id, { entityType: 'customer', entityId: theirs.id })).rejects.toMatchObject({
      code: expect.stringMatching(/VALIDATION|NOT_FOUND/),
    });
    // filing to the right record type is required too: a customer id is not an invoice
    await expect(updateAttachment(t.ctx, doc.id, { entityType: 'invoice', entityId: theirs.id })).rejects.toMatchObject({
      code: expect.stringMatching(/VALIDATION|NOT_FOUND/),
    });
    const unfiled = await listUnfiledAttachments(t.ctx);
    expect(unfiled.some((d) => d.id === doc.id)).toBe(true);
  });

  it('filing to a real invoice works, and unfiling puts it back in the inbox', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'File Me Co' });
    const inv = await createInvoice(t.ctx, {
      customerId: c.id, date: day('2026-06-01'), dueDate: day('2026-06-30'),
      lines: [{ description: 'Work', quantity: '1', rate: '10.00' }],
    });
    const doc = await saveAttachment(t.ctx, { filename: 'y.png', mimeType: 'image/png', base64: PNG_1PX });
    const filed = await updateAttachment(t.ctx, doc.id, { entityType: 'invoice', entityId: inv.id });
    expect(filed.entityType).toBe('invoice');
    const back = await updateAttachment(t.ctx, doc.id, { entityType: null, entityId: null });
    expect(back.entityId).toBeNull();
    expect((await listUnfiledAttachments(t.ctx)).some((d) => d.id === doc.id)).toBe(true);
    // half a link is refused
    await expect(updateAttachment(t.ctx, doc.id, { entityType: 'invoice', entityId: null })).rejects.toMatchObject({ code: 'VALIDATION' });
    await books();
  });

  it('uploading straight to a record also needs a real record of this company (no orphaned files)', async () => {
    const other = await otherCompany('upl-other');
    const theirs = await createCustomer(other, { displayName: 'Their Upload Customer' });
    const before = (await t.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.companyId, t.ctx.companyId))).length;
    await expect(
      saveAttachment(t.ctx, { entityType: 'invoice', entityId: FAKE_ID, filename: 'o.png', mimeType: 'image/png', base64: PNG_1PX }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION|NOT_FOUND/) });
    await expect(
      saveAttachment(t.ctx, { entityType: 'customer', entityId: theirs.id, filename: 'o.png', mimeType: 'image/png', base64: PNG_1PX }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION|NOT_FOUND/) });
    const after = (await t.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.companyId, t.ctx.companyId))).length;
    expect(after).toBe(before);
  });

  it('a view-only member cannot delete a document (row and file survive) or upload one', async () => {
    const doc = await saveAttachment(t.ctx, { filename: 'keep.png', mimeType: 'image/png', base64: PNG_1PX });
    const viewer = await addMember(t, 'viewer', 'doc-del-viewer');
    await expect(deleteAttachment(viewer, doc.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [row] = await t.db.select().from(attachments).where(eq(attachments.id, doc.id));
    expect(row).toBeDefined();
    expect(fs.existsSync(path.join(t.dir, row.storagePath))).toBe(true);
    const dirBefore = fs.readdirSync(path.join(t.dir, 'attachments')).length;
    await expect(saveAttachment(viewer, { filename: 'v.png', mimeType: 'image/png', base64: PNG_1PX })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fs.readdirSync(path.join(t.dir, 'attachments')).length).toBe(dirBefore);
  });
});

// ---------------------------------------------------------------------------
// J8 Lead Center
// ---------------------------------------------------------------------------
describe('Lead Center: view-only members', () => {
  it('cannot add a lead or turn one into a customer (nothing is created)', async () => {
    const viewer = await addMember(t, 'viewer', 'lead-viewer6');
    await expect(createLead(viewer, { name: 'Viewer Lead' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const made = await t.db.select().from(leads).where(and(eq(leads.companyId, t.ctx.companyId), eq(leads.name, 'Viewer Lead')));
    expect(made.length).toBe(0);

    const lead = await createLead(t.ctx, { name: 'Convert Me', companyName: 'Convert Me Inc' });
    await expect(convertLeadToCustomer(viewer, lead.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [l] = await t.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.convertedCustomerId).toBeNull();
    const cust = await t.db
      .select()
      .from(customers)
      .where(and(eq(customers.companyId, t.ctx.companyId), eq(customers.displayName, 'Convert Me Inc')));
    expect(cust.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B11 form templates
// ---------------------------------------------------------------------------
describe('form templates: view-only members', () => {
  it('cannot delete a template or remove its logo', async () => {
    const tpl = await createFormTemplate(t.ctx, { formType: 'invoice', name: 'Keep Me' });
    await setFormTemplateLogo(t.ctx, tpl.id, { filename: 'l.png', mimeType: 'image/png', base64: PNG_1PX });
    const viewer = await addMember(t, 'viewer', 'ft-viewer6');
    await expect(removeFormTemplateLogo(viewer, tpl.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteFormTemplate(viewer, tpl.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [row] = await t.db.select().from(formTemplates).where(eq(formTemplates.id, tpl.id));
    expect(row).toBeDefined();
    expect(row.logoAttachmentId).not.toBeNull();
    const [logo] = await t.db.select().from(attachments).where(eq(attachments.id, row.logoAttachmentId!));
    expect(logo).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// J15 letter templates (same rule as round 5: a view-only member changes nothing)
// ---------------------------------------------------------------------------
describe('letter templates: view-only members change nothing', () => {
  it('cannot add, change or delete a letter template', async () => {
    const viewer = await addMember(t, 'viewer', 'letter-viewer6');
    const tpl = await createLetterTemplate(t.ctx, { category: 'customer', name: 'Thank you', body: 'Dear {{name}}, thanks.' });

    await expect(
      createLetterTemplate(viewer, { category: 'customer', name: 'Viewer letter', body: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const made = await t.db
      .select()
      .from(letterTemplates)
      .where(and(eq(letterTemplates.companyId, t.ctx.companyId), eq(letterTemplates.name, 'Viewer letter')));
    expect(made.length).toBe(0);

    await expect(updateLetterTemplate(viewer, tpl.id, { body: 'hijacked' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteLetterTemplate(viewer, tpl.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [row] = await t.db.select().from(letterTemplates).where(eq(letterTemplates.id, tpl.id));
    expect(row).toBeDefined();
    expect(row.body).toBe('Dear {{name}}, thanks.');
  });
});

describe('books after the whole run', () => {
  it('TB and balance sheet balanced', async () => {
    await books();
  });
});
