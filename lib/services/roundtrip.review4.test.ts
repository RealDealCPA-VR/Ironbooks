/**
 * Review round 4 — ROUND-TRIP FIDELITY of every way data leaves and re-enters a company file.
 *
 * One rich company is built through the real services (every module and document type, sales
 * tax, foreign currency, average + FIFO inventory with sites, serial / lot tracking and an
 * assembly, attachments, custom fields, memorized reports, a recurring template, users and a
 * custom role, preferences, a closing date and a completed reconciliation). A FINGERPRINT of it
 * is compared before and after each round trip:
 *   trial balance on several dates, cash-basis P&L, A/R + A/P aging, inventory valuation (now and
 *   as of a date), site / serial / lot stock, the sales tax liability per agency, every list with
 *   its key fields, every document's totals / status / open balance / lines, reconciliations,
 *   attachments readable from disk, and users able to log in.
 * Ids differ after a per-company restore, so the fingerprint names everything (accounts by code,
 * names by display name, documents by number) and replaces embedded ids with those names.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import * as S from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate, updateCompany } from './company';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createItem } from './items';
import { createClass } from './dimensions';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createSalesReceipt } from './salesReceipts';
import { createDeposit } from './deposits';
import { createCreditMemo } from './creditMemos';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { createExpense } from './expenses';
import { createTransfer } from './transfers';
import { createEstimate } from './estimates';
import { createSalesOrder } from './salesOrders';
import { createPurchaseOrder } from './purchaseOrders';
import { createItemReceipt } from './itemReceipts';
import { createVendorCredit } from './vendorCredits';
import { createManualEntry, voidEntry } from './journal';
import { createBankAccount } from './bankAccounts';
import { completeReconciliation, listClearable, startReconciliation, toggleCleared } from './reconcile';
import { createTaxAgency, createTaxRate } from './salesTax';
import { setBaseCurrency, setAccountCurrency, upsertCurrency } from './currencies';
import { createSite } from './inventorySites';
import { adjustQuantityAtSite } from './inventorySiteOps';
import { createInventoryTransfer } from './inventoryTransfers';
import { serialLotInStock } from './inventorySiteReports';
import { setBom, buildAssembly } from './assemblies';
import { inventoryValuation, inventoryValuationAsOf } from './inventory';
import { setCustomFieldDefinitions, setEntityCustomFields } from './customFields';
import { createMemorizedGroup, saveMemorizedReport } from './memorizedReports';
import { createTemplate } from './recurring';
import { addUser, createRole } from './users';
import { updateMyPreferences } from './preferences';
import { saveAttachment, safeAttachmentPath } from './attachments';
import { trialBalance } from './reports';
import { profitAndLossCashBasis } from './cashBasisReports';
import { agingSummary } from './reportsAging';
import { salesTaxLiabilityReport } from './accountant/salesTaxLedger';
import { resolveAccess } from './access';
import { verifyPassword } from '@/lib/auth';
import { verifyTransactionLog } from './transactionLog';
import { createBackup, restoreBackup, createCompanyBackup, restoreCompanyBackup } from './backup';
import AdmZip from 'adm-zip';
import { createPortableCompanyFile, restorePortableCompanyFile } from './portableFile';
import { condensePeriod, listCondenseArchives, restoreCondenseArchive } from './condense';
import { createPeriodCopy } from './periodCopy';
import { discardSandbox, keepSandboxAsTraining, startSandbox } from './sandbox';
import { createAccountantCopy, importChangesFile, reviewChangesFile } from './accountantCopy/client';
import { exportChangesFile, openAccountantCopyFile } from './accountantCopy/accountant';
import { reclassifyLines } from './accountant/reclassify';
import { voidPayment } from './payments';
import { exportJournalIif, exportListsIif } from './iifExport';
import { importAccountsCSV, importCustomersCSV, importIIF, importItemsCSV, importVendorsCSV } from './qbImport';
import { exportListCsv } from './listExport';
import { commitUndo, performUndo, prepareUndo } from './undo';
import { updateInvoice } from './invoices';
import { updatePayment } from './payments';
import { updateVendorCredit } from './vendorCredits';
import { updateSalesReceipt } from './salesReceipts';
import { updateBillPayment } from './billPayments';
import { buildShareableLedgerXlsx } from './shareableLedger';
import { runGlImport } from './qbGlImport';
import { updateBill, voidBill } from './bills';
import { updateCreditMemo } from './creditMemos';
import { updateEntry } from './journal';
import { updateEstimate } from './estimates';
import { updatePurchaseOrder } from './purchaseOrders';
import { updateCustomer } from './customers';
import { updateItem } from './items';
import { updateAccount } from './accounts';
import { CSV_FIELDS, autoMapColumns } from '@/app/qb-import/ListImport';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-roundtrip');
const SRC = path.join(ROOT, 'source');
const PASSWORD = 'R0und-Trip!Pass';
const COMPANY = 'Round Trip Co';

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every data dir this suite opened (closed in afterAll). */
const opened = new Set<string>();
async function open(dir: string): Promise<DB> {
  opened.add(path.resolve(dir));
  return getDb(dir);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

type Refs = Record<string, string>;
interface Seeded {
  ctx: ServiceContext;
  acct: Refs;
  R: Refs;
}

async function acctMap(db: DB, companyId: string): Promise<Refs> {
  const out: Refs = {};
  for (const a of await db.select().from(S.accounts).where(eq(S.accounts.companyId, companyId))) out[a.code] = a.id;
  return out;
}

async function seed(db: DB, dir: string): Promise<Seeded> {
  process.env.BKA_DATA_DIR = dir; // attachments + pre-op backups follow the active file
  const [owner] = await db
    .insert(S.users)
    .values({ email: 'owner@review4.test', name: 'Owner Person', passwordHash: await (await import('@/lib/auth')).hashPassword(PASSWORD) })
    .returning();
  const company = await createCompany(db, { name: COMPANY, ownerId: owner.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: owner.id };
  const acct = await acctMap(db, company.id);
  const R: Refs = {};

  // ---- Company set-up: currencies, sales tax, classes, sites, custom fields, preferences ----
  await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
  acct['1020'] = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
  await setAccountCurrency(ctx, acct['1020'], 'EUR');
  const agency = await createTaxAgency(ctx, { name: 'State DOR', liabilityAccountId: acct['2200'] });
  R.tax = (await createTaxRate(ctx, { name: 'State 8%', rate: '0.08', agencyId: agency.id })).id;
  R.retail = (await createClass(ctx, { name: 'Retail' })).id;
  R.wholesale = (await createClass(ctx, { name: 'Wholesale' })).id;
  R.main = (await createSite(ctx, { name: 'Main' })).id;
  R.east = (await createSite(ctx, { name: 'East' })).id;
  await setCustomFieldDefinitions(ctx, {
    customer: [{ name: 'Region' }],
    item: [{ name: 'Color' }],
    invoice: [{ name: 'Project' }],
  });
  await updateCompany(ctx, {
    settings: { legalName: 'Round Trip LLC', city: 'Springfield', defaultExpenseAccountId: acct['6300'], negativeStockWarning: true } as never,
  });
  await updateMyPreferences(ctx, { } as never).catch(() => undefined);

  // ---- Names and items ----
  R.acme = (await createCustomer(ctx, { displayName: 'Acme "Quoted" Corp', email: 'ap@acme.test', terms: 'net_15', billingAddress: { line1: '1 Main St', city: 'Springfield' } })).id;
  R.zeta = (await createCustomer(ctx, { displayName: 'Zeta Ünïcode Ltd' })).id;
  R.euro = (await createCustomer(ctx, { displayName: 'EuroCo GmbH' })).id;
  await setEntityCustomFields(ctx, 'customer', R.acme, { Region: 'North' });
  R.paper = (await createVendor(ctx, { displayName: 'Paper Supply Co', is1099: true, terms: 'net_15' })).id;
  R.parts = (await createVendor(ctx, { displayName: 'Parts Inc' })).id;
  R.consulting = (await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: '125.50', incomeAccountId: acct['4100'], taxable: false })).id;
  const inv = (name: string, extra: Record<string, unknown> = {}) =>
    createItem(ctx, { name, type: 'inventory', assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'], ...extra } as never);
  R.widget = (await inv('Widget Avg', { purchaseCost: '5', salesPrice: '12' })).id;
  R.gadget = (await inv('Gadget FIFO', { purchaseCost: '10', salesPrice: '25' })).id;
  R.phone = (await inv('Phone SN', { trackingMode: 'serial', purchaseCost: '200', salesPrice: '400' })).id;
  R.syrup = (await inv('Syrup Lot', { trackingMode: 'lot', purchaseCost: '3', salesPrice: '9' })).id;
  R.bolt = (await inv('Bolt Avg', { purchaseCost: '1', salesPrice: '2' })).id;
  R.kit = (await createItem(ctx, { name: 'Kit Assembly', type: 'inventory', assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'], salesPrice: '60' } as never)).id;
  await setEntityCustomFields(ctx, 'item', R.widget, { Color: 'Blue' });
  await setBom(ctx, R.kit, [
    { componentItemId: R.widget, quantity: 2 },
    { componentItemId: R.bolt, quantity: 4 },
  ]);
  R.bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '123456789' })).id;

  // ---- January (closed later) ----
  R.investJe = (
    await createManualEntry(ctx, { date: d('2026-01-02'), description: 'Owner investment', lines: [{ accountId: acct['1000'], debit: '50000.00' }, { accountId: acct['3000'], credit: '50000.00' }] })
  ).id;
  R.billParts = (
    await createBill(ctx, {
      vendorId: R.parts,
      billNumber: 'PI-100',
      date: d('2026-01-05'),
      lines: [
        { itemId: R.widget, quantity: 100, unitCost: '5.00' },
        { itemId: R.phone, quantity: 2, unitCost: '200.00', siteId: R.east, serialNumbers: ['SN-1', 'SN-2'] },
        { itemId: R.syrup, quantity: 10, unitCost: '3.00', lotNumber: 'LOT-A' },
        { itemId: R.bolt, quantity: 50, unitCost: '1.00' },
      ],
    })
  ).id;
  await adjustQuantityAtSite(ctx, { itemId: R.gadget, quantityChange: 20, unitCost: '10.00', date: d('2026-01-06'), costing: 'fifo', memo: 'Opening FIFO layer' });
  await adjustQuantityAtSite(ctx, { itemId: R.gadget, quantityChange: 10, unitCost: '12.00', date: d('2026-01-07') });
  await buildAssembly(ctx, { assemblyItemId: R.kit, quantity: 5, date: d('2026-01-08') } as never);
  R.invA1 = (
    await createInvoice(ctx, {
      customerId: R.acme,
      refNumber: 'A-1',
      date: d('2026-01-10'),
      dueDate: d('2026-02-09'),
      classId: R.retail,
      taxRateId: R.tax,
      customFields: { Project: 'Alpha' },
      memo: 'Thanks',
      lines: [
        { itemId: R.consulting, description: 'Strategy session', quantity: 3, rate: '125.50', taxable: false },
        { itemId: R.widget, quantity: 10, rate: '12.00' },
      ],
    })
  ).id;
  R.invA2 = (
    await createInvoice(ctx, {
      customerId: R.zeta,
      refNumber: 'A-2',
      date: d('2026-01-15'),
      dueDate: d('2026-02-14'),
      taxRateId: R.tax,
      classId: R.wholesale,
      lines: [
        { itemId: R.gadget, quantity: 8, rate: '25.00' },
        { itemId: R.phone, quantity: 1, rate: '400.00', siteId: R.east, serialNumbers: ['SN-1'] },
      ],
    })
  ).id;
  const [a1] = await db.select().from(S.invoices).where(eq(S.invoices.id, R.invA1));
  R.payA1 = (
    await receivePayment(ctx, { customerId: R.acme, date: d('2026-01-20'), method: 'check', reference: '1001', amount: a1.total, depositAccountId: acct['1050'], applications: [{ invoiceId: R.invA1, amountApplied: a1.total }] })
  ).payment.id;
  R.srSyrup = (
    await createSalesReceipt(ctx, { customerId: R.zeta, date: d('2026-01-21'), taxRateId: R.tax, depositAccountId: acct['1050'], lines: [{ itemId: R.syrup, quantity: 2, rate: '9.00', lotNumber: 'LOT-A' }] } as never)
  ).id;
  R.depJan = (await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-01-22'), paymentIds: [R.payA1], salesReceiptIds: [R.srSyrup], memo: 'Weekly deposit' })).id;
  R.billPS77 = (await createBill(ctx, { vendorId: R.paper, billNumber: 'PS-77', date: d('2026-01-12'), lines: [{ accountId: acct['6300'], description: 'Paper', amount: '310.40', classId: R.retail }] })).id;
  R.bpPS77 = (await payBills(ctx, { vendorId: R.paper, date: d('2026-01-28'), method: 'check', reference: '2001', paymentAccountId: acct['1000'], applications: [{ billId: R.billPS77, amountApplied: '310.40' }] })).id;
  R.billPS78 = (await createBill(ctx, { vendorId: R.paper, billNumber: 'PS-78', date: d('2026-01-29'), lines: [{ accountId: acct['6600'], description: 'Utilities', amount: '88.12' }] })).id;
  await createExpense(ctx, { vendorId: R.paper, date: d('2026-01-18'), method: 'credit_card', paymentAccountId: acct['2100'], lines: [{ accountId: acct['6000'], description: 'Ads', amount: '45.67' }] });
  await createTransfer(ctx, { date: d('2026-01-31'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '1000.00', memo: 'To savings' });
  const mistake = await createManualEntry(ctx, { date: d('2026-01-19'), description: 'Posted in error', lines: [{ accountId: acct['6400'], debit: '700.00' }, { accountId: acct['1000'], credit: '700.00' }] });
  await voidEntry(ctx, mistake.id);
  await createInventoryTransfer(ctx, { date: d('2026-01-25'), fromSiteId: R.main, toSiteId: R.east, lines: [{ itemId: R.widget, quantity: 10 }] } as never);

  // A January inventory invoice still open at the closing date, partly paid in March.
  R.invA5 = (
    await createInvoice(ctx, { customerId: R.zeta, refNumber: 'A-5', date: d('2026-01-26'), dueDate: d('2026-02-25'), lines: [{ itemId: R.widget, quantity: 2, rate: '12.00', taxable: false }] })
  ).id;

  // January statement: investment, the PS-77 check and the deposit cleared.
  const [dep] = await db.select().from(S.deposits).where(eq(S.deposits.id, R.depJan));
  const stmt = (50000 - 310.4 + Number(dep.total)).toFixed(2);
  const recon = await startReconciliation(ctx, { bankAccountId: R.bank, statementDate: d('2026-01-31'), statementBalance: stmt });
  for (const l of await listClearable(ctx, R.bank, eod('2026-01-31'), recon.id)) {
    if (l.debit === '50000.00' || l.credit === '310.40' || l.debit === dep.total) await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
  }
  await completeReconciliation(ctx, recon.id);

  // ---- Closed period ----
  await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'close-pw' });

  // ---- February / March ----
  R.invA3 = (
    await createInvoice(ctx, { customerId: R.acme, refNumber: 'A-3', date: d('2026-02-05'), dueDate: d('2026-03-07'), lines: [{ itemId: R.consulting, quantity: 10, rate: '100.00', taxable: false }] })
  ).id;
  R.payA3 = (
    await receivePayment(ctx, { customerId: R.acme, date: d('2026-02-20'), method: 'check', reference: '1002', amount: '400.00', depositAccountId: acct['1000'], applications: [{ invoiceId: R.invA3, amountApplied: '400.00' }] })
  ).payment.id;
  const [a2] = await db.select().from(S.invoices).where(eq(S.invoices.id, R.invA2));
  // A January invoice paid after the closing date.
  R.payA2 = (
    await receivePayment(ctx, { customerId: R.zeta, date: d('2026-02-15'), method: 'check', reference: '1003', amount: a2.total, depositAccountId: acct['1000'], applications: [{ invoiceId: R.invA2, amountApplied: a2.total }] })
  ).payment.id;
  // A January bill paid after the closing date.
  R.bpPS78 = (await payBills(ctx, { vendorId: R.paper, date: d('2026-02-10'), method: 'check', reference: '2002', paymentAccountId: acct['1000'], applications: [{ billId: R.billPS78, amountApplied: '88.12' }] })).id;
  R.cmZeta = (await createCreditMemo(ctx, { customerId: R.zeta, refNumber: 'CM-1', date: d('2026-02-10'), taxRateId: R.tax, lines: [{ itemId: R.widget, quantity: 1, rate: '12.00' }] } as never)).id;
  R.vcParts = (await createVendorCredit(ctx, { vendorId: R.parts, date: d('2026-02-12'), lines: [{ accountId: acct['6300'], description: 'Damaged', amount: '15.00' }] })).id;
  R.billGadget = (await createBill(ctx, { vendorId: R.parts, billNumber: 'PI-101', date: d('2026-02-14'), lines: [{ itemId: R.gadget, quantity: 5, unitCost: '14.00' }] })).id;
  R.invEur = (
    await createInvoice(ctx, { customerId: R.euro, refNumber: 'E-1', date: d('2026-02-18'), currency: 'EUR', exchangeRate: '1.10', lines: [{ accountId: acct['4100'], description: 'EU project', quantity: 1, rate: '1000.00', taxable: false }] } as never)
  ).id;
  R.payEur = (
    await receivePayment(ctx, { customerId: R.euro, date: d('2026-03-05'), method: 'ach', amount: '1000.00', currency: 'EUR', exchangeRate: '1.15', depositAccountId: acct['1020'], applications: [{ invoiceId: R.invEur, amountApplied: '1000.00' }] } as never)
  ).payment.id;
  await createExpense(ctx, { payeeName: 'Berlin Cafe', date: d('2026-03-10'), method: 'check', reference: 'E-101', paymentAccountId: acct['1020'], currency: 'EUR', exchangeRate: '1.12', lines: [{ accountId: acct['6000'], amount: '200.00' }] } as never);
  R.est = (await createEstimate(ctx, { customerId: R.acme, date: d('2026-02-26'), lines: [{ description: 'Phase 2', quantity: 10, rate: '125.50' }] })).id;
  R.so = (await createSalesOrder(ctx, { customerId: R.zeta, date: d('2026-02-27'), lines: [{ itemId: R.gadget, description: 'Gadgets', quantity: 3, rate: '25.00' }] } as never)).id;
  R.po = (await createPurchaseOrder(ctx, { vendorId: R.parts, date: d('2026-02-28'), lines: [{ itemId: R.widget, description: 'Widgets', quantity: 20, rate: '5.50' }] } as never)).id;
  R.ir = (await createItemReceipt(ctx, { vendorId: R.parts, date: d('2026-03-02'), lines: [{ itemId: R.widget, quantity: 20, unitCost: '5.50' }] })).id;
  R.srKit = (await createSalesReceipt(ctx, { customerId: R.acme, date: d('2026-03-15'), depositAccountId: acct['1000'], lines: [{ itemId: R.kit, quantity: 1, rate: '60.00', taxable: false }] } as never)).id;
  R.payA5 = (
    await receivePayment(ctx, { customerId: R.zeta, date: d('2026-03-10'), method: 'check', reference: '1004', amount: '12.00', depositAccountId: acct['1000'], applications: [{ invoiceId: R.invA5, amountApplied: '12.00' }] })
  ).payment.id;
  R.invA4 = (
    await createInvoice(ctx, { customerId: R.zeta, refNumber: 'A-4', date: d('2026-03-20'), dueDate: d('2026-04-19'), lines: [{ itemId: R.widget, quantity: 3, rate: '12.00' }] })
  ).id;
  R.rentJe = (
    await createManualEntry(ctx, { date: d('2026-03-31'), description: 'March rent', lines: [{ accountId: acct['6400'], debit: '500.00', classId: R.retail }, { accountId: acct['1010'], credit: '500.00' }] })
  ).id;

  // ---- Attachments, memorized reports, recurring, users / roles ----
  await saveAttachment(ctx, { entityType: 'bill', entityId: R.billPS77, filename: 'receipt.txt', mimeType: 'text/plain', base64: Buffer.from('Receipt for bill PS-77\nTotal: 310.40\n').toString('base64') });
  await saveAttachment(ctx, { entityType: 'invoice', entityId: R.invA1, filename: 'signed po.pdf', mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.4 fake signed purchase order').toString('base64') });
  await saveAttachment(ctx, { filename: 'inbox scan.png', mimeType: 'image/png', base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64') });
  const group = await createMemorizedGroup(ctx, { name: 'Monthly' } as never);
  await saveMemorizedReport(ctx, { name: 'Checking detail', reportType: 'transaction-detail-by-account', config: { params: { accountId: acct['1000'], from: '2026-01-01', to: '2026-03-31' } }, groupId: (group as { id: string }).id });
  await saveMemorizedReport(ctx, { name: 'Acme aging', reportType: 'ar-aging-detail', config: { params: { customerId: R.acme } } });
  await createTemplate(ctx, {
    name: 'Monthly retainer',
    docType: 'invoice',
    frequency: 'monthly',
    nextRunDate: '2026-11-01',
    mode: 'remind',
    template: { customerId: R.acme, classId: R.retail, lines: [{ itemId: R.consulting, quantity: 1, rate: '500.00', accountId: acct['4100'] }] },
  });
  const role = await createRole(ctx, { name: 'Reviewer', description: 'Reads reports', permissions: { reports_financial: ['view'], customers: ['view'] } as never });
  R.role = role.key;
  await addUser(ctx, { name: 'Clerk Person', login: 'clerk@review4.test', password: PASSWORD, roleKeys: [role.key] });
  await addUser(ctx, { name: 'Book Keeper', login: 'bookie@review4.test', password: PASSWORD, roleKeys: ['bookkeeper'] });
  return { ctx, acct, R };
}

async function defaultSiteId(db: DB, companyId: string): Promise<string | null> {
  const [s] = await db
    .select()
    .from(S.inventorySites)
    .where(and(eq(S.inventorySites.companyId, companyId), eq(S.inventorySites.isDefault, true)));
  return s?.id ?? null;
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

type Json = unknown;
interface Fingerprint {
  ledger: Record<string, Json>;
  inventory: Record<string, Json>;
  lists: Record<string, Json>;
  docs: Record<string, Json>;
  meta: Record<string, Json>;
  recon: Json;
  files: Json;
  users: Json;
}

const DATES = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-06-30'];

const pick = <T extends Record<string, unknown>>(o: T, keys: Array<keyof T>) =>
  Object.fromEntries(keys.map((k) => [k, o[k] instanceof Date ? (o[k] as Date).toISOString() : (o[k] ?? null)]));

async function labelMap(ctx: ServiceContext): Promise<Map<string, string>> {
  const { db, companyId } = ctx;
  const m = new Map<string, string>();
  const add = (rows: Array<{ id: string }>, f: (r: never) => string) => rows.forEach((r) => m.set(r.id, f(r as never)));
  const co = <T extends { companyId: unknown }>(t: T) => eq((t as never as { companyId: never }).companyId, companyId);
  add(await db.select().from(S.accounts).where(co(S.accounts)), (r: { code: string }) => `acct:${r.code}`);
  add(await db.select().from(S.customers).where(co(S.customers)), (r: { displayName: string }) => `cust:${r.displayName}`);
  add(await db.select().from(S.vendors).where(co(S.vendors)), (r: { displayName: string }) => `vend:${r.displayName}`);
  add(await db.select().from(S.items).where(co(S.items)), (r: { name: string }) => `item:${r.name}`);
  add(await db.select().from(S.classes).where(co(S.classes)), (r: { name: string }) => `class:${r.name}`);
  add(await db.select().from(S.taxRates).where(co(S.taxRates)), (r: { name: string }) => `rate:${r.name}`);
  add(await db.select().from(S.taxAgencies).where(co(S.taxAgencies)), (r: { name: string }) => `agency:${r.name}`);
  add(await db.select().from(S.inventorySites).where(co(S.inventorySites)), (r: { name: string }) => `site:${r.name}`);
  add(await db.select().from(S.companyRoles).where(co(S.companyRoles)), (r: { name: string }) => `role:${r.name}`);
  add(await db.select().from(S.memorizedReportGroups).where(co(S.memorizedReportGroups)), (r: { name: string }) => `mrgroup:${r.name}`);
  add(await db.select().from(S.invoices).where(co(S.invoices)), (r: { refNumber: string | null; invoiceNumber: number }) => `inv:${r.refNumber ?? r.invoiceNumber}`);
  add(await db.select().from(S.bills).where(co(S.bills)), (r: { billNumber: string | null; date: Date }) => `bill:${r.billNumber ?? r.date.toISOString().slice(0, 10)}`);
  m.set(companyId, 'company');
  return m;
}

function labeler(labels: Map<string, string>) {
  const lab = (v: Json): Json => {
    if (typeof v === 'string') return v.replace(UUID_RE, (x) => labels.get(x.toLowerCase()) ?? labels.get(x) ?? '<?>');
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(lab);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [lab(k) as string, lab(x)]));
    return v;
  };
  return lab;
}

async function tbByCode(ctx: ServiceContext, asOf: Date) {
  const tb = await trialBalance(ctx, asOf);
  return Object.fromEntries(tb.rows.map((r) => [r.code, `${r.debit}/${r.credit}`]));
}

function reportRows(r: { rows: Array<{ kind: string; cells: Record<string, unknown> }> }) {
  return Object.fromEntries(
    r.rows.map((row) => {
      const { label, ...rest } = row.cells;
      return [String(label), rest];
    }),
  );
}

async function fingerprint(ctx: ServiceContext, dir: string, opts: { users?: boolean } = {}): Promise<Fingerprint> {
  const { db, companyId } = ctx;
  const labels = await labelMap(ctx);
  const lab = labeler(labels);
  const co = <T>(t: T) => eq((t as never as { companyId: never }).companyId, companyId);

  // ---- Ledger ----
  const ledger: Record<string, Json> = {};
  for (const day of DATES) ledger[`tb ${day}`] = await tbByCode(ctx, eod(day));
  for (const [from, to] of [['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-31'], ['2026-01-01', '2026-06-30']]) {
    const pl = await profitAndLossCashBasis(ctx, { from: d(from), to: eod(to) });
    ledger[`cash P&L ${from}..${to}`] = { net: pl.netIncome, accrual: pl.accrualNetIncome };
  }
  for (const day of ['2026-02-28', '2026-06-30']) {
    ledger[`AR aging ${day}`] = reportRows(await agingSummary(ctx, { asOf: day } as never, 'ar'));
    ledger[`AP aging ${day}`] = reportRows(await agingSummary(ctx, { asOf: day } as never, 'ap'));
  }
  for (const day of ['2026-01-31', '2026-06-30']) {
    const st = await salesTaxLiabilityReport(ctx, { to: eod(day), basis: 'accrual' });
    ledger[`sales tax ${day}`] = Object.fromEntries(
      (st.agencies as unknown as Array<Record<string, unknown>>).map((a) => [String(a.agencyName ?? 'none'), pick(a, ['openingBalance', 'collected', 'credited', 'paid', 'balance', 'unattributed'] as never)]),
    );
  }
  ledger.txlog = (await verifyTransactionLog(db, dir)).ok;

  // ---- Inventory ----
  const inventory: Record<string, Json> = {};
  const val = await inventoryValuation(ctx);
  inventory.valuation = { total: val.grandTotal, items: Object.fromEntries(val.items.map((i) => [i.name, `${i.quantityOnHand}@${i.averageCost}=${i.totalValue} ${i.costingMethod}`])) };
  for (const day of ['2026-01-31', '2026-03-31']) {
    const v = await inventoryValuationAsOf(ctx, eod(day));
    inventory[`asOf ${day}`] = { total: v.grandTotal, items: Object.fromEntries(v.items.map((i) => [i.name, i.valueAsOf])) };
  }
  const layers = await db.select().from(S.inventoryLayers).where(co(S.inventoryLayers)).orderBy(asc(S.inventoryLayers.date), asc(S.inventoryLayers.createdAt));
  // Value-bearing layers (an emptied layer carries no stock and no value).
  inventory.layers = layers
    .filter((l) => Number(l.quantityRemaining) !== 0)
    .map((l) => `${labels.get(l.itemId)} ${l.date.toISOString().slice(0, 10)} ${l.quantityRemaining}@${l.unitCost}`)
    .sort();
  const stock = await serialLotInStock(ctx);
  inventory.serialLot = lab(stock) as Json;
  const moves = await db.select().from(S.inventoryMovements).where(co(S.inventoryMovements));
  const bySite = new Map<string, number>();
  for (const mv of moves) {
    const k = `${labels.get(mv.itemId)} @ ${labels.get(mv.siteId)}`;
    bySite.set(k, (bySite.get(k) ?? 0) + Number(mv.quantity));
  }
  inventory.movementsBySite = Object.fromEntries([...bySite].sort().map(([k, v]) => [k, v.toFixed(4)]));

  // ---- Lists ----
  const lists: Record<string, Json> = {};
  const byKey = <T>(rows: T[], key: (r: T) => string, val: (r: T) => Json) =>
    Object.fromEntries(rows.map((r) => [key(r), lab(val(r))]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  lists.accounts = byKey(await db.select().from(S.accounts).where(co(S.accounts)), (r) => r.code, (r) => pick(r, ['name', 'type', 'subtype', 'parentId', 'balance', 'isActive', 'currency', 'taxLine', 'description']));
  lists.customers = byKey(await db.select().from(S.customers).where(co(S.customers)), (r) => r.displayName, (r) => pick(r, ['email', 'billingAddress', 'balance', 'isActive', 'customFields', 'parentId', 'terms', 'taxable']));
  lists.vendors = byKey(await db.select().from(S.vendors).where(co(S.vendors)), (r) => r.displayName, (r) => pick(r, ['email', 'is1099', 'balance', 'isActive', 'currency', 'terms'] as never));
  lists.items = byKey(await db.select().from(S.items).where(co(S.items)), (r) => r.name, (r) => pick(r, ['type', 'salesPrice', 'purchaseCost', 'quantityOnHand', 'averageCost', 'incomeAccountId', 'expenseAccountId', 'assetAccountId', 'trackingMode', 'isActive', 'customFields', 'taxable']));
  lists.classes = byKey(await db.select().from(S.classes).where(co(S.classes)), (r) => r.name, (r) => pick(r, ['parentId', 'isActive'] as never));
  lists.taxRates = byKey(await db.select().from(S.taxRates).where(co(S.taxRates)), (r) => r.name, (r) => pick(r, ['rate', 'agencyId', 'isActive']));
  lists.taxAgencies = byKey(await db.select().from(S.taxAgencies).where(co(S.taxAgencies)), (r) => r.name, (r) => pick(r, ['liabilityAccountId']));
  lists.currencies = byKey(await db.select().from(S.currencies).where(co(S.currencies)), (r) => r.code, (r) => pick(r as never, ['name', 'rateToBase', 'isBase'] as never));
  lists.sites = byKey(await db.select().from(S.inventorySites).where(co(S.inventorySites)), (r) => r.name, (r) => pick(r, ['isDefault', 'isActive']));
  lists.bom = (await db.select().from(S.assemblyComponents).where(co(S.assemblyComponents))).map((c) => lab(`${c.assemblyItemId} <- ${c.quantity} x ${c.componentItemId}`)).sort();
  lists.bankAccounts = byKey(await db.select().from(S.bankAccounts).where(co(S.bankAccounts)), (r) => r.bankName, (r) => pick(r, ['accountId', 'accountNumber', 'lastReconciledDate', 'lastReconciledBalance']));

  // ---- Documents ----
  const docs: Record<string, Json> = {};
  const lineRows = async <T>(table: never, fk: never, id: string, cols: string[]) =>
    ((await db.select().from(table).where(eq(fk, id as never))) as Array<Record<string, unknown>>)
      .sort((a, b) => Number(a.lineOrder ?? 0) - Number(b.lineOrder ?? 0) || String(a.description ?? '').localeCompare(String(b.description ?? '')))
      .map((l) => lab(pick(l, cols as never)));
  docs.invoices = Object.fromEntries(
    await Promise.all(
      (await db.select().from(S.invoices).where(co(S.invoices))).map(async (r) => [
        `${r.refNumber ?? r.invoiceNumber}`,
        lab({
          ...pick(r, ['customerId', 'date', 'dueDate', 'terms', 'status', 'subtotal', 'discount', 'discountType', 'taxAmount', 'total', 'amountPaid', 'balanceDue', 'currency', 'exchangeRate', 'classId', 'jobId', 'salesRepId', 'taxRateId', 'memo', 'customFields', 'poNumber', 'shipVia', 'shipDate', 'shipTo', 'toBePrinted', 'toBeEmailed', 'retainagePercent', 'isStatementCharge']),
          lines: await lineRows(S.invoiceLines as never, S.invoiceLines.invoiceId as never, r.id, ['itemId', 'accountId', 'description', 'quantity', 'rate', 'amount', 'taxable', 'classId']),
        }),
      ]),
    ),
  );
  docs.bills = Object.fromEntries(
    await Promise.all(
      (await db.select().from(S.bills).where(co(S.bills))).map(async (r) => [
        `${r.billNumber ?? r.date.toISOString().slice(0, 10)}`,
        lab({ ...pick(r, ['vendorId', 'date', 'dueDate', 'terms', 'memo', 'classId', 'currency', 'exchangeRate', 'status', 'total', 'amountPaid', 'amountCredited', 'balanceDue'] as never), lines: await lineRows(S.billLines as never, S.billLines.billId as never, r.id, ['itemId', 'accountId', 'description', 'quantity', 'amount', 'classId']) }),
      ]),
    ),
  );
  const simple = async (table: never, key: (r: Record<string, unknown>) => string, cols: string[]) =>
    Object.fromEntries(((await db.select().from(table).where(co(table))) as Array<Record<string, unknown>>).map((r) => [key(r), lab(pick(r, cols as never))]).sort());
  docs.payments = await simple(S.paymentsReceived as never, (r) => `${labels.get(r.customerId as string)} ${(r.date as Date).toISOString().slice(0, 10)} ${r.reference ?? ''}`, ['amount', 'unapplied', 'currency', 'exchangeRate', 'depositAccountId', 'voidedAt']);
  for (const v of Object.values(docs.payments as Record<string, Record<string, unknown>>)) v.voidedAt = v.voidedAt ? 'voided' : null;
  docs.paymentApps = ((await db.select({ a: S.paymentApplications }).from(S.paymentApplications).innerJoin(S.paymentsReceived, eq(S.paymentsReceived.id, S.paymentApplications.paymentId)).where(eq(S.paymentsReceived.companyId, companyId))) as Array<{ a: Record<string, unknown> }>)
    .map(({ a }) => lab(`${a.invoiceId} ${a.amountApplied}`))
    .sort();
  docs.salesReceipts = await simple(S.salesReceipts as never, (r) => `${r.refNumber ?? r.receiptNumber}`, ['customerId', 'date', 'status', 'subtotal', 'taxAmount', 'total', 'depositAccountId']);
  docs.creditMemos = await simple(S.creditMemos as never, (r) => `${r.refNumber ?? r.creditMemoNumber ?? r.memoNumber}`, ['customerId', 'date', 'status', 'total', 'unapplied']);
  docs.vendorCredits = await simple(S.vendorCredits as never, (r) => `${labels.get(r.vendorId as string)} ${(r.date as Date).toISOString().slice(0, 10)}`, ['status', 'total', 'unapplied']);
  docs.billPayments = await simple(S.billPayments as never, (r) => `${labels.get(r.vendorId as string)} ${(r.date as Date).toISOString().slice(0, 10)}`, ['amount', 'paymentAccountId', 'reference', 'status']);
  docs.estimates = await simple(S.estimates as never, (r) => `${r.refNumber ?? r.estimateNumber}`, ['customerId', 'date', 'status', 'total']);
  docs.salesOrders = await simple(S.salesOrders as never, (r) => `${r.refNumber ?? r.orderNumber ?? r.soNumber}`, ['customerId', 'date', 'status', 'total']);
  docs.purchaseOrders = await simple(S.purchaseOrders as never, (r) => `${r.refNumber ?? r.poNumber}`, ['vendorId', 'date', 'status', 'total']);
  docs.itemReceipts = await simple(S.itemReceipts as never, (r) => `${labels.get(r.vendorId as string)} ${(r.date as Date).toISOString().slice(0, 10)}`, ['status', 'total']);
  docs.deposits = await simple(S.deposits as never, (r) => `${(r.date as Date).toISOString().slice(0, 10)} ${r.memo ?? ''}`, ['depositAccountId', 'total', 'status']);
  docs.expenses = await simple(S.expenses as never, (r) => `${(r.date as Date).toISOString().slice(0, 10)} ${r.reference ?? r.payeeName ?? ''}`, ['vendorId', 'payeeName', 'paymentAccountId', 'total', 'currency', 'exchangeRate', 'status']);
  docs.transfers = await simple(S.transfers as never, (r) => `${(r.date as Date).toISOString().slice(0, 10)} ${r.memo ?? ''}`, ['fromAccountId', 'toAccountId', 'amount', 'status']);
  const jes = await db.select().from(S.journalEntries).where(co(S.journalEntries));
  docs.journal = {
    posted: jes.filter((e) => e.status === 'posted').length,
    void: jes.filter((e) => e.status === 'void').length,
    manual: jes.filter((e) => !e.sourceRef).map((e) => `${e.date.toISOString().slice(0, 10)} ${e.description} ${e.status}`).sort(),
  };

  // ---- Meta: custom fields, memorized reports, recurring, roles, preferences ----
  const meta: Record<string, Json> = {};
  const [company] = await db.select().from(S.companies).where(eq(S.companies.id, companyId));
  const { closingDatePasswordHash, ...settings } = (company.settings ?? {}) as Record<string, unknown>;
  meta.companyName = company.name;
  meta.settings = lab(settings);
  meta.closingDatePassword = typeof closingDatePasswordHash === 'string' ? await verifyPassword('close-pw', closingDatePasswordHash) : null;
  meta.memorized = byKey(await db.select().from(S.memorizedReports).where(co(S.memorizedReports)), (r) => r.name, (r) => pick(r, ['reportType', 'config', 'groupId']));
  meta.recurring = byKey(await db.select().from(S.recurringTemplates).where(co(S.recurringTemplates)), (r) => r.name, (r) => pick(r, ['docType', 'frequency', 'nextRunDate', 'template', 'isActive', 'mode', 'remaining', 'anchorDay']));
  meta.roles = byKey(await db.select().from(S.companyRoles).where(co(S.companyRoles)), (r) => r.name, (r) => pick(r, ['description', 'permissions', 'flags']));

  // ---- Reconciliations ----
  const recons = await db
    .select({ r: S.reconciliations, bank: S.bankAccounts.bankName })
    .from(S.reconciliations)
    .innerJoin(S.bankAccounts, eq(S.bankAccounts.id, S.reconciliations.bankAccountId))
    .where(eq(S.bankAccounts.companyId, companyId));
  const recon = await Promise.all(
    recons.map(async ({ r, bank }) => {
      const its = await db
        .select({ it: S.reconciliationItems, l: S.journalEntryLines })
        .from(S.reconciliationItems)
        .innerJoin(S.journalEntryLines, eq(S.journalEntryLines.id, S.reconciliationItems.journalEntryLineId))
        .where(eq(S.reconciliationItems.reconciliationId, r.id));
      return `${bank} ${r.statementDate.toISOString().slice(0, 10)} ${r.statementBalance} ${r.status} cleared=${its
        .filter((x) => x.it.isCleared)
        .map((x) => x.l.debit ?? `-${x.l.credit}`)
        .sort()
        .join(',')}`;
    }),
  );

  // ---- Attachments: every row's file must be readable from this data dir ----
  const atts = await db.select().from(S.attachments).where(co(S.attachments));
  const files = atts
    .map((a) => {
      const abs = safeAttachmentPath(dir, a.storagePath);
      const ok = !!abs && fs.existsSync(abs);
      return `${a.filename} -> ${a.entityType ? lab(`${a.entityType}:${a.entityId}`) : 'unfiled'} ${ok ? sha(fs.readFileSync(abs!)).slice(0, 16) : 'MISSING FILE'}`;
    })
    .sort();

  // ---- Users able to log in ----
  let users: Json = null;
  if (opts.users) {
    const rows = await db.select().from(S.users);
    users = Object.fromEntries(
      await Promise.all(
        rows
          .sort((a, b) => a.email.localeCompare(b.email))
          .map(async (u) => {
            const access = await resolveAccess(db, companyId, u.id);
            return [u.email, { password: await verifyPassword(PASSWORD, u.passwordHash), member: access.member, active: access.active, admin: access.access.isAdmin, canViewSales: (access.access as never as { permissions: Record<string, string[]> }).permissions?.customers?.includes('view') ?? null }];
          }),
      ),
    );
  }

  return { ledger, inventory, lists, docs, meta, recon: recon.sort(), files, users };
}

/** Paths whose values differ between two JSON-ish values ("a.b.c: x → y"). */
function diff(a: Json, b: Json, p = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => diff((a as Record<string, Json>)[k], (b as Record<string, Json>)[k], p ? `${p}.${k}` : k));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const onlyA = a.filter((x) => !b.some((y) => JSON.stringify(y) === JSON.stringify(x)));
    const onlyB = b.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)));
    return [`${p}: -${JSON.stringify(onlyA)} +${JSON.stringify(onlyB)}`];
  }
  return [`${p}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
}

function compare(before: Fingerprint, after: Fingerprint, sections: Array<keyof Fingerprint>): string[] {
  return sections.flatMap((s) => diff(before[s], after[s], s));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let src: Seeded;
let F0: Fingerprint;
const ALL: Array<keyof Fingerprint> = ['ledger', 'inventory', 'lists', 'docs', 'meta', 'recon', 'files', 'users'];
const BOOKS: Array<keyof Fingerprint> = ['ledger', 'inventory', 'lists', 'docs', 'meta', 'recon', 'files'];

async function companyCtx(db: DB, name = COMPANY): Promise<ServiceContext> {
  const [co] = await db.select().from(S.companies).where(eq(S.companies.name, name));
  if (!co) throw new Error(`company "${name}" not found`);
  const [owner] = await db.select().from(S.users).where(eq(S.users.email, 'owner@review4.test'));
  return { db, companyId: co.id, userId: owner?.id ?? co.ownerId };
}

describe('review4: round-trip fidelity of every way data leaves and re-enters a company file', { timeout: 600_000 }, () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.mkdirSync(ROOT, { recursive: true });
    const db = await open(SRC);
    src = await seed(db, SRC);
    F0 = await fingerprint(src.ctx, SRC, { users: true });
  }, 600_000);

  afterAll(async () => {
    for (const dir of opened) await closeDb(dir).catch(() => undefined);
    delete process.env.BKA_DATA_DIR;
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('the seeded company is rich and consistent', () => {
    const tb = F0.ledger['tb 2026-06-30'] as Record<string, string>;
    expect(Object.keys(tb).length).toBeGreaterThan(10);
    expect(F0.ledger.txlog).toBe(true);
    expect(F0.files).toHaveLength(3);
    expect((F0.files as string[]).some((f) => f.includes('MISSING'))).toBe(false);
    expect(Object.keys(F0.users as object)).toHaveLength(3);
    expect(F0.recon).toHaveLength(1);
    expect(F0.meta.closingDatePassword).toBe(true);
    if (process.env.REVIEW4_DUMP) fs.writeFileSync(process.env.REVIEW4_DUMP, JSON.stringify(F0, null, 1));
  });

  it('1. whole-file backup → restore', async () => {
    const dir = path.join(ROOT, 'full-restore');
    const { buffer } = createBackup(COMPANY, SRC);
    await restoreBackup(buffer, dir);
    const db = await open(dir);
    const F = await fingerprint(await companyCtx(db), dir, { users: true });
    expect(compare(F0, F, ALL)).toEqual([]);
  });

  it('2a. per-company backup → restore as a new company in the SAME data dir', async () => {
    const dir = await cloneSource('company-same');
    const db = await open(dir);
    process.env.BKA_DATA_DIR = dir;
    const ctx = await companyCtx(db);
    const { buffer } = await createCompanyBackup(db, ctx.companyId);
    const res = await restoreCompanyBackup(db, buffer, { ownerId: ctx.userId!, name: 'RT Restored' });
    const F = await fingerprint({ db, companyId: res.companyId, userId: ctx.userId }, dir);
    F.meta.companyName = COMPANY;
    expect.soft(compare(F0, F, BOOKS)).toEqual([]);
    // The source company of the same file is untouched.
    expect.soft(compare(F0, await fingerprint(ctx, dir, { users: true }), ALL)).toEqual([]);
  });

  it('2b. per-company backup → restore as a new company in a FRESH data dir (another PC)', async () => {
    const { buffer } = await createCompanyBackup(src.ctx.db, src.ctx.companyId);
    const dir = path.join(ROOT, 'company-fresh');
    const db = await open(dir);
    process.env.BKA_DATA_DIR = dir;
    const [me] = await db.insert(S.users).values({ email: 'restorer@review4.test', name: 'Restorer', passwordHash: 'x' }).returning();
    const res = await restoreCompanyBackup(db, buffer, { ownerId: me.id });
    const F = await fingerprint({ db, companyId: res.companyId, userId: me.id }, dir);
    expect.soft(compare(F0, F, BOOKS)).toEqual([]);
  });

  it('3. portable company file (.bkp) export → import', async () => {
    process.env.BKA_DATA_DIR = SRC;
    const { buffer } = await createPortableCompanyFile(src.ctx, { dataDir: SRC });
    const dir = path.join(ROOT, 'portable');
    await restorePortableCompanyFile(buffer, dir);
    const db = await open(dir);
    expect(compare(F0, await fingerprint(await companyCtx(db), dir, { users: true }), ALL)).toEqual([]);
  });

  it('4. condense before the closed period end: reports after the date and as-of totals are unchanged; the archive restores everything', async () => {
    const dir = await cloneSource('condense');
    const db = await open(dir);
    process.env.BKA_DATA_DIR = dir;
    const ctx = await companyCtx(db);
    const res = await condensePeriod(ctx, { beforeDate: new Date('2026-02-01T00:00:00.000Z'), dataDir: dir });
    expect(res.entriesToCondense).toBeGreaterThan(5);
    const F = await fingerprint(ctx, dir, { users: true });
    // By design: detail entries go and completed-reconciliation detail rows of removed lines go.
    const drop = (f: Fingerprint) => {
      const c = structuredClone(f);
      delete (c.docs as Record<string, unknown>).journal;
      c.recon = (c.recon as string[]).map((r) => r.replace(/ cleared=.*/, ''));
      return c;
    };
    expect.soft(compare(drop(F0), drop(F), ALL)).toEqual([]);

    // The archive copy written before condensing brings back every detail.
    const [archive] = listCondenseArchives(dir);
    expect(archive?.available).toBe(true);
    await restoreCondenseArchive(ctx, archive.id, dir);
    const db2 = await open(dir);
    expect(compare(F0, await fingerprint(await companyCtx(db2), dir, { users: true }), ALL)).toEqual([]);
  });

  it('5. Period Copy (Feb 2026): opening + closing balances, aging, stock and documents as of the end date', async () => {
    process.env.BKA_DATA_DIR = SRC;
    const asOf = '2026-02-28';
    const srcInv = await inventoryValuationAsOf(src.ctx, eod(asOf));
    const srcTax = await salesTaxLiabilityReport(src.ctx, { to: eod(asOf), basis: 'accrual' });
    const srcLabels = await labelMap(src.ctx);
    const srcMoves = await src.ctx.db.select().from(S.inventoryMovements).where(eq(S.inventoryMovements.companyId, src.ctx.companyId));
    const { buffer, summary } = await createPeriodCopy(src.ctx, { from: '2026-02-01', to: asOf, dataDir: SRC });
    expect(summary.condensed?.entries ?? 0).toBeGreaterThan(0);
    const dir = path.join(ROOT, 'period-copy');
    await restorePortableCompanyFile(buffer, dir);
    const db = await open(dir);
    process.env.BKA_DATA_DIR = dir;
    const ctx = await companyCtx(db);
    const F = await fingerprint(ctx, dir, { users: true });
    const L = F.ledger as Record<string, unknown>;
    const L0 = F0.ledger as Record<string, unknown>;
    const agencyBalances = (r: Awaited<ReturnType<typeof salesTaxLiabilityReport>>) =>
      Object.fromEntries((r.agencies as unknown as Array<Record<string, unknown>>).map((a) => [String(a.agencyName), String(a.balance)]));
    const problems: string[] = [
      ...diff(L0['tb 2026-01-31'], L['tb 2026-01-31'], 'opening TB'),
      ...diff(L0['tb 2026-02-28'], L['tb 2026-02-28'], 'closing TB'),
      ...diff(L0['tb 2026-02-28'], L['tb 2026-06-30'], 'nothing after the end date'),
      ...diff(L0['AR aging 2026-02-28'], L['AR aging 2026-02-28'], 'A/R aging'),
      ...diff(L0['AP aging 2026-02-28'], L['AP aging 2026-02-28'], 'A/P aging'),
      ...diff(L0['cash P&L 2026-02-01..2026-02-28'], L['cash P&L 2026-02-01..2026-02-28'], 'cash-basis P&L Feb'),
      ...diff(agencyBalances(srcTax), agencyBalances(await salesTaxLiabilityReport(ctx, { to: eod('2026-06-30'), basis: 'accrual' })), 'sales tax owed'),
      ...diff(
        { total: srcInv.grandTotal, items: Object.fromEntries(srcInv.items.map((i) => [i.name, i.valueAsOf])) },
        (F.inventory as Record<string, unknown>)['asOf 2026-03-31'],
        'inventory value',
      ),
    ];
    // Quantities on hand (per item and per site) as of the end date.
    const want = new Map<string, number>();
    for (const m of srcMoves) {
      if (m.date > eod(asOf)) continue;
      const k = `${srcLabels.get(m.itemId)} @ ${srcLabels.get(m.siteId)}`;
      want.set(k, (want.get(k) ?? 0) + Number(m.quantity));
    }
    problems.push(...diff(Object.fromEntries([...want].sort().map(([k, v]) => [k, v.toFixed(4)])), F.inventory.movementsBySite, 'stock by site'));
    problems.push(...diff(srcInv.grandTotal, (F.inventory.valuation as { total: string }).total, 'inventory valuation (current) in the copy'));
    // Documents dated after the end date are gone; earlier ones read as of the end date.
    const inv = F.docs.invoices as Record<string, Record<string, unknown>>;
    const keptInvoices = Object.entries(F0.docs.invoices as Record<string, { date: string }>).filter(([, v]) => v.date <= eod(asOf).toISOString()).map(([k]) => k).sort();
    problems.push(...diff(keptInvoices, Object.keys(inv).sort(), 'invoices kept'));
    problems.push(...diff({ status: 'open', balanceDue: '1000.00' }, pick(inv['E-1'] ?? {}, ['status', 'balanceDue']), 'E-1 open again'));
    // Reconciliations before the period keep their summary; their cleared detail went with the
    // condensed lines (condense.ts: completed-reconciliation detail of removed lines is removed).
    const reconOf = (list: unknown) =>
      (list as string[]).map((r) => (r.split(' ')[2] < '2026-02-01' ? r.replace(/ cleared=.*/, '') : r));
    problems.push(...diff(reconOf(F0.recon), reconOf(F.recon), 'reconciliations'));
    problems.push(...diff(F0.files, F.files, 'attachments'));
    problems.push(...diff(F0.users, F.users, 'users'));
    problems.push(...diff('2026-02-28', (F.meta.settings as Record<string, unknown>).closingDate, 'closing date'));
    expect.soft(problems).toEqual([]);
  });

  it('6. sandbox: the copy is exact; discard and keep-as-training leave the real file untouched', async () => {
    const real = await cloneSource('sandbox-real');
    const db = await open(real);
    process.env.BKA_DATA_DIR = real;
    const ctx = await companyCtx(db);
    expect(compare(F0, await fingerprint(ctx, real, { users: true }), ALL)).toEqual([]);

    const started = await startSandbox(ctx);
    opened.add(path.resolve(started.dir));
    const sctx = await companyCtx(await getDb(started.dir));
    expect.soft(compare(F0, await fingerprint(sctx, started.dir, { users: true }), ALL)).toEqual([]);
    const sbInvoice = async (c: ServiceContext, ref: string) =>
      createInvoice(c, {
        customerId: (await idOf(c.db, S.customers as never, 'displayName', 'Zeta Ünïcode Ltd'))!,
        refNumber: ref,
        date: d('2026-04-01'),
        lines: [{ itemId: (await idOf(c.db, S.items as never, 'name', 'Widget Avg'))!, quantity: 2, rate: '12.00' }],
      });
    await sbInvoice(sctx, 'SB-1');
    await discardSandbox(sctx);
    expect(path.resolve(process.env.BKA_DATA_DIR!)).toBe(path.resolve(real));
    const rdb = await open(real);
    expect.soft(compare(F0, await fingerprint(await companyCtx(rdb), real, { users: true }), ALL)).toEqual([]);

    const again = await startSandbox(await companyCtx(rdb));
    opened.add(path.resolve(again.dir));
    const s2 = await companyCtx(await getDb(again.dir));
    await sbInvoice(s2, 'SB-2');
    const kept = await keepSandboxAsTraining(s2, 'Practice File');
    expect(kept.trainingDir).toBeTruthy();
    const rdb2 = await open(real);
    expect.soft(compare(F0, await fingerprint(await companyCtx(rdb2), real, { users: true }), ALL)).toEqual([]);
    const tdb = await open(kept.trainingDir!);
    process.env.BKA_DATA_DIR = kept.trainingDir!;
    const T = await fingerprint(await companyCtx(tdb), kept.trainingDir!, { users: true });
    expect.soft(Object.keys(T.docs.invoices as object)).toContain('SB-2');
    expect.soft(T.files).toEqual(F0.files);
    expect.soft(T.ledger.txlog).toBe(true);
    expect.soft(T.users).toEqual(F0.users);
    process.env.BKA_DATA_DIR = real;
  });

  it("7. Accountant's Copy: accountant JE / reclassify / new account / voids + client work after the dividing date = the same work done directly", async () => {
    const clientDir = await cloneSource('ac-client');
    const refDir = await cloneSource('ac-reference');
    const acctDir = path.join(ROOT, 'ac-accountant');
    const cdb = await open(clientDir);
    process.env.BKA_DATA_DIR = clientDir;
    const client = await companyCtx(cdb);
    const transfer = await createAccountantCopy(client, { dividingDate: '2026-03-31', dataDir: clientDir });
    await openAccountantCopyFile(transfer.buffer, acctDir);
    opened.add(path.resolve(acctDir));
    const actx = await companyCtx(await getDb(acctDir));

    const accountantWork = async (c: ServiceContext) => {
      const a = await acctMap(c.db, c.companyId);
      const equip = await createAccount(c, { code: '6450', name: 'Equipment Rental', type: 'expense' as never, subtype: 'operating_expenses' });
      await createManualEntry(c, { date: d('2026-03-31'), description: 'Accrue equipment rental', lines: [{ accountId: equip.id, debit: '250.00' }, { accountId: a['1010'], credit: '250.00' }] });
      // Reclassify the vendor credit's expense line 6300 -> 6200.
      const [vc] = await c.db.select().from(S.vendorCredits).where(eq(S.vendorCredits.companyId, c.companyId));
      const lines = await c.db
        .select()
        .from(S.journalEntryLines)
        .where(and(eq(S.journalEntryLines.journalEntryId, vc.postedEntryId!), eq(S.journalEntryLines.accountId, a['6300'])));
      await reclassifyLines(c, { lineIds: lines.map((l) => l.id), newAccountId: a['6200'] });
      // Void the March rent entry and the payment on A-3.
      const [rent] = await c.db.select().from(S.journalEntries).where(and(eq(S.journalEntries.companyId, c.companyId), eq(S.journalEntries.description, 'March rent')));
      await voidEntry(c, rent.id);
      const [pay] = await c.db.select().from(S.paymentsReceived).where(and(eq(S.paymentsReceived.companyId, c.companyId), eq(S.paymentsReceived.reference, '1002')));
      await voidPayment(c, pay.id);
    };
    const clientLater = async (c: ServiceContext) => {
      const a = await acctMap(c.db, c.companyId);
      await createInvoice(c, {
        customerId: (await idOf(c.db, S.customers as never, 'displayName', 'Acme "Quoted" Corp'))!,
        refNumber: 'A-9',
        date: d('2026-04-05'),
        lines: [{ itemId: (await idOf(c.db, S.items as never, 'name', 'Consulting'))!, quantity: 2, rate: '125.50', taxable: false }],
      });
      await createExpense(c, { payeeName: 'Coffee Shop', date: d('2026-04-10'), method: 'cash', paymentAccountId: a['1000'], lines: [{ accountId: a['6300'], amount: '20.00' }] });
    };

    process.env.BKA_DATA_DIR = acctDir;
    await accountantWork(actx);
    process.env.BKA_DATA_DIR = clientDir;
    await clientLater(client);
    process.env.BKA_DATA_DIR = acctDir;
    const changes = await exportChangesFile(actx, { note: 'Round 4' });
    process.env.BKA_DATA_DIR = clientDir;
    const review = await reviewChangesFile(client, changes.buffer);
    expect.soft(review.canImport).toBe(true);
    await importChangesFile(client, changes.buffer);

    const rdb = await open(refDir);
    process.env.BKA_DATA_DIR = refDir;
    const ref = await companyCtx(rdb);
    await accountantWork(ref);
    await clientLater(ref);

    process.env.BKA_DATA_DIR = clientDir;
    const FC = await fingerprint(client, clientDir);
    process.env.BKA_DATA_DIR = refDir;
    const FR = await fingerprint(ref, refDir);
    const strip = (f: Fingerprint) => {
      const c = structuredClone(f);
      delete (c.docs as Record<string, unknown>).journal;
      return c;
    };
    expect.soft(compare(strip(FR), strip(FC), BOOKS)).toEqual([]);
  });

  it('8. IIF export (lists + general journal) → import into a fresh company', async () => {
    process.env.BKA_DATA_DIR = SRC;
    const lists = await exportListsIif(src.ctx);
    const journal = await exportJournalIif(src.ctx, { from: new Date('2025-01-01T00:00:00Z'), to: new Date('2026-12-31T23:59:59Z') });
    const dir = path.join(ROOT, 'iif-fresh');
    const db = await open(dir);
    process.env.BKA_DATA_DIR = dir;
    const [u] = await db.insert(S.users).values({ email: 'iif@review4.test', name: 'IIF', passwordHash: 'x' }).returning();
    const co = await createCompany(db, { name: 'IIF Copy', ownerId: u.id, seedCoa: false });
    const ctx: ServiceContext = { db, companyId: co.id, userId: u.id };
    const counts = await importIIF(ctx, `${lists}\n${journal}`);
    expect.soft(counts.issues.filter((i) => i.reason !== 'duplicate' && i.reason !== 'note')).toEqual([]);
    const F = await fingerprint(ctx, dir);
    const problems: string[] = [];
    for (const day of DATES) problems.push(...diff(F0.ledger[`tb ${day}`], F.ledger[`tb ${day}`], `tb ${day}`));
    problems.push(...diff(Object.keys(F0.lists.customers as object), Object.keys(F.lists.customers as object), 'customers'));
    problems.push(...diff(Object.keys(F0.lists.vendors as object), Object.keys(F.lists.vendors as object), 'vendors'));
    // Item custom fields travel (CUSTITEMDICT + INVITEM CUSTFLDn). Inherent IIF limits: QB's IIF
    // has no field for serial / lot tracking or for FIFO cost layers (a FIFO item comes back as an
    // average-cost item holding the same quantity and value, asserted below).
    const IIF_ITEM_LIMITS = ['trackingMode', 'averageCost'];
    const itemKeys = (f: Fingerprint) =>
      Object.fromEntries(
        Object.entries(f.lists.items as Record<string, Record<string, unknown>>).map(([k, v]) => [
          k,
          Object.fromEntries(Object.entries(v).filter(([field]) => !IIF_ITEM_LIMITS.includes(field))),
        ]),
      );
    problems.push(...diff(itemKeys(F0), itemKeys(F), 'items'));
    // Stock and its value per item (quantity, value) come back with the lists.
    const stock = (f: Fingerprint) =>
      Object.fromEntries(
        Object.entries((f.inventory.valuation as { items: Record<string, string> }).items).map(([k, v]) => [k, v.replace(/@[^=]+/, '').replace(/ (fifo|average)$/, '')]),
      );
    problems.push(...diff(stock(F0), stock(F), 'stock (quantity = value)'));
    problems.push(...diff((F0.inventory.valuation as { total: string }).total, (F.inventory.valuation as { total: string }).total, 'inventory value'));
    problems.push(...diff(F0.lists.bom, F.lists.bom, 'bom'));
    problems.push(...diff(F0.lists.classes, F.lists.classes, 'classes'));
    const acctKeys = (f: Fingerprint) =>
      // Detail types come back (inferred from the name where ACCNTTYPE has none: savings, inventory,
      // retained earnings, service income, payroll, taxes). Inherent IIF limit: no foreign-currency
      // amounts on TRNS / SPL rows, so an account currency is not carried — tagging the account
      // EUR would only relabel its home-currency amounts as euros.
      Object.fromEntries(
        Object.entries(f.lists.accounts as Record<string, Record<string, unknown>>).map(([k, v]) => [k, pick(v, ['name', 'type', 'subtype', 'isActive'])]),
      );
    problems.push(...diff(acctKeys(F0), acctKeys(F), 'accounts'));
    expect.soft(problems).toEqual([]);
  });

  it("8b. QB General Ledger import of our own exported GL (shareable ledger workbook)", async () => {
    process.env.BKA_DATA_DIR = SRC;
    const wb = await buildShareableLedgerXlsx(src.ctx);
    const dir = path.join(ROOT, 'gl-fresh');
    const db = await open(dir);
    process.env.BKA_DATA_DIR = dir;
    const [u] = await db.insert(S.users).values({ email: 'gl@review4.test', name: 'GL', passwordHash: 'x' }).returning();
    const co = await createCompany(db, { name: 'GL Copy', ownerId: u.id });
    const ctx: ServiceContext = { db, companyId: co.id, userId: u.id };
    const file = { name: wb.filename, data: wb.buffer.toString('base64') };
    let error: string | null = null;
    try {
      await runGlImport(ctx, { file, references: [file] });
    } catch (err) {
      error = (err as Error).message;
    }
    expect.soft(error).toBeNull();
    if (!error) {
      const tb = await trialBalance(ctx, eod('2026-06-30'));
      const byName = (rows: Array<{ name: string; debit: string; credit: string }>) =>
        Object.fromEntries(rows.map((r) => [r.name, `${r.debit}/${r.credit}`]).sort());
      expect.soft(byName(tb.rows)).toEqual(byName((await trialBalance(src.ctx, eod('2026-06-30'))).rows));
    }
  });

  it('9. list export (CSV) → list import into a fresh company', async () => {
    process.env.BKA_DATA_DIR = SRC;
    const csv = async (list: string) => (await exportListCsv(src.ctx, list)).csv;
    const accountsCsv = await csv('accounts');
    const customersCsv = await csv('customers');
    const vendorsCsv = await csv('vendors');
    const itemsCsv = await csv('items');
    const dir = path.join(ROOT, 'csv-fresh');
    const db = await open(dir);
    process.env.BKA_DATA_DIR = dir;
    const [u] = await db.insert(S.users).values({ email: 'csv@review4.test', name: 'CSV', passwordHash: 'x' }).returning();
    const co = await createCompany(db, { name: 'CSV Copy', ownerId: u.id, seedCoa: false });
    const ctx: ServiceContext = { db, companyId: co.id, userId: u.id };
    // The mappings are the ones the List Import screen matches by itself from our export's
    // headings (app/qb-import/ListImport.tsx autoMapColumns) — no column is mapped by hand.
    const headersOf = (text: string) => text.replace(/^﻿/, '').split(/\r?\n/)[0].split(',').map((h) => h.trim());
    const auto = (kind: keyof typeof CSV_FIELDS, text: string) => autoMapColumns(CSV_FIELDS[kind], headersOf(text), {});
    const customerMap = auto('customers', customersCsv);
    const vendorMap = auto('vendors', vendorsCsv);
    const itemMap = auto('items', itemsCsv);
    expect(customerMap).toMatchObject({
      displayName: 'Name', terms: 'Terms', billingAddress_line1: 'Billing Street 1', billingAddress_line2: 'Billing Street 2',
      billingAddress_city: 'Billing City', billingAddress_state: 'Billing State', billingAddress_zip: 'Billing ZIP', billingAddress_country: 'Billing Country',
    });
    expect(vendorMap).toMatchObject({ displayName: 'Name', terms: 'Terms', is1099: '1099 Vendor' });
    expect(itemMap).toMatchObject({ name: 'Name', taxable: 'Taxable', incomeAccount: 'Income Account', assetAccount: 'Asset Account' });
    expect(itemMap.quantityOnHand).toBeUndefined(); // opening stock is never mapped automatically
    await importAccountsCSV(ctx, accountsCsv, auto('accounts', accountsCsv));
    await importCustomersCSV(ctx, customersCsv, customerMap);
    await importVendorsCSV(ctx, vendorsCsv, vendorMap);
    await importItemsCSV(ctx, itemsCsv, itemMap);
    const F = await fingerprint(ctx, dir);
    const keyFields = (f: Fingerprint, list: string, keys: string[]) =>
      Object.fromEntries(Object.entries(f.lists[list] as Record<string, Record<string, unknown>>).map(([k, v]) => [k, pick(v, keys as never)]));
    const ACC = ['name', 'type', 'subtype', 'isActive', 'description', 'parentId'];
    // Names, contact fields, the billing address (in its parts), terms, the 1099 flag, item
    // prices / accounts / taxable all come back.
    const CUS = ['email', 'billingAddress', 'isActive', 'parentId', 'terms'];
    const VEN = ['email', 'is1099', 'isActive', 'terms'];
    const ITM = ['type', 'salesPrice', 'purchaseCost', 'incomeAccountId', 'expenseAccountId', 'assetAccountId', 'taxable', 'isActive'];
    const problems = [
      ...diff(keyFields(F0, 'accounts', ACC), keyFields(F, 'accounts', ACC), 'accounts'),
      ...diff(keyFields(F0, 'customers', CUS), keyFields(F, 'customers', CUS), 'customers'),
      ...diff(keyFields(F0, 'vendors', VEN), keyFields(F, 'vendors', VEN), 'vendors'),
      ...diff(keyFields(F0, 'items', ITM), keyFields(F, 'items', ITM), 'items'),
    ];
    expect.soft(problems).toEqual([]);
  });

  it('10. undo of each recent action returns the fingerprint to the prior state', async () => {
    const dir = await cloneSource('undo');
    const db = await open(dir);
    process.env.BKA_DATA_DIR = dir;
    const ctx = await companyCtx(db);
    const a = await acctMap(db, ctx.companyId);
    const id = async (t: unknown, col: string, v: string) => (await idOf(db, t as never, col, v))!;
    const acme = await id(S.customers, 'displayName', 'Acme "Quoted" Corp');
    const zeta = await id(S.customers, 'displayName', 'Zeta Ünïcode Ltd');
    const parts = await id(S.vendors, 'displayName', 'Parts Inc');
    const consulting = await id(S.items, 'name', 'Consulting');
    const gadget = await id(S.items, 'name', 'Gadget FIFO');
    const widget = await id(S.items, 'name', 'Widget Avg');
    const wholesale = await id(S.classes, 'name', 'Wholesale');
    const invA3 = await id(S.invoices, 'refNumber', 'A-3');
    const billPI101 = await id(S.bills, 'billNumber', 'PI-101');
    const cm1 = await id(S.creditMemos, 'refNumber', 'CM-1');
    const [rent] = await db.select().from(S.journalEntries).where(and(eq(S.journalEntries.companyId, ctx.companyId), eq(S.journalEntries.description, 'March rent')));
    const [est] = await db.select().from(S.estimates).where(eq(S.estimates.companyId, ctx.companyId));
    const [po] = await db.select().from(S.purchaseOrders).where(eq(S.purchaseOrders.companyId, ctx.companyId));

    const strip = (f: Fingerprint) => {
      const c = structuredClone(f);
      delete (c.docs as Record<string, unknown>).journal;
      return c;
    };
    let base = strip(await fingerprint(ctx, dir));
    const results: Record<string, string[] | string> = {};
    const run = async (
      label: string,
      resource: string,
      kind: 'update' | 'void' | 'delete' | 'create',
      recordId: string | null,
      act: () => Promise<unknown>,
      sections: Array<keyof Fingerprint> = BOOKS,
    ) => {
      try {
        const token = kind === 'create' ? null : (await prepareUndo(ctx, { resource, kind, id: recordId! })).token;
        const made = await act();
        const armed = await commitUndo(ctx, { resource, kind, token, id: kind === 'create' ? ((made as { id?: string })?.id ?? null) : null });
        await performUndo(ctx, armed.token);
        const now = strip(await fingerprint(ctx, dir));
        results[label] = compare(base, now, sections);
        base = now; // re-baseline so one lossy undo does not cascade into the next check
      } catch (err) {
        results[label] = `ERROR ${(err as Error).message}`;
        base = strip(await fingerprint(ctx, dir));
      }
    };

    await run('invoice update', 'invoices', 'update', invA3, () =>
      updateInvoice(ctx, invA3, {
        customerId: acme, refNumber: 'A-3', date: d('2026-02-06'), dueDate: d('2026-03-20'), terms: 'net_15', memo: 'changed',
        poNumber: 'PO-9', classId: wholesale, lines: [{ itemId: consulting, quantity: 11, rate: '100.00', taxable: false }],
      } as never),
    );
    await run('bill update', 'bills', 'update', billPI101, () =>
      updateBill(ctx, billPI101, { vendorId: parts, billNumber: 'PI-101', date: d('2026-02-15'), memo: 'edited', lines: [{ itemId: gadget, quantity: 6, unitCost: '14.00' }] } as never),
    );
    await run('credit memo update', 'credit-memos', 'update', cm1, () =>
      updateCreditMemo(ctx, cm1, { customerId: zeta, refNumber: 'CM-1', date: d('2026-02-11'), memo: 'edited', lines: [{ itemId: widget, quantity: 2, rate: '12.00' }] } as never),
    );
    await run('journal entry update', 'journal-entries', 'update', rent.id, () =>
      updateEntry(ctx, rent.id, { date: d('2026-03-30'), description: 'March rent (edited)', lines: [{ accountId: a['6400'], debit: '550.00' }, { accountId: a['1010'], credit: '550.00' }] }),
    );
    await run('estimate update', 'estimates', 'update', est.id, () =>
      updateEstimate(ctx, est.id, { customerId: acme, date: d('2026-02-27'), memo: 'edited', lines: [{ description: 'Phase 2b', quantity: 12, rate: '120.00' }] } as never),
    );
    await run('purchase order update', 'purchase-orders', 'update', po.id, () =>
      updatePurchaseOrder(ctx, po.id, { vendorId: parts, date: d('2026-02-28'), memo: 'edited', lines: [{ itemId: widget, description: 'Widgets', quantity: 25, rate: '5.25' }] } as never),
    );
    await run('customer update', 'customers', 'update', acme, () =>
      updateCustomer(ctx, acme, { email: 'new@acme.test', phone: '555-0101', billingAddress: { line1: '9 Elm St', city: 'Shelbyville' }, terms: 'net_15', notes: 'n' } as never),
    );
    await run('item update', 'items', 'update', widget, () => updateItem(ctx, widget, { salesPrice: '13.00', description: 'Blue widget', purchaseCost: '5.10', unitOfMeasure: 'ea' }));
    await run('account update', 'accounts', 'update', a['6300'], () => updateAccount(ctx, a['6300'], { name: 'Office Stuff', description: 'Pens' }));
    await run('item made inactive', 'items', 'delete', consulting, () => updateItem(ctx, consulting, { isActive: false }));
    await run(
      'expense created',
      'expenses',
      'create',
      null,
      () => createExpense(ctx, { payeeName: 'Undo Cafe', date: d('2026-03-20'), method: 'cash', paymentAccountId: a['1000'], lines: [{ accountId: a['6300'], amount: '12.34' }] }),
      ['ledger', 'inventory'],
    );
    const invA4 = await id(S.invoices, 'refNumber', 'A-4');
    await run('invoice update (inventory line)', 'invoices', 'update', invA4, () =>
      updateInvoice(ctx, invA4, { customerId: zeta, refNumber: 'A-4', date: d('2026-03-20'), dueDate: d('2026-04-19'), lines: [{ itemId: widget, quantity: 5, rate: '12.50' }] } as never),
    );
    const [payA3] = await db.select().from(S.paymentsReceived).where(and(eq(S.paymentsReceived.companyId, ctx.companyId), eq(S.paymentsReceived.reference, '1002')));
    await run('payment update', 'payments', 'update', payA3.id, () =>
      updatePayment(ctx, payA3.id, { customerId: acme, date: d('2026-02-21'), method: 'check', reference: '1002', amount: '450.00', depositAccountId: a['1000'], memo: 'edited', applications: [{ invoiceId: invA3, amountApplied: '450.00' }] } as never),
    );
    const [vc] = await db.select().from(S.vendorCredits).where(eq(S.vendorCredits.companyId, ctx.companyId));
    await run('vendor credit update', 'vendor-credits', 'update', vc.id, () =>
      updateVendorCredit(ctx, vc.id, { vendorId: parts, date: d('2026-02-13'), memo: 'edited', lines: [{ accountId: a['6200'], description: 'Damaged (edited)', amount: '20.00' }] } as never),
    );
    const [srKit] = await db.select().from(S.salesReceipts).where(and(eq(S.salesReceipts.companyId, ctx.companyId), eq(S.salesReceipts.total, '60.00')));
    const kit = await id(S.items, 'name', 'Kit Assembly');
    await run('sales receipt update', 'sales-receipts', 'update', srKit.id, () =>
      updateSalesReceipt(ctx, srKit.id, { customerId: acme, date: d('2026-03-16'), depositAccountId: a['1000'], memo: 'edited', lines: [{ itemId: kit, quantity: 2, rate: '55.00', taxable: false }] } as never),
    );
    const [bp78] = await db.select().from(S.billPayments).where(and(eq(S.billPayments.companyId, ctx.companyId), eq(S.billPayments.reference, '2002')));
    const paper = await id(S.vendors, 'displayName', 'Paper Supply Co');
    const ps78 = await id(S.bills, 'billNumber', 'PS-78');
    await run('bill payment update', 'bill-payments', 'update', bp78.id, () =>
      updateBillPayment(ctx, bp78.id, { vendorId: paper, date: d('2026-02-11'), method: 'check', reference: '2002A', paymentAccountId: a['1010'], applications: [{ billId: ps78, amountApplied: '88.12' }] } as never),
    );
    await run('bill voided', 'bills', 'void', billPI101, () => voidBill(ctx, billPI101), ['ledger', 'inventory']);
    expect.soft(results).toEqual(Object.fromEntries(Object.keys(results).map((k) => [k, []])));
  });

  it('11. an older-format backup (pre-0059, pre-manifest .bka with its own secrets) restores, migrates and keeps the books', async () => {
    const dir = await cloneSource('mig-old');
    const db = await open(dir);
    process.env.BKA_DATA_DIR = dir;
    const ctx = await companyCtx(db);
    const a = await acctMap(db, ctx.companyId);
    // Two undescribed extra deposit lines with the same amount, to different accounts.
    const dep = (await createDeposit(ctx, {
      depositAccountId: a['1000'],
      date: d('2026-03-20'),
      paymentIds: [],
      extraLines: [{ accountId: a['3000'], amount: '100.00' }, { accountId: a['4900'], amount: '100.00' }],
    } as never)) as { id: string };
    const before = await fingerprint(ctx, dir, { users: true });
    // What a file migrated by 0037 (before 0059) looked like: both lines on the first account,
    // and 0059 not applied yet.
    await db.update(S.depositLines).set({ accountId: a['3000'] }).where(eq(S.depositLines.depositId, dep.id));
    type Raw = { query: (q: string) => Promise<{ rows: Array<Record<string, unknown>> }>; exec: (q: string) => Promise<unknown> };
    const raw = (x: DB) => (x as unknown as { $client: Raw }).$client;
    // A file from before 0059 has no migration row from 0059 on (drizzle re-runs every migration
    // newer than the newest recorded one).
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'drizzle', 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };
    const when0059 = journal.entries.find((e) => e.tag.startsWith('0059'))!.when;
    const migBefore = await raw(db).query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at');
    await raw(db).exec(`DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= ${when0059}`);
    await closeDb(dir);
    // A pre-manifest archive (bare PGlite folder) that still carries a foreign .auth-secret, as
    // archives from old builds did.
    const legacy = new AdmZip();
    for (const e of new AdmZip(createBackup(undefined, dir).buffer).getEntries()) {
      // Empty folders (pg_tblspc, pg_notify, ...) are part of a PGlite data dir: keep them.
      if (e.entryName !== 'bookkeeper-manifest.json') legacy.addFile(e.entryName, e.isDirectory ? Buffer.alloc(0) : e.getData());
    }
    legacy.addFile('.auth-secret', Buffer.from('forged-secret-from-old-backup'));
    const target = path.join(ROOT, 'mig-restored');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.auth-secret'), 'target-secret');
    await restoreBackup(legacy.toBuffer(), target);
    expect(fs.readFileSync(path.join(target, '.auth-secret'), 'utf8')).toBe('target-secret');
    const rdb = await open(target);
    const lines = await rdb.select().from(S.depositLines).where(eq(S.depositLines.depositId, dep.id));
    expect(lines.map((l) => l.accountId).sort()).toEqual([a['3000'], a['4900']].sort());
    expect((await raw(rdb).query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows).toEqual(migBefore.rows);
    process.env.BKA_DATA_DIR = target;
    expect(compare(before, await fingerprint(await companyCtx(rdb), target, { users: true }), ALL)).toEqual([]);
  });
});

/** Copy the source company file through a whole-file backup (verified by test 1). */
async function cloneSource(name: string): Promise<string> {
  const dir = path.join(ROOT, name);
  await restoreBackup(createBackup(COMPANY, SRC).buffer, dir);
  return dir;
}

async function idOf(db: DB, table: never, col: string, value: string): Promise<string | undefined> {
  const t = table as Record<string, never>;
  const [row] = (await db.select().from(table).where(eq(t[col], value as never))) as unknown as Array<{ id: string }>;
  return row?.id;
}
