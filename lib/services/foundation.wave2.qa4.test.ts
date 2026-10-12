/**
 * Wave-2 GL foundation — independent QA, round 4 (re-test after fix round 2).
 *
 * Fix round 2 claims:
 *  - I11: AI proposals approved after a merge follow the merge (chains too) to the kept
 *    customer / vendor; other inactive names are refused. Manual journal entries refuse
 *    inactive names; editing an entry may keep a name already on it.
 *  - A3: the typed number (docRef) is shown on aging detail, statements (invoice + credit
 *    memo rows), open-item statement, open invoices, collections and on the GL
 *    descriptions / references of invoices, credit memos and sales receipts.
 *
 * Every test checks that a refusal leaves nothing behind (A/R, A/P GL == aging; TB balanced;
 * proposal still pending) and that a post lands on the right name.
 *
 * Hermetic: one throwaway PGlite data dir, removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, aiProposals, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer, deactivateCustomer } from './customers';
import { createVendor, deactivateVendor } from './vendors';
import { createManualEntry, updateEntry } from './journal';
import { apAging, arAging, collectionsReport, openInvoices } from './reportsExtra';
import { trialBalance } from './reports';
import { mergeCustomers, mergeVendors } from './merge';
import { approveProposal, createJournalProposal } from './aiAssistant';
import { createInvoice } from './invoices';
import { createSalesReceipt } from './salesReceipts';
import { createCreditMemo } from './creditMemos';
import { customerStatement, openItemStatement } from './statements';
import { createTemplate, runTemplateNow } from './recurring';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-qa4');

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const D = new Date(2026, 11, 31);

async function idByCode(c: string) {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c)));
  return row?.id;
}

async function controlOf(subtype: 'accounts_receivable' | 'accounts_payable', asOf: Date): Promise<number> {
  const tb = await trialBalance(ctx, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.subtype} = ${subtype}`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  const natural = subtype === 'accounts_receivable' ? total : -total;
  return Math.round(natural * 100) / 100;
}

async function arGap(asOf = D) {
  return Math.round(((await controlOf('accounts_receivable', asOf)) - Number((await arAging(ctx, asOf)).totals.total)) * 100) / 100;
}
async function apGap(asOf = D) {
  return Math.round(((await controlOf('accounts_payable', asOf)) - Number((await apAging(ctx, asOf)).totals.total)) * 100) / 100;
}
async function tbBalanced(asOf = D) {
  const tb = await trialBalance(ctx, asOf);
  let dr = 0;
  let cr = 0;
  for (const r of tb.rows) {
    dr += Number(r.debit);
    cr += Number(r.credit);
  }
  return Math.round((dr - cr) * 100) === 0;
}
async function linesOn(type: string, id: string) {
  return db
    .select({ id: journalEntryLines.id })
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.entityType, type), eq(journalEntryLines.entityId, id)));
}
async function statusOf(proposalId: string) {
  const [r] = await db.select({ status: aiProposals.status }).from(aiProposals).where(eq(aiProposals.id, proposalId));
  return r?.status;
}

const arProposal = (name: string, amount: string) => ({
  type: 'journal_entry',
  date: '2026-08-10',
  description: 'QA4 AI fee',
  lines: [
    { accountCode: '1200', debit: amount, name },
    { accountCode: '4000', credit: amount },
  ],
});
const apProposal = (name: string, amount: string) => ({
  type: 'journal_entry',
  date: '2026-08-10',
  description: 'QA4 AI accrual',
  lines: [
    { accountCode: '6000', debit: amount },
    { accountCode: '2000', credit: amount, name },
  ],
});

const LINE = [{ quantity: 1, rate: '100.00' }];

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa4@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation QA4 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1200', '2000', '4000', '6000']) code[c] = (await idByCode(c))!;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// I11 — AI proposals and merged / inactive names
// ---------------------------------------------------------------------------

describe('QA4: AI proposals after the name list changed', () => {
  it('a customer that was only made inactive (not merged) is refused; nothing posts; proposal stays pending', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA4 Gone Inactive' })).id;
    const p = await createJournalProposal(ctx, arProposal('QA4 Gone Inactive', '12.00'));
    await deactivateCustomer(ctx, c);
    const g0 = await arGap();
    await expect(approveProposal(ctx, p.id)).rejects.toMatchObject({ name: 'ServiceError' });
    expect(await statusOf(p.id)).toBe('pending');
    expect(await linesOn('customer', c)).toHaveLength(0);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a chain of merges (A -> B -> C) is followed to the last kept customer', async () => {
    const a = (await createCustomer(ctx, { displayName: 'QA4 Chain A' })).id;
    const b = (await createCustomer(ctx, { displayName: 'QA4 Chain B' })).id;
    const c = (await createCustomer(ctx, { displayName: 'QA4 Chain C' })).id;
    const p = await createJournalProposal(ctx, arProposal('QA4 Chain A', '21.00'));
    await mergeCustomers(ctx, { fromId: a, toId: b });
    await mergeCustomers(ctx, { fromId: b, toId: c });
    const g0 = await arGap();
    await approveProposal(ctx, p.id);
    expect(await statusOf(p.id)).toBe('approved');
    expect(await linesOn('customer', a)).toHaveLength(0);
    expect(await linesOn('customer', b)).toHaveLength(0);
    const ar = await arAging(ctx, D);
    expect(Number(ar.rows.find((r) => r.id === c)?.total ?? NaN)).toBeCloseTo(21, 2);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('merged into a customer that was later made inactive: refused, nothing posts', async () => {
    const a = (await createCustomer(ctx, { displayName: 'QA4 Dead End A' })).id;
    const b = (await createCustomer(ctx, { displayName: 'QA4 Dead End B' })).id;
    const p = await createJournalProposal(ctx, arProposal('QA4 Dead End A', '8.00'));
    await mergeCustomers(ctx, { fromId: a, toId: b });
    await deactivateCustomer(ctx, b);
    await expect(approveProposal(ctx, p.id)).rejects.toMatchObject({ name: 'ServiceError' });
    expect(await statusOf(p.id)).toBe('pending');
    expect(await linesOn('customer', a)).toHaveLength(0);
    expect(await linesOn('customer', b)).toHaveLength(0);
  });

  it('an A/P proposal follows a vendor merge; A/P aging still equals the A/P GL', async () => {
    const dup = (await createVendor(ctx, { displayName: 'QA4 Vend Dup' })).id;
    const keep = (await createVendor(ctx, { displayName: 'QA4 Vend Keep' })).id;
    const p = await createJournalProposal(ctx, apProposal('QA4 Vend Dup', '55.55'));
    await mergeVendors(ctx, { fromId: dup, toId: keep });
    const g0 = await apGap();
    await approveProposal(ctx, p.id);
    expect(await linesOn('vendor', dup)).toHaveLength(0);
    const ap = await apAging(ctx, D);
    expect(ap.rows.find((r) => r.id === dup)).toBeUndefined();
    expect(Number(ap.rows.find((r) => r.id === keep)?.total ?? NaN)).toBeCloseTo(55.55, 2);
    expect(await apGap()).toBeCloseTo(g0, 2);
  });

  it('approving twice posts once (idempotent)', async () => {
    await createCustomer(ctx, { displayName: 'QA4 Twice' });
    const p = await createJournalProposal(ctx, arProposal('QA4 Twice', '3.00'));
    await approveProposal(ctx, p.id);
    const [{ n: before }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, ctx.companyId));
    await expect(approveProposal(ctx, p.id)).rejects.toMatchObject({ name: 'ServiceError' });
    const [{ n: after }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, ctx.companyId));
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// I11 — manual journal entries and inactive names
// ---------------------------------------------------------------------------

describe('QA4: journal entries and inactive names', () => {
  it('refuses an inactive customer on A/R and an inactive vendor on an expense line', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA4 JE Inactive Cust' })).id;
    const v = (await createVendor(ctx, { displayName: 'QA4 JE Inactive Vend' })).id;
    await deactivateCustomer(ctx, c);
    await deactivateVendor(ctx, v);
    const date = new Date(2026, 7, 1);
    await expect(
      createManualEntry(ctx, {
        date,
        description: 'QA4 inactive A/R',
        lines: [
          { accountId: code['1200'], debit: '10.00', entityType: 'customer', entityId: c },
          { accountId: code['4000'], credit: '10.00' },
        ],
      }),
    ).rejects.toMatchObject({ name: 'ServiceError' });
    await expect(
      createManualEntry(ctx, {
        date,
        description: 'QA4 inactive vendor on expense',
        lines: [
          { accountId: code['6000'], debit: '10.00', entityType: 'vendor', entityId: v },
          { accountId: code['1000'], credit: '10.00' },
        ],
      }),
    ).rejects.toMatchObject({ name: 'ServiceError' });
    expect(await linesOn('customer', c)).toHaveLength(0);
    expect(await linesOn('vendor', v)).toHaveLength(0);
  });

  it('editing an entry may keep a name made inactive since, but cannot add a different inactive name', async () => {
    const keepName = (await createCustomer(ctx, { displayName: 'QA4 Edit Old Name' })).id;
    const otherInactive = (await createCustomer(ctx, { displayName: 'QA4 Edit Other Inactive' })).id;
    const date = new Date(2026, 7, 2);
    const e = await createManualEntry(ctx, {
      date,
      description: 'QA4 edit me',
      lines: [
        { accountId: code['1200'], debit: '40.00', entityType: 'customer', entityId: keepName },
        { accountId: code['4000'], credit: '40.00' },
      ],
    });
    await deactivateCustomer(ctx, keepName);
    await deactivateCustomer(ctx, otherInactive);
    const g0 = await arGap();
    const edited = await updateEntry(ctx, e.id, {
      date,
      description: 'QA4 edit me (amount changed)',
      lines: [
        { accountId: code['1200'], debit: '41.00', entityType: 'customer', entityId: keepName },
        { accountId: code['4000'], credit: '41.00' },
      ],
    });
    expect(edited.id).toBeTruthy();
    expect(await arGap()).toBeCloseTo(g0, 2);
    await expect(
      updateEntry(ctx, edited.id, {
        date,
        description: 'QA4 swap to another inactive',
        lines: [
          { accountId: code['1200'], debit: '41.00', entityType: 'customer', entityId: otherInactive },
          { accountId: code['4000'], credit: '41.00' },
        ],
      }),
    ).rejects.toMatchObject({ name: 'ServiceError' });
    expect(await linesOn('customer', otherInactive)).toHaveLength(0);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a recurring journal entry naming a merged-away customer never posts to that name', async () => {
    const dup = (await createCustomer(ctx, { displayName: 'QA4 Recurring Dup' })).id;
    const keep = (await createCustomer(ctx, { displayName: 'QA4 Recurring Keep' })).id;
    const tpl = await createTemplate(ctx, {
      name: 'QA4 monthly fee',
      docType: 'journal_entry',
      frequency: 'monthly',
      nextRunDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      template: {
        description: 'QA4 monthly fee',
        lines: [
          { accountId: code['1200'], debit: '9.00', entityType: 'customer', entityId: dup },
          { accountId: code['4000'], credit: '9.00' },
        ],
      },
    });
    await mergeCustomers(ctx, { fromId: dup, toId: keep });
    const now = new Date(Date.now() + 24 * 3600 * 1000);
    const g0 = await arGap(now);
    let posted = true;
    try {
      await runTemplateNow(ctx, tpl.id);
    } catch {
      posted = false; // refusing is acceptable; posting to the merged-away name is not
    }
    expect(await linesOn('customer', dup)).toHaveLength(0);
    expect(await arGap(now)).toBeCloseTo(g0, 2);
    if (posted) expect(await linesOn('customer', keep)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A3 — typed numbers wherever the user sees a document number
// ---------------------------------------------------------------------------

describe('QA4: typed numbers shown everywhere', () => {
  it('invoice: GL description/reference, open invoices, collections and open-item statement show the typed number', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA4 Typed Inv Cust' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: new Date(2026, 5, 1),
      dueDate: new Date(2026, 5, 2),
      refNumber: 'INV-7007',
      lines: LINE,
    });
    const [je] = await db
      .select({ description: journalEntries.description, reference: journalEntries.reference })
      .from(journalEntries)
      .where(eq(journalEntries.id, inv.postedEntryId!));
    expect(je.description).toContain('INV-7007');
    expect(je.reference).toBe('INV-7007');

    const oi = await openInvoices(ctx);
    expect(oi.rows.find((r) => r.invoiceId === inv.id)?.refNumber).toBe('INV-7007');

    const coll = await collectionsReport(ctx, D);
    const flat = JSON.stringify(coll);
    expect(flat).toContain('"refNumber":"INV-7007"');

    const ois = await openItemStatement(ctx, cust, D);
    expect(ois.lines.find((l) => l.invoiceId === inv.id)?.refNumber).toBe('INV-7007');
  });

  it('credit memo: statement row and GL show the typed number', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA4 Typed CM Cust' })).id;
    const cm = await createCreditMemo(ctx, {
      customerId: cust,
      date: new Date(2026, 5, 3),
      refNumber: 'CM-ALPHA',
      lines: LINE,
    });
    const st = await customerStatement(ctx, cust, { from: new Date(2026, 0, 1), to: D });
    const row = st.lines.find((l) => l.type === 'credit_memo');
    expect(row?.ref).toBe('CM-ALPHA');
    const [je] = await db
      .select({ description: journalEntries.description, reference: journalEntries.reference })
      .from(journalEntries)
      .where(eq(journalEntries.id, cm.postedEntryId!));
    expect(je.description).toContain('CM-ALPHA');
    expect(je.reference).toBe('CM-ALPHA');
  });

  it('sales receipt: GL description/reference show the typed number', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA4 Typed SR Cust' })).id;
    const sr = await createSalesReceipt(ctx, {
      customerId: cust,
      date: new Date(2026, 5, 4),
      refNumber: 'SR 12/A',
      depositAccountId: code['1000'],
      lines: LINE,
    });
    const [je] = await db
      .select({ description: journalEntries.description, reference: journalEntries.reference })
      .from(journalEntries)
      .where(eq(journalEntries.id, sr.postedEntryId!));
    expect(je.description).toContain('SR 12/A');
    expect(je.reference).toBe('SR 12/A');
    expect(await tbBalanced()).toBe(true);
  });

  it('a document saved without a typed number still shows its number (not blank)', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'QA4 Untyped Cust' })).id;
    const inv = await createInvoice(ctx, { customerId: cust, date: new Date(2026, 5, 5), lines: LINE });
    const oi = await openInvoices(ctx);
    const r = oi.rows.find((x) => x.invoiceId === inv.id);
    expect(r?.refNumber).toBeTruthy();
    expect(r?.refNumber).toBe(inv.refNumber ?? String(inv.invoiceNumber));
  });
});
