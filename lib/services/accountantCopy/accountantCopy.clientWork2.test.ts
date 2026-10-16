/**
 * Accountant's Copy (PARITY I1): more of the client's later work the import would run into. The
 * review must predict each refusal in plain language (the client's own later record and the way
 * out) and the import must refuse with the same words, leaving the books as they were:
 *
 *  - inventory the client sold in April: the accountant's edit of the February bill that received
 *    it, a void of that bill, and a new March invoice selling it;
 *  - a reconciled check changed from check to cash (same amount and account);
 *  - a reconciled bill payment with a discount whose check number changed;
 *  - a vendor credit moved to another vendor (and voided), a credit memo moved to another
 *    customer — both used by the client in April;
 *  - an item receipt the client turned into a bill in April, changed by the accountant;
 *  - a General Journal entry whose A/R credit the client applied in April, changed by the accountant.
 *
 * And no false refusal: a payment the accountant moves from one March deposit to another (the
 * client did nothing) imports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createBankAccount } from '../bankAccounts';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createItem } from '../items';
import { createInvoice } from '../invoices';
import { applyToInvoice, createCreditMemo, updateCreditMemo } from '../creditMemos';
import { receivePayment } from '../payments';
import { createBill, updateBill } from '../bills';
import { payBills, updateBillPayment } from '../billPayments';
import { applyToBill, createVendorCredit, updateVendorCredit } from '../vendorCredits';
import { convertToBill, createItemReceipt, updateItemReceipt } from '../itemReceipts';
import { createExpense, updateExpense } from '../expenses';
import { createDeposit, updateDeposit } from '../deposits';
import { createManualEntry, updateEntry } from '../journal';
import { applyJournalCredit } from '../journalApplications';
import { completeReconciliation, listClearable, startReconciliation, toggleCleared } from '../reconcile';
import { trialBalance } from '../reports';
import { accountantCopyStatus, createAccountantCopy, importChangesFile, reviewChangesFile, type ChangesReview } from './client';
import { exportChangesFile, openAccountantCopyFile } from './accountant';
import { parseChangesFile, serializeChangesFile, type ChangesFileBody } from './format';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-clientwork2');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const endOfDay = (s: string) => new Date(`${s}T23:59:59.999Z`);
const DIVIDING = '2026-03-31';

let db: DB;
let ctx: ServiceContext;
let actx: ServiceContext;
const acct: Record<string, string> = {};
const R: Record<string, string> = {};
let changes: Buffer;
let review: ChangesReview;

const svc = (desc: string, rate: string) => ({ description: desc, quantity: 1, rate, accountId: acct['4100'] });

type Body = ChangesFileBody;
function only(keep: {
  txn?: (t: Body['transactions'][number]) => boolean;
  doc?: (x: Body['documents'][number]) => boolean;
  app?: (a: Body['applications'][number]) => boolean;
}): Buffer {
  const { sha256: _s, ...body } = parseChangesFile(changes);
  const b = JSON.parse(JSON.stringify(body)) as Body;
  b.transactions = b.transactions.filter((t) => keep.txn?.(t) ?? false);
  b.documents = b.documents.filter((x) => keep.doc?.(x) ?? false);
  b.applications = b.applications.filter((a) => keep.app?.(a) ?? false);
  b.reconciliations = [];
  return serializeChangesFile(b);
}

const problemOf = (key: string, r: ChangesReview = review) => r.items.find((i) => i.key === key)?.problem ?? null;

async function refusesWith(buf: Buffer, problem: string) {
  const before = await trialBalance(ctx);
  const err = (await importChangesFile(ctx, buf).then(
    () => null,
    (e: Error) => e,
  )) as Error | null;
  expect(err).not.toBeNull();
  expect(err!.message).toContain(problem);
  expect(err!.message).toMatch(/Nothing was imported\.$/);
  expect(err!.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  expect(await trialBalance(ctx)).toEqual(before);
  expect((await accountantCopyStatus(ctx)).current?.status).toBe('outstanding');
  const r = await reviewChangesFile(ctx, buf);
  expect(r.canImport).toBe(false);
  expect(r.items.map((i) => i.problem)).toContain(problem);
}

describe("Accountant's Copy — inventory, re-posting edits and other later work of the client", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'clientwork2@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Later Work Two Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;

    R.acme = (await createCustomer(ctx, { displayName: 'Acme Corp' })).id;
    R.beta = (await createCustomer(ctx, { displayName: 'Beta LLC' })).id;
    R.supplier = (await createVendor(ctx, { displayName: 'Supplier Co' })).id;
    R.other = (await createVendor(ctx, { displayName: 'Other Vendor' })).id;
    R.bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '555555555' })).id;
    const inv = { assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'] };
    R.widget = (await createItem(ctx, { name: 'Widget', type: 'inventory', purchaseCost: '10', ...inv })).id;
    R.gadget = (await createItem(ctx, { name: 'Gadget', type: 'inventory', purchaseCost: '4', ...inv })).id;
    await createManualEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Owner investment',
      lines: [{ accountId: acct['1000'], debit: '10000.00' }, { accountId: acct['3000'], credit: '10000.00' }],
    });
    R.billW = (await createBill(ctx, { vendorId: R.supplier, billNumber: 'B-W', date: d('2026-02-10'), lines: [{ itemId: R.widget, quantity: 10, unitCost: '10' }] })).id;
    R.ir = (await createItemReceipt(ctx, { vendorId: R.supplier, date: d('2026-02-12'), reference: 'IR-1', lines: [{ itemId: R.gadget, quantity: 5, unitCost: '4' }] })).id;
    R.check = (
      await createExpense(ctx, { payeeName: 'Office Depot', date: d('2026-03-10'), method: 'check', reference: '3001', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '100' }] })
    ).id;
    R.billD = (await createBill(ctx, { vendorId: R.supplier, billNumber: 'B-D', date: d('2026-02-15'), lines: [{ accountId: acct['6300'], amount: '100' }] })).id;
    R.bp = (
      await payBills(ctx, {
        vendorId: R.supplier, date: d('2026-03-05'), method: 'check', reference: '2001', paymentAccountId: acct['1000'], discountAccountId: acct['6300'],
        applications: [{ billId: R.billD, amountApplied: '98', discountTaken: '2' }],
      })
    ).id;
    R.vc = (await createVendorCredit(ctx, { vendorId: R.supplier, date: d('2026-02-20'), refNumber: 'VC-1', lines: [{ accountId: acct['6300'], amount: '50' }] })).id;
    R.cm = (await createCreditMemo(ctx, { customerId: R.acme, date: d('2026-02-20'), refNumber: 'CM-1', lines: [svc('Goodwill', '60')] })).id;
    R.je = (
      await createManualEntry(ctx, {
        date: d('2026-02-22'),
        description: 'Courtesy credit',
        lines: [{ accountId: acct['4100'], debit: '40.00' }, { accountId: acct['1200'], credit: '40.00', entityType: 'customer', entityId: R.acme }],
      })
    ).id;
    // Two March payments deposited together on March 6.
    R.invP = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-25'), refNumber: 'F-25', lines: [svc('Late February work', '100')] })).id;
    const pay = async (ref: string, amount: string, date: string) =>
      (
        await receivePayment(ctx, {
          customerId: R.acme, date: d(date), method: 'check', reference: ref, amount, depositAccountId: acct['1050'],
          applications: [{ invoiceId: R.invP, amountApplied: amount }],
        })
      ).payment.id;
    R.p3 = await pay('P3', '60', '2026-03-02');
    R.p4 = await pay('P4', '40', '2026-03-03');
    R.depX = (await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-03-06'), paymentIds: [R.p3, R.p4], salesReceiptIds: [] })).id;

    const transfer = (await createAccountantCopy(ctx, { dividingDate: DIVIDING, dataDir: CLIENT_DIR })).buffer;
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: ctx.companyId, userId: ctx.userId };

    // ---- The client keeps working in April ----
    await createInvoice(ctx, { customerId: R.acme, date: d('2026-04-10'), refNumber: 'A-W', lines: [{ itemId: R.widget, quantity: 10, rate: '25' }] });
    await convertToBill(ctx, R.ir, { billNumber: 'IR-B', date: d('2026-04-12') });
    const billA = (await createBill(ctx, { vendorId: R.supplier, billNumber: 'B-A', date: d('2026-04-08'), lines: [{ accountId: acct['6300'], amount: '200' }] })).id;
    await applyToBill(ctx, { vendorCreditId: R.vc, billId: billA, amount: '50', date: d('2026-04-08') });
    const invA = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-04-08'), refNumber: 'A-08', lines: [svc('April work', '500')] })).id;
    await applyToInvoice(ctx, { creditMemoId: R.cm, invoiceId: invA, amount: '60', date: d('2026-04-08') });
    const [jeLine] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, R.je), eq(journalEntryLines.accountId, acct['1200'])));
    await applyJournalCredit(ctx, { journalLineId: jeLine.id, invoiceId: invA, amount: '40', date: d('2026-04-09') });
    // April statement: the owner investment, the March check and the discounted bill payment.
    const april = await startReconciliation(ctx, { bankAccountId: R.bank, statementDate: d('2026-04-30'), statementBalance: '9802.00' });
    for (const l of await listClearable(ctx, R.bank, endOfDay('2026-04-30'), april.id)) {
      if (l.debit === '10000.00' || l.credit === '100.00' || l.credit === '98.00') await toggleCleared(ctx, april.id, l.journalEntryLineId, true);
    }
    await completeReconciliation(ctx, april.id);

    // ---- The accountant's changes, all dated on or before the dividing date ----
    await updateBill(actx, R.billW, { vendorId: R.supplier, billNumber: 'B-W', date: d('2026-02-10'), lines: [{ itemId: R.widget, quantity: 5, unitCost: '10' }] });
    await createInvoice(actx, { customerId: R.acme, date: d('2026-03-20'), refNumber: 'M-W', lines: [{ itemId: R.widget, quantity: 5, rate: '25' }] });
    await updateExpense(actx, R.check, {
      payeeName: 'Office Depot', date: d('2026-03-10'), method: 'cash', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '100' }],
    });
    await updateBillPayment(actx, R.bp, {
      vendorId: R.supplier, date: d('2026-03-05'), method: 'check', reference: '2009', paymentAccountId: acct['1000'], discountAccountId: acct['6300'],
      applications: [{ billId: R.billD, amountApplied: '98', discountTaken: '2' }],
    });
    await updateVendorCredit(actx, R.vc, { vendorId: R.other, date: d('2026-02-20'), refNumber: 'VC-1', lines: [{ accountId: acct['6300'], amount: '50' }] });
    await updateCreditMemo(actx, R.cm, { customerId: R.beta, date: d('2026-02-20'), refNumber: 'CM-1', lines: [svc('Goodwill', '60')] });
    await updateItemReceipt(actx, R.ir, { vendorId: R.supplier, date: d('2026-02-12'), reference: 'IR-1', lines: [{ itemId: R.gadget, quantity: 6, unitCost: '4' }] });
    await updateEntry(actx, R.je, {
      date: d('2026-02-22'),
      description: 'Courtesy credit',
      lines: [{ accountId: acct['4100'], debit: '45.00' }, { accountId: acct['1200'], credit: '45.00', entityType: 'customer', entityId: R.acme }],
    });
    // P3 moves from the March 6 deposit to a new March 20 deposit.
    await updateDeposit(actx, R.depX, { depositAccountId: acct['1000'], date: d('2026-03-06'), paymentIds: [R.p4], salesReceiptIds: [] });
    await createDeposit(actx, { depositAccountId: acct['1000'], date: d('2026-03-20'), paymentIds: [R.p3], salesReceiptIds: [] });

    changes = (await exportChangesFile(actx, {})).buffer;
    review = await reviewChangesFile(ctx, changes);
  }, 300_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('a February inventory bill changed from 10 to 5 Widgets after the client sold all 10 in April: flagged with the sale, the import refuses alike', async () => {
    const p = problemOf(`bill:edit:${R.billW}`);
    expect(p).toMatch(/Since the dividing date your file has sold or used "Widget": your invoice #A-W \(Acme Corp\) dated 2026-04-10 \(10 sold\)/);
    expect(p).toMatch(/only 0 of "Widget" are on hand, and your accountant's change to bill #B-W \(Supplier Co\) would take 10 out of stock/);
    expect(p).toMatch(/To import: undo or change those sales or uses/);
    await refusesWith(only({ doc: (x) => x.type === 'bill' && x.op === 'edit' && x.id === R.billW }), p!);
  });

  it('a void of that bill: flagged with the sale, the import refuses alike', async () => {
    const { sha256: _s, ...body } = parseChangesFile(only({}));
    body.documents.push({ op: 'void', type: 'bill', id: R.billW, baseVersion: null, baseDigest: null });
    const buf = serializeChangesFile(body);
    const r = await reviewChangesFile(ctx, buf);
    const p = problemOf(`bill:void:${R.billW}`, r);
    expect(p).toMatch(/your invoice #A-W \(Acme Corp\) dated 2026-04-10 \(10 sold\)/);
    expect(p).toMatch(/your accountant's void of bill #B-W \(Supplier Co\) would take 10 out of stock/);
    await refusesWith(buf, p!);
  });

  it('a new March invoice selling 5 Widgets the client already sold: flagged with the sale, the import refuses alike', async () => {
    const item = review.items.find((i) => i.key.startsWith('invoice:add:'))!;
    expect(item.problem).toMatch(/your invoice #A-W \(Acme Corp\) dated 2026-04-10 \(10 sold\)/);
    expect(item.problem).toMatch(/your accountant's new invoice would take 5 out of stock/);
    expect(item.problem).toMatch(/ask your accountant to change this new invoice\.$/);
    await refusesWith(only({ doc: (x) => x.type === 'invoice' && x.op === 'add' }), item.problem!);
  });

  it('the bill edit and the new invoice together: the whole inventory picture is walked, both are flagged', () => {
    expect(problemOf(`bill:edit:${R.billW}`)).not.toBeNull();
    expect(review.items.find((i) => i.key.startsWith('invoice:add:'))?.problem).toBeTruthy();
  });

  it('a reconciled check changed from check to cash (same amount and account): flagged, the import refuses alike', async () => {
    const p = problemOf(`expense:edit:${R.check}`);
    expect(p).toMatch(/This check \/ expense was cleared in your reconciliation of 1000 · .+ for the statement ending 2026-04-30/);
    await refusesWith(only({ txn: (t) => t.type === 'expense' && t.id === R.check }), p!);
  });

  it('a reconciled bill payment with a discount, only its check number changed: flagged, the import refuses alike', async () => {
    const p = problemOf(`bill_payment:edit:${R.bp}`);
    expect(p).toMatch(/This bill payment was cleared in your reconciliation of 1000 · .+ for the statement ending 2026-04-30/);
    await refusesWith(only({ doc: (x) => x.type === 'bill_payment' && x.id === R.bp }), p!);
  });

  it('a vendor credit the client applied in April, moved to another vendor: flagged with the application, the import refuses alike', async () => {
    const p = problemOf(`vendor_credit:edit:${R.vc}`);
    expect(p).toMatch(/Since the dividing date your file has used this vendor credit \(vendor credit #VC-1 \(Supplier Co\)\): \$50\.00 applied to your bill #B-A \(Supplier Co\) on 2026-04-08/);
    expect(p).toMatch(/its vendor, amount and accounts can't be changed/);
    await refusesWith(only({ doc: (x) => x.type === 'vendor_credit' && x.id === R.vc }), p!);
  });

  it('that vendor credit voided in the file (a home-currency application is only in the audit trail): flagged, the import refuses alike', async () => {
    const { sha256: _s, ...body } = parseChangesFile(only({}));
    body.documents.push({ op: 'void', type: 'vendor_credit', id: R.vc, baseVersion: null, baseDigest: null });
    const buf = serializeChangesFile(body);
    const p = problemOf(`vendor_credit:void:${R.vc}`, await reviewChangesFile(ctx, buf));
    expect(p).toMatch(/your file has used this vendor credit \(vendor credit #VC-1 \(Supplier Co\)\): \$50\.00 applied to your bill #B-A \(Supplier Co\) on 2026-04-08\. So it can't be voided/);
    await refusesWith(buf, p!);
  });

  it('a credit memo the client applied in April, moved to another customer: flagged with the application, the import refuses alike', async () => {
    const p = problemOf(`credit_memo:edit:${R.cm}`);
    expect(p).toMatch(/Since the dividing date your file has used this credit memo \(credit memo #CM-1 \(Acme Corp\)\): \$60\.00 applied to your invoice #A-08 \(Acme Corp\) on 2026-04-08/);
    expect(p).toMatch(/its customer can't be changed/);
    await refusesWith(only({ doc: (x) => x.type === 'credit_memo' && x.id === R.cm }), p!);
  });

  it('an item receipt the client turned into a bill in April, changed by the accountant: flagged with the bill, the import refuses alike', async () => {
    const p = problemOf(`item_receipt:edit:${R.ir}`);
    expect(p).toMatch(/Your file has your bill #IR-B \(Supplier Co\) dated 2026-04-12 entered against this item receipt/);
    expect(p).toMatch(/can't be changed\. To import: void it/);
    await refusesWith(only({ doc: (x) => x.type === 'item_receipt' && x.id === R.ir }), p!);
  });

  it('a General Journal entry whose credit the client applied in April, changed by the accountant: flagged, the import refuses alike', async () => {
    const p = problemOf(`journal_entry:edit:${R.je}`);
    expect(p).toMatch(/Your file has \$40\.00 of your General Journal #\d+ applied on your invoice #A-08 \(Acme Corp\) on 2026-04-09/);
    expect(p).toMatch(/this journal entry can't be changed/);
    await refusesWith(only({ txn: (t) => t.type === 'journal_entry' && t.id === R.je }), p!);
  });

  it('a payment moved from one March deposit to another (no client work): not flagged, and it imports', async () => {
    expect(review.items.filter((i) => i.key.startsWith('deposit:')).map((i) => i.problem)).toEqual([null, null]);
    const buf = only({ txn: (t) => t.type === 'deposit' });
    const r = await reviewChangesFile(ctx, buf);
    expect(r.items.filter((i) => i.problem)).toEqual([]);
    expect(r.canImport).toBe(true);
    const res = await importChangesFile(ctx, buf);
    expect(res.trialBalance.balanced).toBe(true);
    expect(res.copy.status).toBe('imported');
  });
});
