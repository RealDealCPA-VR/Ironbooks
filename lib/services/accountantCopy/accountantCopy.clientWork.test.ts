/**
 * Accountant's Copy (PARITY I1): the client's own work after the dividing date that the import
 * would run into. The review must predict each refusal — in plain language, naming the client's
 * own later record and the way out — and the import must refuse with the same words (never a raw
 * id), leaving the books as they were:
 *
 *  - a March check the accountant changes, cleared in the client's April reconciliation;
 *  - a February invoice the accountant voids, paid by the client's April payment (and a bill the
 *    client paid in April);
 *  - a payment, a credit memo, a General Journal credit and a vendor credit the accountant applies
 *    to an invoice / bill the client has since paid in full, and a credit memo the client has
 *    since used up;
 *  - a March payment in Undeposited Funds the client deposited in April and the accountant
 *    deposited in March (and another one the accountant voids).
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
import { createInvoice, voidInvoice } from '../invoices';
import { applyToInvoice, createCreditMemo } from '../creditMemos';
import { receivePayment, voidPayment } from '../payments';
import { createBill, voidBill } from '../bills';
import { payBills } from '../billPayments';
import { applyToBill, createVendorCredit } from '../vendorCredits';
import { createExpense, updateExpense } from '../expenses';
import { createDeposit } from '../deposits';
import { createManualEntry } from '../journal';
import { applyJournalCredit } from '../journalApplications';
import { completeReconciliation, listClearable, startReconciliation, toggleCleared } from '../reconcile';
import { trialBalance } from '../reports';
import { accountantCopyStatus, createAccountantCopy, importChangesFile, reviewChangesFile, type ChangesReview } from './client';
import { exportChangesFile, openAccountantCopyFile } from './accountant';
import { parseChangesFile, serializeChangesFile, type ChangesFileBody } from './format';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-clientwork');
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
/** The changes file cut down to the changes `keep` picks (the rest of the file is dropped). */
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

const problemOf = (key: string) => review.items.find((i) => i.key === key)?.problem ?? null;

/** The import refuses `buf` with the review's own words, and the client's books stay as they were. */
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
  // The review of the same file says the same thing.
  const r = await reviewChangesFile(ctx, buf);
  expect(r.canImport).toBe(false);
  expect(r.items.map((i) => i.problem)).toContain(problem);
}

describe("Accountant's Copy — the client's later work the import would run into", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'clientwork@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Later Work Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;

    R.acme = (await createCustomer(ctx, { displayName: 'Acme Corp' })).id;
    R.supplier = (await createVendor(ctx, { displayName: 'Supplier Co' })).id;
    R.bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '777777777' })).id;
    await createManualEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Owner investment',
      lines: [{ accountId: acct['1000'], debit: '10000.00' }, { accountId: acct['3000'], credit: '10000.00' }],
    });
    R.check = (
      await createExpense(ctx, { payeeName: 'Office Depot', date: d('2026-03-10'), method: 'check', reference: '3001', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '100' }] })
    ).id;
    R.invVoid = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-10'), refNumber: 'F-10', lines: [svc('February work', '300')] })).id;
    R.invPaid = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-12'), refNumber: 'F-12', lines: [svc('More February work', '200')] })).id;
    R.invOpen = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-25'), refNumber: 'F-25', lines: [svc('Late February work', '100')] })).id;
    R.invD = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-03-14'), refNumber: 'M-14', lines: [svc('March work', '100')] })).id;
    R.cmUsed = (await createCreditMemo(ctx, { customerId: R.acme, date: d('2026-02-20'), refNumber: 'CM-20', lines: [svc('Goodwill', '60')] })).id;
    R.bill = (await createBill(ctx, { vendorId: R.supplier, billNumber: 'B-15', date: d('2026-02-15'), lines: [{ accountId: acct['6300'], amount: '400' }] })).id;
    R.billV = (await createBill(ctx, { vendorId: R.supplier, billNumber: 'B-16', date: d('2026-02-16'), lines: [{ accountId: acct['6300'], amount: '150' }] })).id;
    // Two March payments waiting in Undeposited Funds.
    R.payD = (
      await receivePayment(ctx, {
        customerId: R.acme, date: d('2026-03-15'), method: 'check', reference: 'D-1', amount: '75', depositAccountId: acct['1050'],
        applications: [{ invoiceId: R.invD, amountApplied: '75' }],
      })
    ).payment.id;
    R.payV = (
      await receivePayment(ctx, {
        customerId: R.acme, date: d('2026-03-16'), method: 'check', reference: 'D-2', amount: '25', depositAccountId: acct['1050'],
        applications: [{ invoiceId: R.invD, amountApplied: '25' }],
      })
    ).payment.id;

    const transfer = (await createAccountantCopy(ctx, { dividingDate: DIVIDING, dataDir: CLIENT_DIR })).buffer;
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: ctx.companyId, userId: ctx.userId };

    // ---- The client keeps working in April ----
    await receivePayment(ctx, {
      customerId: R.acme, date: d('2026-04-05'), method: 'check', reference: 'P-APR1', amount: '300', depositAccountId: acct['1000'],
      applications: [{ invoiceId: R.invVoid, amountApplied: '300' }],
    });
    await receivePayment(ctx, {
      customerId: R.acme, date: d('2026-04-06'), method: 'check', reference: 'P-APR2', amount: '200', depositAccountId: acct['1000'],
      applications: [{ invoiceId: R.invPaid, amountApplied: '200' }],
    });
    await payBills(ctx, { vendorId: R.supplier, date: d('2026-04-07'), method: 'check', reference: '2001', paymentAccountId: acct['1000'], applications: [{ billId: R.bill, amountApplied: '400' }] });
    await payBills(ctx, { vendorId: R.supplier, date: d('2026-04-07'), method: 'check', reference: '2002', paymentAccountId: acct['1000'], applications: [{ billId: R.billV, amountApplied: '150' }] });
    const invApr = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-04-08'), refNumber: 'A-08', lines: [svc('April work', '500')] })).id;
    await applyToInvoice(ctx, { creditMemoId: R.cmUsed, invoiceId: invApr, amount: '60', date: d('2026-04-08') });
    await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-04-03'), paymentIds: [R.payD, R.payV], salesReceiptIds: [] });
    // April statement: clears the owner investment and the March check (an outstanding item).
    const april = await startReconciliation(ctx, { bankAccountId: R.bank, statementDate: d('2026-04-30'), statementBalance: '9900.00' });
    for (const l of await listClearable(ctx, R.bank, endOfDay('2026-04-30'), april.id)) {
      if (l.debit === '10000.00' || l.credit === '100.00') await toggleCleared(ctx, april.id, l.journalEntryLineId, true);
    }
    await completeReconciliation(ctx, april.id);

    // ---- The accountant's changes, all dated on or before the dividing date ----
    await updateExpense(actx, R.check, {
      payeeName: 'Office Depot', date: d('2026-03-10'), method: 'check', reference: '3001', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '120' }],
    });
    await voidInvoice(actx, R.invVoid);
    await voidBill(actx, R.billV);
    // Credits and a payment applied to the February invoice the client paid in full in April.
    const cmNew = (await createCreditMemo(actx, { customerId: R.acme, date: d('2026-03-15'), refNumber: 'CM-NEW', lines: [svc('Price adjustment', '50')] })).id;
    await applyToInvoice(actx, { creditMemoId: cmNew, invoiceId: R.invPaid, amount: '50', date: d('2026-03-15') });
    await receivePayment(actx, {
      customerId: R.acme, date: d('2026-03-20'), method: 'check', reference: 'M-20', amount: '80', depositAccountId: acct['1000'],
      applications: [{ invoiceId: R.invPaid, amountApplied: '80' }],
    });
    const je = await createManualEntry(actx, {
      date: d('2026-03-18'),
      description: 'Courtesy credit',
      lines: [{ accountId: acct['4100'], debit: '40.00' }, { accountId: acct['1200'], credit: '40.00', entityType: 'customer', entityId: R.acme }],
    });
    const [jeLine] = await actx.db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, je.id), eq(journalEntryLines.accountId, acct['1200'])));
    await applyJournalCredit(actx, { journalLineId: jeLine.id, invoiceId: R.invPaid, amount: '40', date: d('2026-03-18') });
    // A vendor credit applied to the bill the client paid in April.
    const vcNew = (await createVendorCredit(actx, { vendorId: R.supplier, date: d('2026-03-15'), refNumber: 'VC-NEW', lines: [{ accountId: acct['6300'], amount: '60' }] })).id;
    await applyToBill(actx, { vendorCreditId: vcNew, billId: R.bill, amount: '60', date: d('2026-03-15') });
    // The credit memo the client used up in April, applied to another February invoice.
    await applyToInvoice(actx, { creditMemoId: R.cmUsed, invoiceId: R.invOpen, amount: '60', date: d('2026-03-25') });
    // March deposit of a payment the client deposited in April; the other one voided.
    await createDeposit(actx, { depositAccountId: acct['1000'], date: d('2026-03-31'), paymentIds: [R.payD], salesReceiptIds: [] });
    await voidPayment(actx, R.payV);

    changes = (await exportChangesFile(actx, {})).buffer;
    review = await reviewChangesFile(ctx, changes);
  }, 240_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('review: the file cannot be imported as it is', () => {
    expect(review.canImport).toBe(false);
  });

  it('a check the client cleared in its April reconciliation: the review names the reconciliation, the import refuses alike', async () => {
    const p = problemOf(`expense:edit:${R.check}`);
    expect(p).toMatch(/This check \/ expense was cleared in your reconciliation of 1000 · .+ for the statement ending 2026-04-30/);
    expect(p).toMatch(/Undo Last Reconciliation until the statement ending 2026-04-30 is undone/);
    await refusesWith(only({ txn: (t) => t.type === 'expense' && t.id === R.check }), p!);
  });

  it('a February invoice the client paid in April: the void is flagged with the payment, the import refuses alike', async () => {
    const p = problemOf(`invoice:void:${R.invVoid}`);
    expect(p).toMatch(/your payment #P-APR1 of \$300\.00 \(Acme Corp\) received 2026-04-05/);
    expect(p).toMatch(/can't be voided/);
    expect(p).toMatch(/To import: take it off this invoice/);
    await refusesWith(only({ doc: (x) => x.type === 'invoice' && x.op === 'void' }), p!);
  });

  it('a February bill the client paid in April: the void is flagged with the bill payment, the import refuses alike', async () => {
    const p = problemOf(`bill:void:${R.billV}`);
    expect(p).toMatch(/your bill payment #2002 of \$150\.00 \(Supplier Co\) dated 2026-04-07/);
    await refusesWith(only({ doc: (x) => x.type === 'bill' && x.op === 'void' }), p!);
  });

  it('a payment applied to the invoice the client paid in full: flagged with the client’s payment, the import refuses alike', async () => {
    const item = review.items.find((i) => i.key.startsWith('payment_received:add:'))!;
    expect(item.problem).toMatch(/Your file already has your payment #P-APR2 of \$200\.00 \(Acme Corp\) received 2026-04-06 .* on invoice #F-12 \(Acme Corp\)/);
    expect(item.problem).toMatch(/only \$0\.00 of it is still open and your accountant's customer payment of \$80\.00 to it doesn't fit/);
    await refusesWith(only({ doc: (x) => x.type === 'payment_received' && x.op === 'add' }), item.problem!);
  });

  it('a new credit memo applied to that invoice: flagged, the import refuses alike', async () => {
    const item = review.items.find((i) => i.key.startsWith('application:credit_memo:apply:') && /CM-NEW/.test(i.title))!;
    expect(item.problem).toMatch(/payment #P-APR2 .* on invoice #F-12 .* your accountant's application of \$50\.00 to it doesn't fit/);
    await refusesWith(
      only({ doc: (x) => x.type === 'credit_memo' && x.op === 'add', app: (a) => a.kind === 'credit_memo' && a.op === 'apply' && a.invoiceId === R.invPaid }),
      item.problem!,
    );
  });

  it('a General Journal credit applied to that invoice: flagged, the import refuses alike', async () => {
    const item = review.items.find((i) => i.key.startsWith('application:journal:apply:'))!;
    expect(item.problem).toMatch(/payment #P-APR2 .* on invoice #F-12 .* your accountant's application of \$40\.00 to it doesn't fit/);
    await refusesWith(only({ txn: (t) => t.type === 'journal_entry' && t.op === 'add', app: (a) => a.kind === 'journal' }), item.problem!);
  });

  it('a vendor credit applied to the bill the client paid in April: flagged, the import refuses alike', async () => {
    const item = review.items.find((i) => i.key.startsWith('application:vendor_credit:apply:'))!;
    expect(item.problem).toMatch(/your bill payment #2001 of \$400\.00 \(Supplier Co\) dated 2026-04-07 .* on bill #B-15 \(Supplier Co\)/);
    await refusesWith(only({ doc: (x) => x.type === 'vendor_credit' && x.op === 'add', app: (a) => a.kind === 'vendor_credit' }), item.problem!);
  });

  it('a credit memo the client used up in April: flagged with where it went, the import refuses alike', async () => {
    const item = review.items.find((i) => i.key.startsWith('application:credit_memo:apply:') && /CM-20/.test(i.title))!;
    expect(item.problem).toMatch(/Your file has already used credit memo #CM-20 \(Acme Corp\): \$60\.00 applied to your invoice #A-08 \(Acme Corp\) on 2026-04-08/);
    await refusesWith(only({ app: (a) => a.kind === 'credit_memo' && a.op === 'apply' && a.creditMemoId === R.cmUsed }), item.problem!);
  });

  it('a payment the client deposited in April, deposited again by the accountant: flagged with the client’s deposit, the import names the payment', async () => {
    const item = review.items.find((i) => i.key.startsWith('deposit:add:'))!;
    expect(item.problem).toMatch(/Your payment #D-1 of \$75\.00 \(Acme Corp\) is already in your deposit of \$100\.00 on 2026-04-03 to 1000 · /);
    expect(item.problem).toMatch(/remove it from your deposit \(or void that deposit\)/);
    await refusesWith(only({ txn: (t) => t.type === 'deposit' }), item.problem!);
  });

  it('a payment the client deposited in April, voided by the accountant: flagged with the deposit, the import refuses alike', async () => {
    const p = problemOf(`payment_received:void:${R.payV}`);
    expect(p).toMatch(/your deposit of \$100\.00 on 2026-04-03 to 1000 · .+ can't be voided/);
    await refusesWith(only({ doc: (x) => x.type === 'payment_received' && x.op === 'void' }), p!);
  });

  it('a credit memo the client used up in April, voided in the file: flagged with where it went, the import refuses alike', async () => {
    const { sha256: _s, ...body } = parseChangesFile(only({}));
    body.documents.push({ op: 'void', type: 'credit_memo', id: R.cmUsed, baseVersion: null, baseDigest: null });
    const buf = serializeChangesFile(body);
    const r = await reviewChangesFile(ctx, buf);
    const p = r.items.find((i) => i.key === `credit_memo:void:${R.cmUsed}`)?.problem ?? null;
    expect(p).toMatch(/Since the dividing date your file has used this credit memo \(credit memo #CM-20 \(Acme Corp\)\): \$60\.00 applied to your invoice #A-08/);
    expect(p).toMatch(/can't be voided/);
    await refusesWith(buf, p!);
  });

  it('a change to the reconciled check that leaves its amount, accounts and date alone is not flagged', async () => {
    const { sha256: _s, ...body } = parseChangesFile(only({ txn: (t) => t.type === 'expense' && t.id === R.check }));
    const t = body.transactions[0] as Extract<Body['transactions'][number], { type: 'expense'; op: 'edit' }>;
    t.after = { ...t.after, memo: 'Printer paper', total: '100.00', lines: t.after.lines.map((l) => ({ ...l, amount: '100.00' })) };
    const r = await reviewChangesFile(ctx, serializeChangesFile(body));
    expect(r.items.find((i) => i.key === `expense:edit:${R.check}`)?.problem ?? null).toBeNull();
  });

  it('the whole file is refused with the first of those problems, and nothing changes', async () => {
    const first = review.items.find((i) => i.problem)!;
    await refusesWith(changes, first.problem!);
  });
});
