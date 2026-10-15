/**
 * Accountant's Copy, complete (PARITY I1): every form the accountant may change travels in the
 * changes file (format 3) and is applied on the client's side through its normal service.
 *
 * One scenario is run twice:
 *  - through the Accountant's Copy: client file → .ibac → accountant's copy (work dated on or
 *    before the dividing date) → .ibcx → review → import into the client file, which meanwhile
 *    kept working after the dividing date;
 *  - directly in a REFERENCE company file (same setup, the accountant's work, the client's later
 *    work) — the independent expectation: after the import the client's trial balance (every
 *    account, by number) must equal the reference's.
 * Plus: round trips of each form type (new / changed / voided), applications (a payment applied to
 * an invoice the accountant created, a bill payment with a vendor credit, credit memos, General
 * Journal credits), reconciliations (undo + reconcile, statement service charge), id mapping,
 * all-or-nothing rollback with a precise error, dividing-date and closed-period refusals, record
 * locking that tells real edits from derived changes, and format 2 files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accountantCopies,
  accounts,
  bankAccounts,
  billPaymentApplications,
  billPayments,
  bills,
  creditApplications,
  creditMemos,
  customers,
  estimates,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  journalItemApplications,
  otherNames,
  paymentApplications,
  paymentsReceived,
  purchaseOrders,
  reconciliations,
  salesOrders,
  salesReceipts,
  users,
  vendorCredits,
  vendors,
  itemReceipts,
} from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany, setClosingDate } from '../company';
import { createBankAccount } from '../bankAccounts';
import { createCustomer, updateCustomer } from '../customers';
import { createVendor, updateVendor } from '../vendors';
import { createItem, updateItem } from '../items';
import { createEntry } from '../lists/simpleLists';
import { createInvoice, updateInvoice, voidInvoice } from '../invoices';
import { createSalesReceipt, updateSalesReceipt, voidSalesReceipt } from '../salesReceipts';
import { applyToInvoice, createCreditMemo, unapplyCreditApplication, updateCreditMemo, voidCreditMemo, refundCreditMemo } from '../creditMemos';
import { receivePayment, updatePayment, voidPayment } from '../payments';
import { createBill, updateBill, voidBill } from '../bills';
import { payBills, payBillsWithCredits, updateBillPayment, voidBillPayment } from '../billPayments';
import { applyToBill, createVendorCredit, unapplyFromBill, updateVendorCredit, voidVendorCredit } from '../vendorCredits';
import { createItemReceipt, updateItemReceipt, voidItemReceipt } from '../itemReceipts';
import { adjustQuantityAtSite } from '../inventorySiteOps';
import { convertToInvoice, createEstimate, updateEstimate, updateEstimateStatus } from '../estimates';
import { createSalesOrder, getSalesOrder, updateSalesOrder, updateStatus as updateSalesOrderStatus } from '../salesOrders';
import { createPurchaseOrder, getPurchaseOrder, updatePurchaseOrder, updateStatus as updatePurchaseOrderStatus } from '../purchaseOrders';
import { createExpense } from '../expenses';
import { createDeposit } from '../deposits';
import { createManualEntry } from '../journal';
import { applyJournalCredit, unapplyJournalApplication } from '../journalApplications';
import { completeReconciliation, listClearable, startReconciliation, toggleCleared, undoLastReconciliation, addStatementAdjustments } from '../reconcile';
import { trialBalance } from '../reports';
import { accountantCopyStatus, createAccountantCopy, importChangesFile, reviewChangesFile } from './client';
import { accountantChanges, exportChangesFile, openAccountantCopyFile } from './accountant';
import { CHANGES_FORMAT_VERSION, parseChangesFile, serializeChangesFile, type ChangesFileBody } from './format';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-full');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const ACCT_DIR2 = path.join(ROOT, 'accountant2');
const ACCT_DIR3 = path.join(ROOT, 'accountant3');
const REF_DIR = path.join(ROOT, 'reference');

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const endOfDay = (s: string) => new Date(`${s}T23:59:59.999Z`);
const DIVIDING = '2026-03-31';

type Refs = Record<string, string>;

async function newCompany(dir: string, email: string): Promise<{ ctx: ServiceContext; db: DB; acct: Refs }> {
  const db = await getDb(dir);
  const [user] = await db.insert(users).values({ email, name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Full Copy Co', ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const acct: Refs = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  return { ctx, db, acct };
}

const svc = (desc: string, rate: string, acct: Refs, quantity = 1) => ({ description: desc, quantity, rate, accountId: acct['4100'] });

/** The client's books when the Accountant's Copy is made (also the reference's start). */
async function clientSetup(ctx: ServiceContext, acct: Refs): Promise<Refs> {
  const R: Refs = {};
  R.acme = (await createCustomer(ctx, { displayName: 'Acme Corp', phone: '555-0100' })).id;
  R.supplier = (await createVendor(ctx, { displayName: 'Supplier Co' })).id;
  R.consulting = (await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: '100', incomeAccountId: acct['4100'] })).id;
  R.widget = (
    await createItem(ctx, { name: 'Widget', type: 'inventory', assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'], purchaseCost: '10' })
  ).id;
  R.bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '123456789' })).id;
  R.invest = (
    await createManualEntry(ctx, { date: d('2026-01-02'), description: 'Owner investment', lines: [{ accountId: acct['1000'], debit: '10000.00' }, { accountId: acct['3000'], credit: '10000.00' }] })
  ).id;

  R.invA = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-01'), lines: [{ itemId: R.consulting, quantity: 10, rate: '100' }] })).id;
  R.invB = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-05'), lines: [svc('Setup', '500', acct)] })).id;
  R.invC = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-08'), lines: [svc('Extra', '200', acct)] })).id;
  // Dated after the dividing date but entered before the copy: it belongs to the client.
  R.invP = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-04-02'), lines: [svc('April work', '150', acct)] })).id;
  R.cmA = (await createCreditMemo(ctx, { customerId: R.acme, date: d('2026-02-10'), lines: [svc('Discount', '100', acct)] })).id;
  R.cmB = (await createCreditMemo(ctx, { customerId: R.acme, date: d('2026-02-11'), lines: [svc('Goodwill', '30', acct)] })).id;
  R.cmC = (await createCreditMemo(ctx, { customerId: R.acme, date: d('2026-02-12'), lines: [svc('Credit', '25', acct)] })).id;
  await applyToInvoice(ctx, { creditMemoId: R.cmC, invoiceId: R.invA, amount: '25', date: d('2026-02-12') });
  R.payA = (
    await receivePayment(ctx, { customerId: R.acme, date: d('2026-02-15'), method: 'check', reference: 'PA', amount: '300', depositAccountId: acct['1050'], applications: [{ invoiceId: R.invA, amountApplied: '300' }] })
  ).payment.id;
  R.payB = (
    await receivePayment(ctx, { customerId: R.acme, date: d('2026-02-16'), method: 'check', reference: 'PB', amount: '50', depositAccountId: acct['1050'], applications: [{ invoiceId: R.invB, amountApplied: '50' }] })
  ).payment.id;
  R.srA = (await createSalesReceipt(ctx, { customerId: R.acme, date: d('2026-02-12'), lines: [svc('Walk-in', '80', acct)], depositAccountId: acct['1050'] })).id;
  R.srB = (await createSalesReceipt(ctx, { customerId: R.acme, date: d('2026-02-13'), lines: [svc('Walk-in 2', '40', acct)], depositAccountId: acct['1050'] })).id;
  R.billA = (await createBill(ctx, { vendorId: R.supplier, date: d('2026-02-03'), lines: [{ accountId: acct['6300'], amount: '400' }] })).id;
  R.billB = (await createBill(ctx, { vendorId: R.supplier, date: d('2026-02-04'), lines: [{ accountId: acct['6300'], amount: '250' }] })).id;
  R.billC = (await createBill(ctx, { vendorId: R.supplier, date: d('2026-02-07'), lines: [{ accountId: acct['6300'], amount: '90' }] })).id;
  R.vcA = (await createVendorCredit(ctx, { vendorId: R.supplier, date: d('2026-02-06'), lines: [{ accountId: acct['6300'], amount: '50' }] })).id;
  R.vcB = (await createVendorCredit(ctx, { vendorId: R.supplier, date: d('2026-02-09'), lines: [{ accountId: acct['6300'], amount: '20' }] })).id;
  R.bpA = (await payBills(ctx, { vendorId: R.supplier, date: d('2026-02-20'), method: 'check', reference: '1001', paymentAccountId: acct['1000'], applications: [{ billId: R.billA, amountApplied: '100' }] })).id;
  R.bpB = (await payBills(ctx, { vendorId: R.supplier, date: d('2026-02-21'), method: 'check', reference: '1002', paymentAccountId: acct['1000'], applications: [{ billId: R.billB, amountApplied: '50' }] })).id;
  R.irA = (await createItemReceipt(ctx, { vendorId: R.supplier, date: d('2026-02-08'), lines: [{ itemId: R.widget, quantity: 10, unitCost: '10' }] })).id;
  R.irB = (await createItemReceipt(ctx, { vendorId: R.supplier, date: d('2026-02-09'), lines: [{ itemId: R.widget, quantity: 2, unitCost: '10' }] })).id;
  R.estA = (await createEstimate(ctx, { customerId: R.acme, date: d('2026-02-02'), lines: [{ description: 'Proposal', quantity: 1, rate: '1000' }] })).id;
  R.soA = (await createSalesOrder(ctx, { customerId: R.acme, date: d('2026-02-02'), lines: [{ description: 'Order', quantity: 2, rate: '50' }] })).id;
  R.soB = (await createSalesOrder(ctx, { customerId: R.acme, date: d('2026-02-03'), lines: [{ description: 'Order 2', quantity: 1, rate: '20' }] })).id;
  R.poA = (await createPurchaseOrder(ctx, { vendorId: R.supplier, date: d('2026-02-02'), lines: [{ accountId: acct['6300'], description: 'Paper', quantity: 5, rate: '4' }] })).id;
  R.poB = (await createPurchaseOrder(ctx, { vendorId: R.supplier, date: d('2026-02-03'), lines: [{ accountId: acct['6300'], description: 'Pens', quantity: 1, rate: '9' }] })).id;
  // A General Journal A/R credit for Acme (applied to an invoice by the accountant).
  const je = await createManualEntry(ctx, {
    date: d('2026-02-25'),
    description: 'Credit for late delivery',
    lines: [
      { accountId: acct['6000'], debit: '40.00' },
      { accountId: acct['1200'], credit: '40.00', entityType: 'customer', entityId: R.acme },
    ],
  });
  R.je = je.id;
  // February statement reconciled: the investment and check 1001.
  const recon = await startReconciliation(ctx, { bankAccountId: R.bank, statementDate: d('2026-02-28'), statementBalance: '9900.00' });
  for (const l of await listClearable(ctx, R.bank, endOfDay('2026-02-28'), recon.id)) {
    if (l.debit === '10000.00' || l.credit === '100.00') await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
  }
  R.reconA = (await completeReconciliation(ctx, recon.id)).id;
  return R;
}

/** What the accountant does (on or before the dividing date). Returns the records it created. */
async function accountantWork(ctx: ServiceContext, acct: Refs, R: Refs): Promise<Refs> {
  const N: Refs = {};
  // Names and items.
  N.newCo = (await createCustomer(ctx, { displayName: 'NewCo LLC', email: 'ap@newco.test' })).id;
  await updateCustomer(ctx, R.acme, { phone: '555-0199' });
  N.newVendor = (await createVendor(ctx, { displayName: 'Audit Partners' })).id;
  N.auditSvc = (await createItem(ctx, { name: 'Audit Service', type: 'service', salesPrice: '250', incomeAccountId: acct['4100'] })).id;
  await updateItem(ctx, R.consulting, { salesPrice: '120' });
  N.petty = (await createEntry(ctx, 'other-names', { name: 'Petty Cash Person' })).id;

  // Invoices: new (for a new customer and item), changed, voided.
  N.invN = (await createInvoice(ctx, { customerId: N.newCo, date: d('2026-03-10'), refNumber: 'AC-1', lines: [{ itemId: N.auditSvc, quantity: 2, rate: '250' }] })).id;
  await updateInvoice(ctx, R.invB, { customerId: R.acme, date: d('2026-02-05'), lines: [svc('Setup', '600', acct)] });
  await voidInvoice(ctx, R.invC);
  // Sales receipts.
  N.srN = (await createSalesReceipt(ctx, { customerId: N.newCo, date: d('2026-03-12'), lines: [svc('Workshop', '60', acct)], depositAccountId: acct['1050'] })).id;
  await updateSalesReceipt(ctx, R.srA, { customerId: R.acme, date: d('2026-02-12'), lines: [svc('Walk-in', '90', acct)], depositAccountId: acct['1050'] });
  await voidSalesReceipt(ctx, R.srB);
  // Credit memos and their applications.
  N.cmN = (await createCreditMemo(ctx, { customerId: N.newCo, date: d('2026-03-15'), lines: [svc('Courtesy', '50', acct)] })).id;
  await applyToInvoice(ctx, { creditMemoId: N.cmN, invoiceId: N.invN, amount: '50', date: d('2026-03-15') });
  await updateCreditMemo(ctx, R.cmA, { customerId: R.acme, date: d('2026-02-10'), lines: [svc('Discount', '120', acct)] });
  await applyToInvoice(ctx, { creditMemoId: R.cmA, invoiceId: R.invB, amount: '50', date: d('2026-03-20') });
  const [cmCApp] = await ctx.db.select().from(creditApplications).where(eq(creditApplications.creditMemoId, R.cmC));
  await unapplyCreditApplication(ctx, cmCApp.id);
  await voidCreditMemo(ctx, R.cmB);
  // Received payments: one on the invoice created above, one re-applied, one voided.
  N.pN = (
    await receivePayment(ctx, { customerId: N.newCo, date: d('2026-03-20'), method: 'check', reference: 'N-1', amount: '450', depositAccountId: acct['1050'], applications: [{ invoiceId: N.invN, amountApplied: '450' }] })
  ).payment.id;
  await updatePayment(ctx, R.payA, {
    customerId: R.acme,
    date: d('2026-02-15'),
    method: 'check',
    reference: 'PA',
    amount: '300',
    depositAccountId: acct['1050'],
    applications: [
      { invoiceId: R.invA, amountApplied: '200' },
      { invoiceId: R.invB, amountApplied: '100' },
    ],
  });
  await voidPayment(ctx, R.payB);
  // A General Journal A/R credit applied to an invoice.
  const [jeLine] = await ctx.db.select().from(journalEntryLines).where(and(eq(journalEntryLines.journalEntryId, R.je), eq(journalEntryLines.accountId, acct['1200'])));
  await applyJournalCredit(ctx, { journalLineId: jeLine.id, invoiceId: R.invB, amount: '40', date: d('2026-03-21') });
  // Bills, vendor credits, bill payments (one with a vendor credit).
  N.billN = (await createBill(ctx, { vendorId: N.newVendor, date: d('2026-03-05'), lines: [{ accountId: acct['6200'], amount: '300' }] })).id;
  await voidBillPayment(ctx, R.bpB); // a paid bill can't be edited: void its payment first
  await updateBill(ctx, R.billB, { vendorId: R.supplier, date: d('2026-02-04'), lines: [{ accountId: acct['6300'], amount: '275' }] });
  await voidBill(ctx, R.billC);
  N.vcN = (await createVendorCredit(ctx, { vendorId: N.newVendor, date: d('2026-03-06'), lines: [{ accountId: acct['6200'], amount: '30' }] })).id;
  await updateVendorCredit(ctx, R.vcA, { vendorId: R.supplier, date: d('2026-02-06'), lines: [{ accountId: acct['6300'], amount: '60' }] });
  await applyToBill(ctx, { vendorCreditId: R.vcA, billId: R.billB, amount: '60' });
  await voidVendorCredit(ctx, R.vcB);
  N.bpN = (
    await payBillsWithCredits(ctx, {
      vendorId: N.newVendor,
      date: d('2026-03-25'),
      method: 'check',
      reference: '2001',
      paymentAccountId: acct['1000'],
      applications: [{ billId: N.billN, amountApplied: '270' }],
      vendorCredits: [{ vendorCreditId: N.vcN, billId: N.billN, amount: '30' }],
    })
  ).payment!.id;
  // Check 1001 was reconciled: undo the February reconciliation first, fix the check, reconcile again.
  await undoLastReconciliation(ctx, R.bank);
  await updateBillPayment(ctx, R.bpA, { vendorId: R.supplier, date: d('2026-02-20'), method: 'check', reference: '1001', paymentAccountId: acct['1000'], applications: [{ billId: R.billA, amountApplied: '150' }] });
  // Credit card charge and credit, a check.
  await createExpense(ctx, { vendorId: R.supplier, date: d('2026-03-07'), method: 'credit_card', paymentAccountId: acct['2100'], lines: [{ accountId: acct['6300'], amount: '45' }] });
  await createExpense(ctx, { vendorId: R.supplier, date: d('2026-03-08'), method: 'credit_card', isRefund: true, paymentAccountId: acct['2100'], lines: [{ accountId: acct['6300'], amount: '15' }] });
  await createExpense(ctx, { payeeName: 'Office Depot', date: d('2026-03-05'), method: 'check', reference: '3001', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '75' }] });
  // Item receipts and an inventory adjustment.
  N.irN = (await createItemReceipt(ctx, { vendorId: R.supplier, date: d('2026-03-08'), lines: [{ itemId: R.widget, quantity: 5, unitCost: '12' }] })).id;
  await updateItemReceipt(ctx, R.irA, { vendorId: R.supplier, date: d('2026-02-08'), lines: [{ itemId: R.widget, quantity: 8, unitCost: '10' }] });
  await voidItemReceipt(ctx, R.irB);
  await adjustQuantityAtSite(ctx, { itemId: R.widget, quantityChange: '-1', date: d('2026-03-26'), memo: 'Damaged', adjustmentAccountId: acct['6300'] });
  // Estimates, sales orders, purchase orders.
  N.estN = (await createEstimate(ctx, { customerId: N.newCo, date: d('2026-03-03'), lines: [{ description: 'Audit proposal', quantity: 1, rate: '900' }] })).id;
  await updateEstimateStatus(ctx, N.estN, 'accepted');
  await updateEstimate(ctx, R.estA, { customerId: R.acme, date: d('2026-02-02'), lines: [{ description: 'Proposal', quantity: 1, rate: '1100' }] });
  await updateEstimateStatus(ctx, R.estA, 'rejected');
  N.soN = (await createSalesOrder(ctx, { customerId: N.newCo, date: d('2026-03-04'), lines: [{ description: 'Audit order', quantity: 1, rate: '300' }] })).id;
  const so = await getSalesOrder(ctx, R.soA);
  await updateSalesOrder(ctx, R.soA, { customerId: R.acme, date: d('2026-02-02'), lines: [{ id: so.lines[0].id, description: 'Order', quantity: 3, rate: '50' }] });
  await updateSalesOrderStatus(ctx, R.soB, 'void');
  N.poN = (await createPurchaseOrder(ctx, { vendorId: N.newVendor, date: d('2026-03-04'), lines: [{ accountId: acct['6200'], description: 'Audit prep', quantity: 1, rate: '100' }] })).id;
  const po = await getPurchaseOrder(ctx, R.poA);
  await updatePurchaseOrder(ctx, R.poA, { vendorId: R.supplier, date: d('2026-02-02'), lines: [{ id: po.lines[0].id, accountId: acct['6300'], description: 'Paper', quantity: 6, rate: '4' }] });
  await updatePurchaseOrderStatus(ctx, R.poB, 'void');
  // Deposit the new payment and sales receipt.
  N.dep = (await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-03-28'), paymentIds: [N.pN], salesReceiptIds: [N.srN], memo: 'March deposit' })).id;

  // Reconcile February again (the corrected check), then March with a service charge.
  const feb = await startReconciliation(ctx, { bankAccountId: R.bank, statementDate: d('2026-02-28'), statementBalance: '9850.00' });
  for (const l of await listClearable(ctx, R.bank, endOfDay('2026-02-28'), feb.id)) {
    if (l.debit === '10000.00' || l.credit === '150.00') await toggleCleared(ctx, feb.id, l.journalEntryLineId, true);
  }
  await completeReconciliation(ctx, feb.id);
  // 9850 - 75 (check 3001) - 270 (check 2001) + 510 (deposit) - 5 (service charge) = 10010.
  const mar = await startReconciliation(ctx, { bankAccountId: R.bank, statementDate: d('2026-03-31'), statementBalance: '10010.00' });
  for (const l of await listClearable(ctx, R.bank, endOfDay('2026-03-31'), mar.id)) {
    if (l.credit === '75.00' || l.credit === '270.00' || l.debit === '510.00') await toggleCleared(ctx, mar.id, l.journalEntryLineId, true);
  }
  await addStatementAdjustments(ctx, mar.id, { serviceCharge: { amount: '5', accountId: acct['6100'] } });
  await completeReconciliation(ctx, mar.id);
  return N;
}

/** What the client enters after the dividing date while the copy is out. */
async function clientLater(ctx: ServiceContext, acct: Refs, R: Refs): Promise<Refs> {
  const L: Refs = {};
  L.invZ = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-04-05'), lines: [svc('May retainer', '300', acct)] })).id;
  // A payment after the dividing date on a February invoice: the invoice's version moves, its
  // substance does not (the accountant's edit of it must still import).
  L.payZ = (
    await receivePayment(ctx, { customerId: R.acme, date: d('2026-04-10'), method: 'check', reference: 'PZ', amount: '100', depositAccountId: acct['1050'], applications: [{ invoiceId: R.invB, amountApplied: '100' }] })
  ).payment.id;
  await createExpense(ctx, { payeeName: 'Coffee Shop', date: d('2026-04-03'), method: 'cash', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '20' }] });
  return L;
}

async function tbByCode(c: ServiceContext, asOf?: Date) {
  const tb = await trialBalance(c, asOf);
  return Object.fromEntries(tb.rows.filter((r) => Number(r.debit) !== 0 || Number(r.credit) !== 0).map((r) => [r.code, `${r.debit}/${r.credit}`]));
}

let client: { ctx: ServiceContext; db: DB; acct: Refs };
let reference: { ctx: ServiceContext; db: DB; acct: Refs };
let actx: ServiceContext;
let R: Refs;
let N: Refs;
let L: Refs;
let transfer: Buffer;
let changes: Buffer;

describe("Accountant's Copy — every form type, applications and reconciliations (format 3)", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    client = await newCompany(CLIENT_DIR, 'client-full@test.local');
    R = await clientSetup(client.ctx, client.acct);
    // The independent expectation: the same work done directly in a separate company file.
    reference = await newCompany(REF_DIR, 'ref-full@test.local');
    const RR = await clientSetup(reference.ctx, reference.acct);
    await accountantWork(reference.ctx, reference.acct, RR);
    await clientLater(reference.ctx, reference.acct, RR);
  }, 120_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR, ACCT_DIR2, ACCT_DIR3, REF_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('client: creates the copy; afterwards forms, estimates and statements on or before the dividing date are locked', async () => {
    transfer = (await createAccountantCopy(client.ctx, { dividingDate: DIVIDING, dataDir: CLIENT_DIR })).buffer;
    const locked = { code: 'CONFLICT', details: expect.objectContaining({ accountantCopy: true, side: 'client' }) };
    const { ctx, acct } = client;
    await expect(createInvoice(ctx, { customerId: R.acme, date: d('2026-03-01'), lines: [svc('x', '1', acct)] })).rejects.toMatchObject(locked);
    await expect(voidInvoice(ctx, R.invC)).rejects.toMatchObject(locked);
    await expect(createEstimate(ctx, { customerId: R.acme, date: d('2026-03-01'), lines: [{ description: 'x', quantity: 1, rate: '1' }] })).rejects.toMatchObject(locked);
    await expect(updateSalesOrderStatus(ctx, R.soB, 'void')).rejects.toMatchObject(locked);
    await expect(startReconciliation(ctx, { bankAccountId: R.bank, statementDate: d('2026-03-31'), statementBalance: '1' })).rejects.toMatchObject(locked);
    await expect(undoLastReconciliation(ctx, R.bank)).rejects.toMatchObject(locked);
    L = await clientLater(ctx, acct, R);
  });

  it('accountant: refuses work after the dividing date, on the client’s later records, and what QB forbids', async () => {
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: client.ctx.companyId, userId: client.ctx.userId };
    const { acct } = client;
    const locked = { code: 'CONFLICT', details: expect.objectContaining({ accountantCopy: true, side: 'accountant' }) };
    await expect(createInvoice(actx, { customerId: R.acme, date: d('2026-04-01'), lines: [svc('x', '1', acct)] })).rejects.toMatchObject(locked);
    await expect(createEstimate(actx, { customerId: R.acme, date: d('2026-04-01'), lines: [{ description: 'x', quantity: 1, rate: '1' }] })).rejects.toMatchObject(locked);
    // invP (April) is the client's: no edits, no payments or credits applied to it.
    await expect(updateInvoice(actx, R.invP, { customerId: R.acme, date: d('2026-04-02'), lines: [svc('x', '1', acct)] })).rejects.toMatchObject(locked);
    await expect(
      receivePayment(actx, { customerId: R.acme, date: d('2026-03-30'), method: 'check', amount: '10', depositAccountId: acct['1050'], applications: [{ invoiceId: R.invP, amountApplied: '10' }] }),
    ).rejects.toMatchObject(locked);
    await expect(applyToInvoice(actx, { creditMemoId: R.cmA, invoiceId: R.invP, amount: '5', date: d('2026-03-30') })).rejects.toMatchObject(locked);
    await expect(startReconciliation(actx, { bankAccountId: R.bank, statementDate: d('2026-04-30'), statementBalance: '1' })).rejects.toMatchObject(locked);
    // Conversions and refunds can't be rebuilt on the client's side.
    await expect(convertToInvoice(actx, R.estA)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(refundCreditMemo(actx, { creditMemoId: R.cmA, bankAccountId: acct['1000'], amount: '5', date: d('2026-03-30') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Structural list changes (QB: hierarchy, type, accounts) are refused; everyday fields are not.
    await expect(updateItem(actx, R.consulting, { type: 'non_inventory' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateItem(actx, R.widget, { incomeAccountId: acct['4100'] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateCustomer(actx, R.acme, { parentId: R.acme })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await accountantChanges(actx)).summary).toEqual([]);
  });

  it('accountant: does the work; every change is listed in plain language and exported (format 3)', async () => {
    N = await accountantWork(actx, client.acct, R);
    const c = await accountantChanges(actx);
    expect(c.warnings).toEqual([]);
    const docs = c.documents.map((x) => `${x.type}:${x.op}`).sort();
    expect(docs).toEqual(
      [
        'bill:add', 'bill:edit', 'bill:void',
        'bill_payment:add', 'bill_payment:edit', 'bill_payment:void',
        'credit_memo:add', 'credit_memo:edit', 'credit_memo:void',
        'estimate:add', 'estimate:edit',
        'inventory_adjustment:add',
        'invoice:add', 'invoice:edit', 'invoice:void',
        'item_receipt:add', 'item_receipt:edit', 'item_receipt:void',
        'payment_received:add', 'payment_received:edit', 'payment_received:void',
        'purchase_order:add', 'purchase_order:edit', 'purchase_order:void',
        'sales_order:add', 'sales_order:edit', 'sales_order:void',
        'sales_receipt:add', 'sales_receipt:edit', 'sales_receipt:void',
        'vendor_credit:add', 'vendor_credit:edit', 'vendor_credit:void',
      ].sort(),
    );
    // Forms the accountant only applied something to are NOT reported as changed (invA got a
    // re-applied payment, billN a vendor credit, invN a payment and a credit).
    expect(c.documents.find((x) => x.id === R.invA)).toBeUndefined();
    expect(c.documents.filter((x) => x.id === N.billN).map((x) => x.op)).toEqual(['add']);
    expect(c.names.map((n) => `${n.type}:${n.op}`).sort()).toEqual(['customer:add', 'customer:edit', 'item:add', 'item:edit', 'other_name:add', 'vendor:add']);
    expect(c.names.find((n) => n.op === 'edit' && n.type === 'customer')?.after).toMatchObject({ phone: '555-0199' });
    expect(c.applications.map((a) => `${a.kind}:${a.op}`).sort()).toEqual([
      'credit_memo:apply',
      'credit_memo:apply',
      'credit_memo:unapply',
      'journal:apply',
      'vendor_credit:apply',
      'vendor_credit:apply',
    ]);
    expect(c.reconciliations.map((r) => r.op)).toEqual(['undo', 'reconcile', 'reconcile']);
    expect(c.transactions.map((t) => `${t.type}:${t.op}`).sort()).toEqual(['deposit:add', 'expense:add', 'expense:add', 'expense:add']);
    // The summary reads like the client's review.
    const titles = c.summary.map((s) => s.title).join('\n');
    expect(titles).toMatch(/New: Invoice #AC-1 for NewCo LLC, 2026-03-10/);
    expect(titles).toMatch(/Apply credit memo #\S+ \(Acme Corp\) to invoice #\S+ \(Acme Corp\)/);
    expect(titles).toMatch(/Undo the reconciliation of 1000 · Checking for the statement ending 2026-02-28/);
    const out = await exportChangesFile(actx, { note: 'Year-end clean-up' });
    expect(parseChangesFile(out.buffer).formatVersion).toBe(CHANGES_FORMAT_VERSION);
    expect(out.counts).toMatchObject({ documents: 33, names: 6, applications: 6, reconciliations: 3, transactions: 4 });
    changes = out.buffer;
  });

  it('client: the review lists every change with amounts and before / after', async () => {
    const review = await reviewChangesFile(client.ctx, changes);
    expect(review.canImport).toBe(true);
    expect(review.formatVersion).toBe(3);
    expect(review.counts).toMatchObject({ added: 16, changed: 11, voided: 10, lists: 6, applications: 6, reconciliations: 3 });
    const byKey = (k: string) => review.items.find((i) => i.key === k)!;
    const invEdit = byKey(`invoice:edit:${R.invB}`);
    expect(invEdit.before?.join(' ')).toMatch(/1 × \$500\.00/);
    expect(invEdit.after?.join(' ')).toMatch(/1 × \$600\.00 = \$600\.00/);
    expect(invEdit.amount).toBe('600.00');
    expect(byKey(`invoice:add:${N.invN}`)).toMatchObject({ amount: '500.00', date: '2026-03-10' });
    expect(byKey(`invoice:add:${N.invN}`).after?.join(' ')).toMatch(/Audit Service — 2 × \$250\.00 = \$500\.00/);
    expect(byKey(`payment_received:add:${N.pN}`).after?.join(' ')).toMatch(/Applied \$450\.00 to new invoice #AC-1 \(NewCo LLC\)/);
    expect(byKey(`payment_received:edit:${R.payA}`).before?.join(' ')).toMatch(/Applied \$300\.00 to invoice/);
    expect(byKey(`bill:void:${R.billC}`)).toMatchObject({ op: 'void', amount: '90.00' });
    expect(byKey(`customer:edit:${R.acme}`).after).toContain('phone: 555-0100 → 555-0199');
    expect(review.items.find((i) => i.kind === 'Reconciliation' && i.op === 'reconcile' && i.date === '2026-03-31')?.after?.join(' ')).toMatch(/Service charge \$5\.00/);
    expect(review.items.filter((i) => i.problem)).toEqual([]);
  });

  it('client: a failing change rolls back the whole import, with an error naming that change', async () => {
    const { sha256: _s, ...body } = parseChangesFile(changes);
    const bad = JSON.parse(JSON.stringify(body)) as ChangesFileBody;
    const pay = bad.documents.find((x) => x.type === 'payment_received' && x.op === 'add')!;
    ((pay as unknown as { after: { applications: Array<{ amountApplied: string }> } }).after.applications[0]).amountApplied = '9999.00';
    const before = await tbByCode(client.ctx);
    const invoicesBefore = (await client.db.select().from(invoices).where(eq(invoices.companyId, client.ctx.companyId))).length;
    await expect(importChangesFile(client.ctx, serializeChangesFile(bad))).rejects.toMatchObject({
      message: expect.stringMatching(/^Could not import the new payment from NewCo LLC #N-1: .*Nothing was imported\.$/),
    });
    expect(await tbByCode(client.ctx)).toEqual(before);
    expect((await client.db.select().from(invoices).where(eq(invoices.companyId, client.ctx.companyId))).length).toBe(invoicesBefore);
    expect((await client.db.select().from(customers).where(and(eq(customers.companyId, client.ctx.companyId), eq(customers.displayName, 'NewCo LLC')))).length).toBe(0);
    const [r] = await client.db.select().from(reconciliations).where(eq(reconciliations.id, R.reconA));
    expect(r.status).toBe('completed');
    expect((await accountantCopyStatus(client.ctx)).mode).toBe('client');
  });

  it('client: a crafted file touching a record dated after the dividing date is refused', async () => {
    const { sha256: _s, ...body } = parseChangesFile(changes);
    const [z] = await client.db.select().from(invoices).where(eq(invoices.id, L.invZ));
    const crafted = serializeChangesFile({
      ...body,
      documents: [...body.documents, { op: 'void', type: 'invoice', id: L.invZ, baseVersion: z.updatedAt.toISOString(), baseDigest: null }],
    });
    await expect(importChangesFile(client.ctx, crafted)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/dated after the dividing date/) });
    const lateApp = serializeChangesFile({
      ...body,
      applications: [...body.applications, { op: 'apply', kind: 'credit_memo', id: R.cmA, creditMemoId: R.cmA, invoiceId: L.invZ, amount: '1.00', date: d('2026-03-30').toISOString() }],
    });
    await expect(reviewChangesFile(client.ctx, lateApp)).rejects.toMatchObject({ message: expect.stringMatching(/dated after the dividing date/) });
    const lateDoc = JSON.parse(JSON.stringify(body)) as ChangesFileBody;
    (lateDoc.documents.find((x) => x.op === 'add' && x.type === 'bill') as unknown as { after: { date: string } }).after.date = d('2026-04-01').toISOString();
    await expect(importChangesFile(client.ctx, serializeChangesFile(lateDoc))).rejects.toMatchObject({ message: expect.stringMatching(/after the dividing date/) });
    const [still] = await client.db.select().from(invoices).where(eq(invoices.id, L.invZ));
    expect(still.status).not.toBe('void');
  });

  it('client: changes in a closed period need the closing-date password; with it everything imports', async () => {
    await setClosingDate(client.ctx, { closingDate: '2026-02-28' });
    expect((await reviewChangesFile(client.ctx, changes)).needsClosingPassword).toBe(true);
    await expect(importChangesFile(client.ctx, changes)).rejects.toMatchObject({ code: 'PERIOD_CLOSED', message: expect.stringMatching(/^Could not import the /) });
    expect((await accountantCopyStatus(client.ctx)).mode).toBe('client');

    const res = await importChangesFile({ ...client.ctx, closingDateOverride: true }, changes);
    expect(res.trialBalance.balanced).toBe(true);
    expect(res.applied).toEqual({ accounts: 0, classes: 0, names: 6, added: 16, changed: 11, voided: 10, applications: 6, reconciliations: 3 });
    await setClosingDate({ ...client.ctx, closingDateOverride: true }, { closingDate: null });
    expect((await accountantCopyStatus(client.ctx)).mode).toBe('none');
  });

  it('client: the books equal the independently computed reference (every account), and match the accountant at the dividing date', async () => {
    expect((await trialBalance(client.ctx)).balanced).toBe(true);
    expect(await tbByCode(client.ctx)).toEqual(await tbByCode(reference.ctx));
    expect(await tbByCode(client.ctx, endOfDay(DIVIDING))).toEqual(await tbByCode(reference.ctx, endOfDay(DIVIDING)));
    expect(await tbByCode(client.ctx, endOfDay(DIVIDING))).toEqual(await tbByCode(actx, endOfDay(DIVIDING)));
    // A few balances by hand: A/P = 275 + 400 + 300 - 60 - 30 - 150 - 270 = 465 (bills less credits and payments).
    const tb = await trialBalance(client.ctx);
    const ap = tb.rows.find((r) => r.code === '2000')!;
    expect(ap.credit).toBe('465.00');
  });

  it('client: ids of records the accountant created are mapped to the new client records', async () => {
    const { db, ctx } = client;
    const [newCo] = await db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, 'NewCo LLC')));
    expect(newCo.id).not.toBe(N.newCo);
    const [invN] = await db.select().from(invoices).where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.refNumber, 'AC-1')));
    expect(invN.id).not.toBe(N.invN);
    expect(invN.customerId).toBe(newCo.id);
    expect(invN.balanceDue).toBe('0.00'); // 450 paid + 50 credit memo
    const [pN] = await db.select().from(paymentsReceived).where(and(eq(paymentsReceived.companyId, ctx.companyId), eq(paymentsReceived.reference, 'N-1')));
    const [app] = await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, pN.id));
    expect(app.invoiceId).toBe(invN.id);
    const [cmN] = await db.select().from(creditMemos).where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.customerId, newCo.id)));
    const [cmApp] = await db.select().from(creditApplications).where(eq(creditApplications.creditMemoId, cmN.id));
    expect(cmApp.invoiceId).toBe(invN.id);
    const [audit] = await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, 'Audit Service')));
    expect(audit.id).not.toBe(N.auditSvc);
    const [auditVendor] = await db.select().from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.displayName, 'Audit Partners')));
    const [billN] = await db.select().from(bills).where(and(eq(bills.companyId, ctx.companyId), eq(bills.vendorId, auditVendor.id)));
    expect(billN.balanceDue).toBe('0.00'); // 270 cash + 30 vendor credit
    const [bpN] = await db.select().from(billPayments).where(and(eq(billPayments.companyId, ctx.companyId), eq(billPayments.reference, '2001')));
    const [bpApp] = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.billPaymentId, bpN.id));
    expect(bpApp.billId).toBe(billN.id);
    const [vcN] = await db.select().from(vendorCredits).where(and(eq(vendorCredits.companyId, ctx.companyId), eq(vendorCredits.vendorId, auditVendor.id)));
    expect(vcN.unapplied).toBe('0.00');
    expect((await db.select().from(otherNames).where(and(eq(otherNames.companyId, ctx.companyId), eq(otherNames.name, 'Petty Cash Person')))).length).toBe(1);
    const [acme] = await db.select().from(customers).where(eq(customers.id, R.acme));
    expect(acme.phone).toBe('555-0199');
    const [consulting] = await db.select().from(items).where(eq(items.id, R.consulting));
    expect(consulting.salesPrice).toBe('120.00');
  });

  it('client: every form type was created, changed or voided through its service', async () => {
    const { db } = client;
    const one = async <T>(rows: Promise<T[]>) => (await rows)[0];
    expect((await one(db.select().from(invoices).where(eq(invoices.id, R.invC))))?.status).toBe('void');
    expect((await one(db.select().from(invoices).where(eq(invoices.id, R.invB))))?.total).toBe('600.00');
    // invB: 100 (payA) + 100 (client's April payment) + 50 (credit memo A) + 40 (journal credit).
    expect((await one(db.select().from(invoices).where(eq(invoices.id, R.invB))))?.balanceDue).toBe('310.00');
    expect((await one(db.select().from(invoices).where(eq(invoices.id, R.invA))))?.balanceDue).toBe('800.00'); // 1000 - 200 (credit memo C unapplied)
    expect((await one(db.select().from(salesReceipts).where(eq(salesReceipts.id, R.srA))))?.total).toBe('90.00');
    expect((await one(db.select().from(salesReceipts).where(eq(salesReceipts.id, R.srB))))?.status).toBe('void');
    expect((await one(db.select().from(creditMemos).where(eq(creditMemos.id, R.cmA))))?.total).toBe('120.00');
    expect((await one(db.select().from(creditMemos).where(eq(creditMemos.id, R.cmB))))?.status).toBe('void');
    expect((await one(db.select().from(creditMemos).where(eq(creditMemos.id, R.cmC))))?.unapplied).toBe('25.00');
    expect((await one(db.select().from(paymentsReceived).where(eq(paymentsReceived.id, R.payB))))?.voidedAt).not.toBeNull();
    expect((await one(db.select().from(bills).where(eq(bills.id, R.billB))))?.total).toBe('275.00');
    expect((await one(db.select().from(bills).where(eq(bills.id, R.billC))))?.status).toBe('void');
    expect((await one(db.select().from(vendorCredits).where(eq(vendorCredits.id, R.vcA))))?.unapplied).toBe('0.00');
    expect((await one(db.select().from(vendorCredits).where(eq(vendorCredits.id, R.vcB))))?.status).toBe('void');
    expect((await one(db.select().from(billPayments).where(eq(billPayments.id, R.bpA))))?.amount).toBe('150.00');
    expect((await one(db.select().from(billPayments).where(eq(billPayments.id, R.bpB))))?.voidedAt).not.toBeNull();
    expect((await one(db.select().from(itemReceipts).where(eq(itemReceipts.id, R.irB))))?.voidedAt).not.toBeNull();
    expect((await one(db.select().from(itemReceipts).where(eq(itemReceipts.id, R.irA))))?.total).toBe('80.00');
    const [widget] = await db.select().from(items).where(eq(items.id, R.widget));
    expect(Number(widget.quantityOnHand)).toBe(12); // 8 + 5 - 1
    expect((await one(db.select().from(estimates).where(eq(estimates.id, R.estA))))).toMatchObject({ total: '1100.00', status: 'rejected' });
    expect((await one(db.select().from(salesOrders).where(eq(salesOrders.id, R.soA))))?.total).toBe('150.00');
    expect((await one(db.select().from(salesOrders).where(eq(salesOrders.id, R.soB))))?.status).toBe('void');
    expect((await one(db.select().from(purchaseOrders).where(eq(purchaseOrders.id, R.poA))))?.total).toBe('24.00');
    expect((await one(db.select().from(purchaseOrders).where(eq(purchaseOrders.id, R.poB))))?.status).toBe('void');
    const newEst = await db.select().from(estimates).where(and(eq(estimates.companyId, client.ctx.companyId), eq(estimates.total, '900.00')));
    expect(newEst.map((e) => e.status)).toEqual(['accepted']);
    // The General Journal credit was applied to invoice B; credit memo C's application removed.
    const ja = await db.select().from(journalItemApplications).where(eq(journalItemApplications.journalEntryId, R.je));
    expect(ja.map((a) => [a.invoiceId, a.amount])).toEqual([[R.invB, '40.00']]);
    expect(await db.select().from(creditApplications).where(eq(creditApplications.creditMemoId, R.cmC))).toEqual([]);
  });

  it('client: the reconciliations were undone and redone, clearing the lines of the re-created forms', async () => {
    const { db, ctx } = client;
    const recons = await db
      .select({ id: reconciliations.id, status: reconciliations.status, date: reconciliations.statementDate, balance: reconciliations.statementBalance })
      .from(reconciliations)
      .where(eq(reconciliations.bankAccountId, R.bank));
    expect(recons.find((r) => r.id === R.reconA)?.status).toBe('undone');
    expect(recons.filter((r) => r.status === 'completed').map((r) => r.balance).sort()).toEqual(['10010.00', '9850.00']);
    const [ba] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, R.bank));
    expect(ba.lastReconciledBalance).toBe('10010.00');
    // Nothing on or before March 31 is left uncleared on Checking except what the accountant left.
    const open = await listClearable(ctx, R.bank, endOfDay('2026-03-31'));
    expect(open.map((l) => l.debit ?? l.credit).sort()).toEqual([]);
    // The service charge entry was re-made by the reconciliation itself.
    const sc = await db.select().from(journalEntries).where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.description, 'Bank service charge')));
    expect(sc).toHaveLength(1);
  });

  it('a format 2 changes file (from before this version) still imports', async () => {
    const second = await createAccountantCopy(client.ctx, { dividingDate: '2026-04-30', dataDir: CLIENT_DIR });
    await openAccountantCopyFile(second.buffer, ACCT_DIR2);
    const a2: ServiceContext = { db: await getDb(ACCT_DIR2), companyId: client.ctx.companyId, userId: client.ctx.userId };
    await createManualEntry(a2, {
      date: d('2026-04-30'),
      description: 'April accrual',
      lines: [
        { accountId: client.acct['6400'], debit: '700.00' },
        { accountId: client.acct['2000'], credit: '700.00', entityType: 'vendor', entityId: R.supplier },
      ],
    });
    const out = await exportChangesFile(a2, {});
    await closeDb(ACCT_DIR2);
    // Rewrite it the way an older Ironbooks wrote it: format 2, no format-3 arrays or ids.
    const { sha256: _s, ...body } = parseChangesFile(out.buffer);
    const { names: _n, documents: _d, applications: _a, reconciliations: _r, ...rest } = body;
    const v2 = {
      ...rest,
      formatVersion: 2,
      transactions: rest.transactions.map((t) => (t.op === 'void' || t.type !== 'journal_entry' ? t : { ...t, after: (({ postedId: _p, ...a }) => a)(t.after) })),
    };
    const file = serializeChangesFile(v2 as unknown as ChangesFileBody);
    const review = await reviewChangesFile(client.ctx, file);
    expect(review).toMatchObject({ formatVersion: 2, canImport: true, counts: { added: 1, applications: 0, reconciliations: 0 } });
    const res = await importChangesFile(client.ctx, file);
    expect(res.applied).toMatchObject({ added: 1 });
    expect(res.trialBalance.balanced).toBe(true);
    const [row] = await client.db.select().from(accountantCopies).where(eq(accountantCopies.id, second.copy.id));
    expect(row.status).toBe('imported');
    const [rent] = (await trialBalance(client.ctx)).rows.filter((r) => r.code === '6400');
    expect(rent.debit).toBe('700.00');
  });

  it('record locking: a name both sides changed is refused; journal charges paid, credits taken off and lines of new entries resolve', async () => {
    const { db, ctx, acct } = client;
    const third = await createAccountantCopy(ctx, { dividingDate: '2026-05-31', dataDir: CLIENT_DIR });
    const [newCo] = await db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, 'NewCo LLC')));
    const [auditVendor] = await db.select().from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.displayName, 'Audit Partners')));
    // The client may still edit names while the copy is out (no deletes / merges).
    await updateCustomer(ctx, newCo.id, { email: 'billing@newco.test' });

    await openAccountantCopyFile(third.buffer, ACCT_DIR3);
    const a3: ServiceContext = { db: await getDb(ACCT_DIR3), companyId: ctx.companyId, userId: ctx.userId };
    // A General Journal charge to Acme, paid in Receive Payments (a line of an entry the import re-creates).
    const charge = await createManualEntry(a3, {
      date: d('2026-05-10'),
      description: 'Rebill of shipping',
      lines: [
        { accountId: acct['1200'], debit: '75.00', entityType: 'customer', entityId: R.acme },
        { accountId: acct['4100'], credit: '75.00' },
      ],
    });
    const [chargeLine] = await a3.db.select().from(journalEntryLines).where(and(eq(journalEntryLines.journalEntryId, charge.id), eq(journalEntryLines.accountId, acct['1200'])));
    await receivePayment(a3, {
      customerId: R.acme,
      date: d('2026-05-15'),
      method: 'check',
      reference: 'JC-1',
      amount: '75',
      depositAccountId: acct['1050'],
      applications: [],
      journalItems: [{ journalLineId: chargeLine.id, amount: '75' }],
    });
    // Take the General Journal credit off invoice B again, and part of vendor credit A off bill B.
    const [ja] = await a3.db.select().from(journalItemApplications).where(eq(journalItemApplications.journalEntryId, R.je));
    await unapplyJournalApplication(a3, ja.id);
    await unapplyFromBill(a3, { vendorCreditId: R.vcA, billId: R.billB, amount: '20' });
    // Names: one the client changed too (conflict), one only the accountant changed.
    await updateCustomer(a3, newCo.id, { email: 'accounts@newco.test' });
    await updateVendor(a3, auditVendor.id, { phone: '555-0300' });
    const out = await exportChangesFile(a3, {});
    const accountantTbAtDividing = await tbByCode(a3, endOfDay('2026-05-31'));
    await closeDb(ACCT_DIR3);

    const review = await reviewChangesFile(ctx, out.buffer);
    expect(review.canImport).toBe(false);
    expect(review.items.find((i) => i.key === `customer:edit:${newCo.id}`)?.problem).toMatch(/changed in your file/);
    expect(review.items.find((i) => i.key === `vendor:edit:${auditVendor.id}`)?.problem).toBeNull();
    await expect(importChangesFile(ctx, out.buffer)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/^Could not import the change to customer NewCo LLC: This record was changed in your file/),
    });
    const [stillMine] = await db.select().from(customers).where(eq(customers.id, newCo.id));
    expect(stillMine.email).toBe('billing@newco.test');

    // Without the conflicting change the file imports.
    const { sha256: _s, ...body } = parseChangesFile(out.buffer);
    const ok = serializeChangesFile({ ...body, names: body.names.filter((n) => n.id !== newCo.id) });
    expect((await reviewChangesFile(ctx, ok)).canImport).toBe(true);
    const res = await importChangesFile(ctx, ok);
    expect(res.applied).toMatchObject({ names: 1, added: 2, applications: 2 });
    expect(res.trialBalance.balanced).toBe(true);
    expect(await tbByCode(ctx, endOfDay('2026-05-31'))).toEqual(accountantTbAtDividing);

    // The payment paid the client's copy of the new journal entry's A/R line.
    const [jc] = await db.select().from(paymentsReceived).where(and(eq(paymentsReceived.companyId, ctx.companyId), eq(paymentsReceived.reference, 'JC-1')));
    const [paid] = await db.select().from(journalItemApplications).where(eq(journalItemApplications.paymentId, jc.id));
    const [line] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, paid.journalLineId));
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, line.journalEntryId));
    expect(entry.description).toBe('Rebill of shipping');
    expect(entry.id).not.toBe(charge.id);
    expect(paid.amount).toBe('75.00');
    expect(await db.select().from(journalItemApplications).where(eq(journalItemApplications.journalEntryId, R.je))).toEqual([]);
    const [invB] = await db.select().from(invoices).where(eq(invoices.id, R.invB));
    expect(invB.balanceDue).toBe('350.00');
    const [billB] = await db.select().from(bills).where(eq(bills.id, R.billB));
    expect(billB.balanceDue).toBe('235.00'); // 275 - (60 - 20) credited, its payment voided
    const [v] = await db.select().from(vendors).where(eq(vendors.id, auditVendor.id));
    expect(v.phone).toBe('555-0300');
  });
});
