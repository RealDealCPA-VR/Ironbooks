/**
 * Test fixture (not a test file) for the generated read tests over the whole operation registry
 * (test/agentReads.contract.test.ts, test/agentMasking.test.ts; plan §10 "Read purity" and
 * "Masking", Phase 2, §5.9).
 *
 * It builds one company with the realistic books of lib/services/companyFile.fixture.ts and adds
 * what an agent must never read in full without an approved reveal: employees with full SSNs and a
 * paycheck, vendors with tax IDs and account numbers (one of them a 1099 contractor paid over the
 * 1099 threshold) and a W-9 filed to it as a text document, a bank account with its full number,
 * an Other Names payee with an account
 * number, the employer's state account number, a check waiting to print whose memo the app fills
 * with "Acct # <full number>", a check with that memo typed, the vendor's own purchase order, bill,
 * bill payment check (waiting to print) and vendor credit, a Sales Tax Payment check that stores
 * that memo, and a journal line typed with it (as the books still hold from before the payment
 * stopped copying it).
 *
 * Every sensitive value is distinctive, so a scan of an answer for it cannot match by chance.
 *
 * It also seeds one record of most kinds an operation's path names (a purchase order, a budget, a
 * loan, an assembly, a landed-cost allocation, one permission request of the agent's own …) and
 * says which id or key each `[param]` takes (buildCases), so the tests can run the operations that
 * read one record; the records that hold a protected value (and every audit row that does) are
 * read too. A seed that fails is recorded in `seedErrors` (the tests fail on it) rather than
 * stopping the whole file: the services move under other people's hands.
 *
 * The reads both tests leave out (KNOWN, REFUSED_BY_DESIGN, NOT_FOR_AGENTS) are kept here, once.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { accounts, auditLogs, bankTransactions, bankAccounts, formTemplates, items, paychecks } from '@/lib/db/schema';
import type { ServiceContext } from '@/lib/services/_base';
import { seedRichCompany, type RichCompany } from '@/lib/services/companyFile.fixture';
import { createEmployee, runPaycheck, updateEmployee } from '@/lib/services/payroll';
import { createVendor } from '@/lib/services/vendors';
import { createBankAccount } from '@/lib/services/bankAccounts';
import { createExpense } from '@/lib/services/expenses';
import { createEntry } from '@/lib/services/lists/simpleLists';
import { upsertStateTaxSetting } from '@/lib/services/payrollAdjustments';
import { createTaxAgency, createTaxRate } from '@/lib/services/salesTax';
import { paySalesTaxAgencies } from '@/lib/services/liabilityPayments';
import { postJournalEntry } from '@/lib/services/posting';
import { createBankRule } from '@/lib/services/bankRules';
import { createBudget } from '@/lib/services/budgets';
import { createLead } from '@/lib/services/leads';
import { createTodo } from '@/lib/services/todos';
import { createSalesRep } from '@/lib/services/salesReps';
import { createJob } from '@/lib/services/jobs';
import { createPurchaseOrder } from '@/lib/services/purchaseOrders';
import { createSalesOrder } from '@/lib/services/salesOrders';
import { createLoan } from '@/lib/services/loans';
import { createAsset } from '@/lib/services/fixedAssets';
import { startReconciliation } from '@/lib/services/reconcile';
import { saveMemorizedReport } from '@/lib/services/memorizedReports';
import { saveCommentedReport } from '@/lib/services/commentedReports';
import { createBillingRateLevel } from '@/lib/services/lists/billingRates';
import { createUomSet } from '@/lib/services/lists/uom';
import { createSite } from '@/lib/services/inventorySites';
import { createFormTemplate } from '@/lib/services/formTemplates';
import { createPayrollItem } from '@/lib/services/payrollItems';
import { createReport as createExpenseReport } from '@/lib/services/expenseReports';
import { createTemplate } from '@/lib/services/recurring';
import { createBillingGroup } from '@/lib/services/billingGroups';
import { createItem } from '@/lib/services/items';
import { createItemReceipt } from '@/lib/services/itemReceipts';
import { createInventoryTransfer } from '@/lib/services/inventoryTransfers';
import { setBom } from '@/lib/services/assemblies';
import { createBill, getBill } from '@/lib/services/bills';
import { saveAttachment } from '@/lib/services/attachments';
import { payBills } from '@/lib/services/billPayments';
import { createVendorCredit } from '@/lib/services/vendorCredits';
import { allocateLandedCost } from '@/lib/services/landedCost';
import { runStandardReport } from '@/lib/services/reportRegistry';
import AdmZip from 'adm-zip';
import { readOnlyDb } from '@/lib/db/readOnly';
import { fullAccess, type EffectiveAccess } from '@/lib/permissions/model';
import { agentAccess, createAgent } from '@/lib/services/agents';
import { createAgentRequest } from '@/lib/services/agentRequests';
import { readPdfDocument } from '@/lib/receipts/pdfText';
import { readStagedFile } from '@/lib/agent/files';
import { operationById } from '@/lib/agent/operations/registry';
import { approvalNeeds } from '@/lib/agent/policy';
import type { Operation, RequestFacts } from '@/lib/agent/operations/types';
import type { BridgeActor, BridgeResult, FileOwner, OperationInput } from '@/lib/agent/contract';

// ---------------------------------------------------------------------------
// The protected values (distinctive on purpose)
// ---------------------------------------------------------------------------

export const SSN_DANA = '521-73-9846';
export const SSN_LEE = '608-24-1357';
/** A sole proprietor's tax ID is their SSN (lib/permissions/mask.ts). */
export const TAX_ID_SOLE = '433-91-2087';
export const TAX_ID_EIN = '84-7362915';
export const VENDOR_ACCOUNT = 'VND-90817263544';
export const CONTRACTOR_ACCOUNT = 'CTR-55120938471';
export const AGENCY_ACCOUNT = 'TAX-66019283745';
export const BANK_ACCOUNT = '004417829013';
export const OTHER_NAME_ACCOUNT = 'LEASE-77310492';
export const STATE_ACCOUNT = 'SUI-3301847265';

export interface Secret {
  kind: 'ssn' | 'tax_id' | 'account_number';
  label: string;
  value: string;
}

export const SECRETS: readonly Secret[] = [
  { kind: 'ssn', label: 'employee SSN (Dana)', value: SSN_DANA },
  { kind: 'ssn', label: 'employee SSN (Lee)', value: SSN_LEE },
  { kind: 'tax_id', label: 'vendor tax ID (sole proprietor SSN)', value: TAX_ID_SOLE },
  { kind: 'tax_id', label: 'vendor tax ID (EIN)', value: TAX_ID_EIN },
  { kind: 'account_number', label: 'vendor account number', value: VENDOR_ACCOUNT },
  { kind: 'account_number', label: '1099 contractor account number', value: CONTRACTOR_ACCOUNT },
  { kind: 'account_number', label: 'tax agency vendor account number', value: AGENCY_ACCOUNT },
  { kind: 'account_number', label: 'bank account number', value: BANK_ACCOUNT },
  { kind: 'account_number', label: 'Other Names account number', value: OTHER_NAME_ACCOUNT },
  { kind: 'account_number', label: 'employer state account number', value: STATE_ACCOUNT },
];

/** The digits of a value: a full number may be answered without its dashes. */
export function digitsOf(v: string): string {
  return v.replace(/\D/g, '');
}

/**
 * The value as stored, or its digits with up to three separators between any two of them
 * ("521739846", "521 73 9846", "0044-1782-9013", "521.73.9846", or a PDF's text layer that put
 * each group on its own line). A digit just before or after does not count: a longer number that
 * happens to hold these digits is another number.
 */
function secretPattern(s: Secret): RegExp {
  let re = PATTERNS.get(s.value);
  if (!re) {
    const exact = s.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const digits = digitsOf(s.value);
    const spaced = digits.length >= 8 ? `|${digits.split('').join('[\\s\\-./]{0,3}')}` : '';
    re = new RegExp(`(?<!\\d)(?:${exact}${spaced})(?!\\d)`);
    PATTERNS.set(s.value, re);
  }
  return re;
}
const PATTERNS = new Map<string, RegExp>();

/**
 * Where a protected value appears in `text` in full, with a little of the text around it. The
 * masked forms keep 4 digits at most, so they never match.
 */
export function findSecrets(text: string, secrets: readonly Secret[] = SECRETS): Array<{ secret: Secret; at: string }> {
  const found: Array<{ secret: Secret; at: string }> = [];
  for (const s of secrets) {
    const m = secretPattern(s).exec(text);
    if (m) found.push({ secret: s, at: text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20).replace(/\s+/g, ' ') });
  }
  return found;
}

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------

export interface ReadsCompany {
  rich: RichCompany;
  /** Trusted (no access): what seeded the company. */
  ctx: ServiceContext;
  acct: Record<string, string>;
  /** Ids of the records the tests read by id, by name. */
  ids: Record<string, string>;
  /** Seeds that failed, with the app's message. */
  seedErrors: Array<{ seed: string; error: string }>;
}

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

export async function seedReadsCompany(db: DB, dataDir: string, name = 'Agent Reads Co'): Promise<ReadsCompany> {
  const rich = await seedRichCompany(db, dataDir, name);
  const ctx = rich.ctx;
  const acct: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) acct[a.code] = a.id;
  const ids: Record<string, string> = { customer: rich.customerId, vendor: rich.vendorId, checking: acct['1000'] };
  const seedErrors: ReadsCompany['seedErrors'] = [];
  const seed = async <T>(label: string, work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch (err) {
      seedErrors.push({ seed: label, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  // --- Payroll: two employees with full SSNs and a paycheck each (2026, the current year) ---
  await seed('employees and paychecks', async () => {
    const dana = await createEmployee(ctx, { firstName: 'Dana', lastName: 'Reader', payType: 'salary', payRate: '62000.00', email: 'dana@reads.test' });
    await updateEmployee(ctx, dana.id, {
      ssn: SSN_DANA,
      address: { line1: '12 Elm St', city: 'Springfield', state: 'IL', zip: '62701' },
      w4: { filingStatus: 'single', dependents: 0 },
    });
    const lee = await createEmployee(ctx, { firstName: 'Lee', lastName: 'Hourly', payType: 'hourly', payRate: '24.00' });
    await updateEmployee(ctx, lee.id, { ssn: SSN_LEE, address: { line1: '9 Oak Ave', city: 'Springfield', state: 'IL', zip: '62702' } });
    ids.employee = dana.id;
    ids.employee2 = lee.id;
    const pc = await runPaycheck(ctx, { employeeId: dana.id, payDate: d('2026-03-13'), periodStart: d('2026-03-01'), periodEnd: d('2026-03-13'), grossPay: '2384.62' });
    await runPaycheck(ctx, { employeeId: lee.id, payDate: d('2026-03-13'), grossPay: '960.00' });
    ids.paycheck = pc.id;
  });

  // --- Vendors with tax IDs and account numbers; a 1099 contractor paid over the threshold ---
  await seed('vendors with tax ids', async () => {
    const supplier = await createVendor(ctx, { displayName: 'Ledger Paper Mill', taxId: TAX_ID_EIN, accountNumber: VENDOR_ACCOUNT } as never);
    ids.vendorWithNumber = supplier.id;
    const contractor = await createVendor(ctx, {
      displayName: 'Pat Contractor',
      is1099: true,
      taxId: TAX_ID_SOLE,
      accountNumber: CONTRACTOR_ACCOUNT,
      address: { street: '4 Side Rd', city: 'Springfield', state: 'IL', zip: '62703' },
    } as never);
    ids.contractor = contractor.id;
    // Paid by check, over the 1099 threshold for 2026 ($2,000): on the 1099 reports.
    await createExpense(ctx, {
      vendorId: contractor.id,
      date: d('2026-04-10'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'] ?? acct['6300'], description: 'Bookkeeping cleanup', amount: '2450.00' }],
    });
    // A check waiting to print with no memo: the print queue fills it with "Acct # <full number>".
    const queued = await createExpense(ctx, {
      vendorId: supplier.id,
      date: d('2026-05-04'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], description: 'Ledger paper', amount: '212.00' }],
    });
    ids.queuedCheck = queued.id;
    // A check with the account number typed in its memo.
    const typed = await createExpense(ctx, {
      vendorId: supplier.id,
      date: d('2026-05-06'),
      method: 'check',
      memo: `Acct # ${VENDOR_ACCOUNT}`,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], description: 'Ledger paper', amount: '48.00' }],
    });
    ids.typedMemoCheck = typed.id;
    // The vendor's own documents (a purchase order and a vendor credit print the vendor's details;
    // a bill payment check to it waits to print with "Acct # <full number>" on its memo).
    const po = await createPurchaseOrder(ctx, {
      vendorId: supplier.id,
      date: d('2026-05-01'),
      lines: [{ accountId: acct['6300'], description: 'Ledger paper, 10 reams', quantity: '10', rate: '21.20' }],
    });
    ids.purchaseOrderNumbered = (po as { id: string }).id;
    const bill = await createBill(ctx, {
      vendorId: supplier.id,
      billNumber: 'LPM-501',
      date: d('2026-05-08'),
      lines: [{ accountId: acct['6300'], description: 'Ledger paper', amount: '130.00' }],
    } as never);
    ids.billNumbered = (bill as { id: string }).id;
    const paid = await payBills(ctx, {
      vendorId: supplier.id,
      date: d('2026-05-20'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      applications: [{ billId: ids.billNumbered, amountApplied: '130.00' }],
    } as never);
    ids.billPaymentNumbered = (paid as { id: string }).id;
    const credit = await createVendorCredit(ctx, {
      vendorId: supplier.id,
      date: d('2026-05-22'),
      lines: [{ accountId: acct['6300'], description: 'Torn reams', amount: '15.00' }],
    } as never);
    ids.vendorCreditNumbered = (credit as { id: string }).id;
  });

  // --- A document filed to the contractor that holds its tax ID and account number in full (a W-9
  // as text), so the read of a document (attachments.get, read_sensitive) has something to show ---
  await seed('tax form document', async () => {
    if (!ids.contractor) throw new Error('no contractor to file the W-9 to');
    const text = `Form W-9 (copy)\nName: Pat Contractor\nTaxpayer identification number: ${TAX_ID_SOLE}\nOur account with them: ${CONTRACTOR_ACCOUNT}\n`;
    const row = await saveAttachment(ctx, {
      entityType: 'vendor',
      entityId: ids.contractor,
      filename: 'W-9 Pat Contractor.txt',
      mimeType: 'text/plain',
      base64: Buffer.from(text, 'utf8').toString('base64'),
      description: 'Signed W-9',
    });
    ids.taxFormDocument = row.id;
  });

  // --- A bank account with its full number ---
  await seed('bank account', async () => {
    const bank = await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Test Bank', accountNumber: BANK_ACCOUNT });
    ids.bankAccount = (bank as { id: string }).id;
  });

  // --- An Other Names payee and the employer's state account number ---
  await seed('other name', async () => {
    const landlord = await createEntry(ctx, 'other-names', { name: 'Landlord Holdings', accountNumber: OTHER_NAME_ACCOUNT });
    ids.otherName = String(landlord.id);
    await createExpense(ctx, {
      otherNameId: String(landlord.id),
      date: d('2026-06-01'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'] ?? acct['6300'], description: 'June rent', amount: '1400.00' }],
    });
  });
  await seed('state account number', async () => {
    await upsertStateTaxSetting(ctx, { state: 'IL', year: 2026, suiRate: '0.0325', suiWageBase: '13590', accountNumber: STATE_ACCOUNT });
  });

  // --- A Sales Tax Payment check that stores "Acct # <full number>" ---
  await seed('sales tax payment', async () => {
    await createVendor(ctx, { displayName: 'Illinois Revenue Dept', accountNumber: AGENCY_ACCOUNT } as never);
    const agency = await createTaxAgency(ctx, { name: 'Illinois Revenue Dept' });
    ids.taxAgency = agency.id;
    const rate = await createTaxRate(ctx, { name: 'IL State 6.25', rate: '0.0625', agencyId: agency.id });
    ids.taxRate = (rate as { id: string }).id;
    const paid = await paySalesTaxAgencies(ctx, { date: d('2026-07-15'), paymentAccountId: acct['1000'], payments: [{ agencyId: agency.id, amount: '31.25' }], toPrint: true });
    ids.salesTaxPayment = paid.checks[0].id;
  });

  // --- A journal line typed with the full number (as the books still hold from before) ---
  await seed('journal line memo', async () => {
    const je = await postJournalEntry(ctx, {
      date: d('2026-07-16'),
      description: 'Sales Tax Payment (old)',
      lines: [
        { accountId: acct['2200'] ?? acct['2100'], debit: '10.00', memo: `Acct # ${AGENCY_ACCOUNT}` },
        { accountId: acct['1000'], credit: '10.00' },
      ],
    } as never);
    ids.memoEntry = (je as { id: string }).id;
  });

  // --- One record of the kinds an operation's path names ---
  await seed('purchase order', async () => {
    const po = await createPurchaseOrder(ctx, {
      vendorId: rich.vendorId,
      date: d('2026-02-02'),
      lines: [{ accountId: acct['6300'], description: 'Toner', quantity: '2', rate: '35.00' }],
    });
    ids.purchaseOrder = (po as { id: string }).id;
  });
  await seed('sales order', async () => {
    const so = await createSalesOrder(ctx, { customerId: rich.customerId, date: d('2026-02-03'), lines: [{ description: 'Phase 3', quantity: '1', rate: '400.00' }] });
    ids.salesOrder = (so as { id: string }).id;
  });
  await seed('budget', async () => {
    ids.budget = (await createBudget(ctx, { name: 'FY2026 plan', fiscalYear: 2026 })).id;
  });
  await seed('bank rule', async () => {
    ids.bankRule = (await createBankRule(ctx, { name: 'Paper', matchField: 'description' as never, matchOperator: 'contains' as never, matchValue: 'PAPER', setAccountId: acct['6300'] })).id;
  });
  await seed('bank transaction', async () => {
    const [bank] = await db.select().from(bankAccounts).where(eq(bankAccounts.companyId, ctx.companyId));
    const [row] = await db
      .insert(bankTransactions)
      .values({ companyId: ctx.companyId, bankAccountId: bank.id, date: d('2026-05-05'), description: 'PAPER MILL 212.00', amount: '-212.00' } as never)
      .returning();
    ids.bankTransaction = (row as { id: string }).id;
  });
  await seed('lead', async () => {
    ids.lead = (await createLead(ctx, { name: 'Prospect Bakery', email: 'hello@bakery.test' })).id;
  });
  await seed('todo', async () => {
    ids.todo = String((await createTodo(ctx, { title: 'Call the bank', dueDate: '2026-11-30' })).id);
  });
  await seed('sales rep', async () => {
    ids.salesRep = (await createSalesRep(ctx, { name: 'Sam Seller', commissionRate: '0.05' }) as { id: string }).id;
  });
  await seed('job', async () => {
    ids.job = (await createJob(ctx, { customerId: rich.customerId, name: 'Office move', budget: '5000.00' }) as { id: string }).id;
  });
  await seed('loan', async () => {
    const loan = await createLoan(ctx, {
      name: 'Van loan',
      liabilityAccountId: acct['2700'] ?? acct['2100'],
      interestAccountId: acct['7100'] ?? acct['6400'],
      paymentAccountId: acct['1000'],
      originalAmount: '18000.00',
      annualRate: '6.5',
      termMonths: 48,
      originDate: d('2026-01-05'),
      firstPaymentDate: d('2026-02-05'),
    });
    ids.loan = (loan as { id: string }).id;
  });
  await seed('fixed asset', async () => {
    ids.fixedAsset = (await createAsset(ctx, { name: 'Laptop', cost: '2400.00', usefulLifeMonths: 36, placedInService: d('2026-01-15') }) as { id: string }).id;
  });
  await seed('reconciliation', async () => {
    if (!ids.bankAccount) throw new Error('no bank account to reconcile');
    ids.reconciliation = (await startReconciliation(ctx, { bankAccountId: ids.bankAccount, statementDate: '2026-01-31', statementBalance: '20000.00' })).id;
  });
  await seed('billing group', async () => {
    ids.billingGroup = (await createBillingGroup(ctx, { name: 'Monthly billing', customerIds: [rich.customerId] })).id;
  });
  await seed('memorized report', async () => {
    const saved = await saveMemorizedReport(ctx, { name: 'My P&L', reportType: 'profit-loss', config: { from: '2026-01-01', to: '2026-12-31' } });
    ids.memorizedReport = (saved as { id: string }).id;
  });
  await seed('commented report', async () => {
    ids.commentedReport = (await saveCommentedReport(ctx, { name: 'P&L notes', reportType: 'profit-loss', params: { from: '2026-01-01', to: '2026-12-31' } })).id;
  });
  await seed('billing rate level', async () => {
    ids.billingRateLevel = String((await createBillingRateLevel(ctx, { name: 'Senior', type: 'fixed_rate', fixedRate: '150.00' }) as { id: unknown }).id);
  });
  await seed('unit of measure set', async () => {
    ids.uomSet = String((await createUomSet(ctx, { name: 'Count', type: 'count', baseUnitName: 'Each', baseUnitAbbrev: 'ea', units: [] }) as { id: unknown }).id);
  });
  await seed('form template', async () => {
    ids.formTemplate = (await createFormTemplate(ctx, { formType: 'invoice', name: 'Plain invoice' })).id;
  });
  await seed('expense report', async () => {
    if (!ids.employee) throw new Error('no employee');
    ids.expenseReport = String((await createExpenseReport(ctx, { employeeId: ids.employee, title: 'March travel', lines: [{ accountId: acct['6300'], description: 'Taxi', amount: '42.00' }] }) as { id: unknown }).id);
  });
  await seed('recurring template', async () => {
    ids.recurring = String(
      (
        (await createTemplate(ctx, {
          name: 'Monthly retainer',
          docType: 'invoice' as never,
          frequency: 'monthly' as never,
          nextRunDate: '2026-12-01',
          mode: 'remind' as never,
          template: { customerId: rich.customerId, lines: [{ description: 'Retainer', quantity: 1, rate: '500.00', accountId: acct['4000'] }] },
        })) as { id: unknown }
      ).id,
    );
  });

  // Ids found rather than made.
  const first = async (label: string, key: string, q: Promise<Array<{ id: unknown }>>) => {
    const rows = await seed(label, () => q);
    if (rows?.[0]) ids[key] = String(rows[0].id);
  };
  await first('audit row', 'auditLog', db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.companyId, ctx.companyId)).limit(1));
  await first('form template', 'formTemplate', db.select({ id: formTemplates.id }).from(formTemplates).where(eq(formTemplates.companyId, ctx.companyId)).limit(1));
  if (!ids.paycheck) await first('paycheck', 'paycheck', db.select({ id: paychecks.id }).from(paychecks).where(and(eq(paychecks.companyId, ctx.companyId))).limit(1));

  // A barcode to look an item up by (items.barcode).
  await seed('item barcode', async () => {
    const [item] = await db.select({ id: items.id }).from(items).where(eq(items.companyId, ctx.companyId)).limit(1);
    await db.update(items).set({ barcode: 'IB-0001' }).where(eq(items.id, item.id));
  });

  return { rich, ctx, acct, ids, seedErrors };
}

/**
 * The records whose list a GET seeds with defaults on first use (an inventory site, a payroll
 * item). Made after the reads that write on first use have been tried on a company where nobody
 * opened those lists yet; creating them seeds the defaults, and the reads stop writing.
 */
export async function seedFirstUseRecords(fx: ReadsCompany): Promise<void> {
  const { ctx, ids, seedErrors } = fx;
  const seed = async (label: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      seedErrors.push({ seed: label, error: err instanceof Error ? err.message : String(err) });
    }
  };
  await seed('inventory site', async () => {
    ids.inventorySite = (await createSite(ctx, { name: 'North warehouse', code: 'NORTH' })).id;
  });
  await seed('inventory item and receipt', async () => {
    const widget = await createItem(ctx, {
      name: 'Widget',
      type: 'inventory' as never,
      salesPrice: '12.00',
      incomeAccountId: fx.acct['4000'],
      assetAccountId: fx.acct['1300'],
      expenseAccountId: fx.acct['5000'],
    } as never);
    ids.inventoryItem = (widget as { id: string }).id;
    const receipt = await createItemReceipt(ctx, {
      vendorId: fx.rich.vendorId,
      date: d('2026-02-10'),
      lines: [{ itemId: ids.inventoryItem, quantity: '20', unitCost: '5.00' }],
    });
    ids.itemReceipt = (receipt as { id: string }).id;
  });
  await seed('inventory transfer', async () => {
    if (!ids.inventoryItem || !ids.inventorySite) throw new Error('no item or site');
    const back = await createSite(ctx, { name: 'Back room', code: 'BACK' });
    // The receipt's stock is at the default site; move some to the back room.
    const [dflt] = (await ctx.db.execute(sql`select id::text as id from inventory_sites where company_id = ${ctx.companyId} and is_default = true limit 1`) as unknown as { rows: Array<{ id: string }> }).rows;
    const t = await createInventoryTransfer(ctx, { date: new Date('2026-02-11T12:00:00.000Z'), fromSiteId: dflt?.id ?? ids.inventorySite, toSiteId: back.id, lines: [{ itemId: ids.inventoryItem, quantity: '2' }] });
    ids.inventoryTransfer = (t as { id: string }).id;
  });
  await seed('payroll item', async () => {
    ids.payrollItem = String((await createPayrollItem(ctx, { name: 'Health insurance', kind: 'deduction' as never, pretax: true, liabilityAccountId: fx.acct['2300'] ?? null }) as { id: unknown }).id);
  });
  // An assembly built from the widget (its bill of materials is what GET /api/assemblies reads).
  await seed('assembly', async () => {
    if (!ids.inventoryItem) throw new Error('no inventory item');
    const kit = await createItem(ctx, {
      name: 'Widget kit',
      type: 'inventory' as never,
      salesPrice: '30.00',
      incomeAccountId: fx.acct['4000'],
      assetAccountId: fx.acct['1300'],
      expenseAccountId: fx.acct['5000'],
    } as never);
    ids.assembly = (kit as { id: string }).id;
    await setBom(ctx, ids.assembly, [{ componentItemId: ids.inventoryItem, quantity: '2' }]);
  });
  // A freight bill spread over the widget's receipt (landed cost), with a duty line still to spread.
  await seed('landed cost', async () => {
    if (!ids.itemReceipt) throw new Error('no item receipt');
    const bill = await createBill(ctx, {
      vendorId: fx.rich.vendorId,
      billNumber: 'FRT-9',
      date: d('2026-02-12'),
      lines: [
        { accountId: fx.acct['6300'], description: 'Freight', amount: '20.00' },
        { accountId: fx.acct['6300'], description: 'Duty', amount: '8.00' },
      ],
    } as never);
    const full = (await getBill(ctx, (bill as { id: string }).id)) as unknown as { id: string; lines: Array<{ id: string; description: string | null }> };
    const freight = full.lines.find((l) => l.description === 'Freight');
    const duty = full.lines.find((l) => l.description === 'Duty');
    if (!freight || !duty) throw new Error('the bill lines were not found');
    ids.landedCostBill = full.id;
    ids.landedCostDutyLine = duty.id;
    const allocated = await allocateLandedCost(ctx, { billId: full.id, billLineId: freight.id, method: 'quantity', itemReceiptIds: [ids.itemReceipt] });
    ids.landedCost = allocated.id;
  });
}

/**
 * One permission request of the agent's own (to read back with GET /api/agent/requests/[id]):
 * asking to add a to-do, the plainest thing an agent asks for.
 */
export async function seedAgentRequest(fx: ReadsCompany, agent: ReadsAgent): Promise<void> {
  try {
    const op = operationById('todos.create');
    if (!op) throw new Error('no operation todos.create');
    const facts: RequestFacts = { confirm: [], reveal: false, amount: null, count: null, entityIds: [], accountIds: [], date: null, closedPeriod: false };
    const made = await createAgentRequest(agent.base, {
      kind: 'operation',
      requestKey: 'reads-fixture-todo-1',
      operation: op,
      input: { body: { title: 'Call the bank about the statement' } },
      reason: 'Reminder for the month-end close',
      summary: 'Add a to-do: Call the bank about the statement',
      effectiveClass: op.class,
      needs: approvalNeeds(op, op.class, facts, { twoPersonOver: null }),
      facts,
      preview: null,
      stalenessKey: null,
    });
    fx.ids.agentRequest = made.id;
  } catch (err) {
    fx.seedErrors.push({ seed: 'agent request', error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Database fingerprint: what a read must leave exactly as it was
// ---------------------------------------------------------------------------

export interface Fingerprint {
  /** "table": "rows|max(updated_at)". */
  tables: Record<string, string>;
}

let fingerprintSql: string | null = null;

/**
 * Row counts of every table, and max(updated_at) where a table has one, in one statement (a cheap
 * stand-in for checksums: an insert, a delete or an update through the services moves one of them).
 */
export async function fingerprint(db: DB): Promise<Fingerprint> {
  if (!fingerprintSql) {
    const cols = (await db.execute(sql`
      select t.table_name, exists (
        select 1 from information_schema.columns c
         where c.table_schema = t.table_schema and c.table_name = t.table_name and c.column_name = 'updated_at'
      ) as has_updated
        from information_schema.tables t
       where t.table_schema = current_schema() and t.table_type = 'BASE TABLE'
       order by t.table_name`)) as unknown as { rows: Array<{ table_name: string; has_updated: boolean }> };
    fingerprintSql = cols.rows
      .map(
        (r) =>
          `select '${r.table_name}' as t, count(*)::text || '|' || ${r.has_updated ? `coalesce(max("updated_at")::text, '')` : `''`} as v from "${r.table_name}"`,
      )
      .join(' union all ');
  }
  const res = (await db.execute(sql.raw(fingerprintSql))) as unknown as { rows: Array<{ t: string; v: string }> };
  const tables: Record<string, string> = {};
  for (const r of res.rows) tables[r.t] = r.v;
  return { tables };
}

/** The tables whose fingerprint differs, with before and after. */
export function fingerprintDiff(a: Fingerprint, b: Fingerprint): string[] {
  const out: string[] = [];
  for (const t of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    if (a.tables[t] !== b.tables[t]) out.push(`${t}: ${a.tables[t] ?? '(none)'} -> ${b.tables[t] ?? '(none)'}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What each operation is run with
// ---------------------------------------------------------------------------

/** A wide date range that holds every seeded record (2025 and 2026). */
export const WIDE_RANGE = { from: '2025-01-01', to: '2026-12-31' } as const;

/** One way to run an operation: a label for the report and the input. */
export interface ReadCase {
  label: string;
  input: OperationInput;
}

/**
 * The cases an operation is run with: one for most, one per report key or list name for the
 * routes whose path names one, none when the fixture cannot supply what the path needs (the test
 * then says so, unless the operation is on KNOWN).
 */
export type CasesFor = (op: Operation) => ReadCase[] | null;

// ---------------------------------------------------------------------------
// The reads both tests leave out, by case label (the operation id, or "<operation id> <report key
// or list>"). Shared, so neither test can skip a read the other does not know about: the purity
// test (test/agentReads.contract.test.ts) checks each list, the masking test expects exactly these
// cases not to answer and every other read to answer.
// ---------------------------------------------------------------------------

/**
 * Cases that cannot be run here, with why. Take one off when it can be run; never add one without
 * a reason.
 */
export const KNOWN: Readonly<Record<string, string>> = {
  'accountant-copy.changes': "answers only in an Accountant's Copy, and this company file is an ordinary one",
  'accountant-copy.changes.review': "takes the accountant's changes file as a staged upload, which this fixture does not make",
  'agent.hello': "the connector's handshake: answers only the tag and nonce of this computer's endpoint file (404 otherwise)",
  'currencies.home-currency-adjustment.get': 'needs a multi-currency company with a home currency adjustment',
};
/** The size of KNOWN may only go down: lower this when you take one off. */
export const KNOWN_MAX = 4;

/**
 * Reads an agent is refused on purpose, with why. Each must stay refused (and still write
 * nothing): one that starts to answer an agent is a hole, not a fix.
 */
export const REFUSED_BY_DESIGN: Readonly<Record<string, string>> = {
  'reports.std.get agent-activity': "the agents' own activity report is for people (agents read their own requests with list_my_requests)",
};

/**
 * FINDINGS: reads the registry offers to agents as class 'read' whose route refuses every agent,
 * with why. The purity test keeps each as an it.fails case that turns red the day it answers.
 * Empty since wave 5: the two that were here (companies.list, file-protection.status) are a
 * person's own routes and are no longer offered to agents at all (classes/admin.ts person_only);
 * the purity test checks that the bridge refuses them.
 */
export const NOT_FOR_AGENTS: Readonly<Record<string, string>> = {};

/** Every label on the three lists, with the list it is on. */
export const LEFT_OUT: ReadonlyArray<readonly [label: string, list: 'KNOWN' | 'REFUSED_BY_DESIGN' | 'NOT_FOR_AGENTS']> = [
  ...Object.keys(KNOWN).map((l) => [l, 'KNOWN'] as const),
  ...Object.keys(REFUSED_BY_DESIGN).map((l) => [l, 'REFUSED_BY_DESIGN'] as const),
  ...Object.keys(NOT_FOR_AGENTS).map((l) => [l, 'NOT_FOR_AGENTS'] as const),
];

/** The operation among `ops` a case label belongs to (the longest operation id it starts with). */
export function opOfLabel(label: string, ops: readonly Operation[]): Operation | undefined {
  return ops.filter((o) => label === o.id || label.startsWith(`${o.id} `)).sort((a, b) => b.id.length - a.id.length)[0];
}

/** Whether a case is on `labels`: by its own label or by its operation's id. */
export function listedIn(labels: Iterable<string>, caseLabel: string, op: Operation): boolean {
  const set = labels instanceof Set ? (labels as Set<string>) : new Set(labels);
  return set.has(caseLabel) || set.has(op.id);
}

/** Tables an operation's `[id]` is looked up in when the seed did not name the record itself. */
const TABLE_OF: Record<string, string> = {
  'attachments.get': 'attachments',
  'bill-payments.get': 'bill_payments',
  'billing-groups.get': 'billing_groups',
  'billing-rate-levels.get': 'billing_rate_levels',
  'bills.get': 'bills',
  'commented-reports.get': 'commented_reports',
  'credit-memos.get': 'credit_memos',
  'currencies.home-currency-adjustment.get': 'home_currency_adjustments',
  'deposits.get': 'deposits',
  'estimates.get': 'estimates',
  'estimates.pdf': 'estimates',
  'expense-reports.get': 'expense_reports',
  'expenses.get': 'expenses',
  'inventory-sites.get': 'inventory_sites',
  'inventory-transfers.get': 'inventory_transfers',
  'invoices.get': 'invoices',
  'invoices.packing-slip': 'invoices',
  'invoices.pdf': 'invoices',
  'item-receipts.get': 'item_receipts',
  'items.get': 'items',
  'items.components': 'items',
  'payments.get': 'payments_received',
  'recurring.get': 'recurring_templates',
  'sales-receipts.get': 'sales_receipts',
  'transfers.get': 'transfers',
  'uom-sets.get': 'uom_sets',
  'vendor-credits.get': 'vendor_credits',
  'vendor-credits.pdf': 'vendor_credits',
};

/** Operations whose `[id]` is a record the seed made (ReadsCompany.ids). */
const SEEDED_ID: Record<string, string> = {
  'accounts.get': 'checking',
  'audit-trail.get': 'auditLog',
  'bank-rules.get': 'bankRule',
  'bank-transactions.by-id.matches': 'bankTransaction',
  'budgets.get': 'budget',
  'budgets.vs-actual': 'budget',
  'customers.get': 'customer',
  'employees.get': 'employee',
  'fixed-assets.get': 'fixedAsset',
  'form-templates.get': 'formTemplate',
  'jobs.get': 'job',
  'journal-entries.get': 'memoEntry',
  'journal-entries.history': 'memoEntry',
  'leads.get': 'lead',
  'loans.get': 'loan',
  'loans.by-id.what-if': 'loan',
  'memorized-reports.get': 'memorizedReport',
  'payroll-items.get': 'payrollItem',
  'payroll.get': 'paycheck',
  'purchase-orders.get': 'purchaseOrder',
  'purchase-orders.pdf': 'purchaseOrder',
  'receiving.po.get': 'purchaseOrder',
  'reconciliations.get': 'reconciliation',
  'reconciliations.clearable': 'reconciliation',
  'reconciliations.report': 'reconciliation',
  'sales-orders.get': 'salesOrder',
  'sales-reps.get': 'salesRep',
  'sales-tax.payments.get': 'salesTaxPayment',
  'tax-rates.components': 'taxRate',
  'todos.get': 'todo',
  'vendors.get': 'contractor',
  'commented-reports.get': 'commentedReport',
  'billing-rate-levels.get': 'billingRateLevel',
  'uom-sets.get': 'uomSet',
  'inventory-sites.get': 'inventorySite',
  'expense-reports.get': 'expenseReport',
  'recurring.get': 'recurring',
  'billing-groups.get': 'billingGroup',
  'item-receipts.get': 'itemReceipt',
  'inventory.center.get': 'inventoryItem',
  'inventory-transfers.get': 'inventoryTransfer',
  'landed-cost.get': 'landedCost',
  'agent.requests.get': 'agentRequest',
};

/**
 * More records an operation that reads one record is also run on (ReadsCompany.ids keys): the ones
 * that hold a protected value, so the masking test reads them too.
 */
const MORE_IDS_OF: Record<string, string[]> = {
  'attachments.get': ['taxFormDocument'],
  'bill-payments.get': ['billPaymentNumbered'],
  'bills.get': ['billNumbered'],
  'employees.get': ['employee2'],
  'expenses.get': ['typedMemoCheck', 'queuedCheck'],
  'purchase-orders.get': ['purchaseOrderNumbered'],
  'purchase-orders.pdf': ['purchaseOrderNumbered'],
  'receiving.po.get': ['purchaseOrderNumbered'],
  'vendor-credits.get': ['vendorCreditNumbered'],
  'vendor-credits.pdf': ['vendorCreditNumbered'],
  'vendors.get': ['vendorWithNumber'],
};

/** Most rows one page of the audit trail answers (app/api/audit-trail/route.ts). */
const AUDIT_PAGE = 200;

/** What a case's query or body can be built from: the company and ids looked up in its tables. */
export interface CaseSources {
  fx: ReadsCompany;
  /** First id of a table (TABLE_OF), or null when it is empty. */
  table: Record<string, string | null>;
  /** The seeded attachment's record, and the sales order's first line. */
  attachment: { entityType: string; entityId: string } | null;
  salesOrderLineId: string | null;
  /** A row and money column of the Profit & Loss (for reports.drilldown.get). */
  drilldown: { row: string; col: string } | null;
  /** How many audit rows the company has (the audit trail is read page by page). */
  auditRows: number;
  /** The audit rows whose old or new values hold a protected value in full, with a label each. */
  auditWithSecrets: Array<{ id: string; label: string }>;
}

const YEAR = '2026';
const idOf = (s: CaseSources, key: string) => s.fx.ids[key] ?? '';

/** Query strings an operation needs to answer at all (found by running each one bare). */
export const QUERY_OF: Record<string, (s: CaseSources) => Record<string, string>> = {
  'accountant.reclassify': (s) => ({ accountId: s.fx.acct['6300'], ...WIDE_RANGE }),
  'accountant.working-trial-balance': () => ({ ...WIDE_RANGE }),
  assemblies: (s) => ({ assemblyItemId: idOf(s, 'assembly') }),
  'attachments.list': (s) => (s.attachment ? { ...s.attachment } : {}),
  'bank-transactions': (s) => ({ bankAccountId: idOf(s, 'bankAccount') }),
  'bank-transactions.matches': (s) => ({ bankAccountId: idOf(s, 'bankAccount') }),
  'bill-payments.journal-items': (s) => ({ vendorId: s.fx.rich.vendorId }),
  billables: (s) => ({ customerId: s.fx.rich.customerId }),
  'billing-rate-levels.resolve': (s) => ({ itemId: s.table.items ?? '', employeeId: idOf(s, 'employee') }),
  calendar: () => ({ from: '2026-01-01', to: '2026-12-31' }),
  'collections.notes.list': (s) => ({ customerId: s.fx.rich.customerId }),
  'export.statements.open-item': (s) => ({ customerId: s.fx.rich.customerId, asOf: '2026-11-20' }),
  'export.statements.open-item.pdf': (s) => ({ customerId: s.fx.rich.customerId, asOf: '2026-11-20' }),
  'fulfillment.packing-slips': (s) => ({ s: JSON.stringify([{ salesOrderId: idOf(s, 'salesOrder'), lines: [{ lineId: s.salesOrderLineId, quantity: '1' }] }]) }),
  'fulfillment.pick-list': (s) => ({ s: JSON.stringify([{ salesOrderId: idOf(s, 'salesOrder'), lines: [{ lineId: s.salesOrderLineId, quantity: '1' }] }]) }),
  'inventory-sites.reports': () => ({ report: 'qoh' }),
  'items.barcode': () => ({ code: 'IB-0001' }),
  'journal-entries.for-source': (s) => ({ ref: `invoice:${s.table.invoices ?? ''}` }),
  'letters.recipients': () => ({ type: 'vendor' }),
  'month-end-close': () => ({ periodEnd: '2026-03-31' }),
  'month-end-close.report-pack': () => ({ periodEnd: '2026-03-31' }),
  'network-policy.check': () => ({ purpose: 'updates', url: 'https://example.com/' }),
  'notes.list': (s) => ({ entityType: 'customer', entityId: s.fx.rich.customerId }),
  'payments.credits': (s) => ({ customerId: s.fx.rich.customerId }),
  'payments.discounts': (s) => ({ customerId: s.fx.rich.customerId }),
  'payments.journal-items': (s) => ({ customerId: s.fx.rich.customerId }),
  'payroll.940': () => ({ year: YEAR }),
  'payroll.941': () => ({ year: YEAR, quarter: '1' }),
  'payroll.paystub': (s) => ({ paycheckId: idOf(s, 'paycheck') }),
  'payroll.state-wage-worksheet': () => ({ state: 'IL', year: YEAR, quarter: '1' }),
  'payroll.unpaid-time': (s) => ({ employeeId: idOf(s, 'employee2'), periodStart: '2026-03-01', periodEnd: '2026-03-31' }),
  'payroll.w2': (s) => ({ employeeId: idOf(s, 'employee'), year: YEAR }),
  'payroll.w3': () => ({ year: YEAR }),
  'receiving.open-lines': (s) => ({ vendorId: s.fx.rich.vendorId }),
  'reconciliations.info': (s) => ({ bankAccountId: idOf(s, 'bankAccount') }),
  'reports.1099': () => ({ year: YEAR }),
  'reports.1099-pdf': (s) => ({ vendorId: idOf(s, 'contractor'), year: YEAR }),
  'reports.1099-xml': () => ({ year: YEAR }),
  'reports.budget-vs-actual': (s) => ({ budgetId: idOf(s, 'budget') }),
  'reports.budget-vs-actual-class': (s) => ({ budgetId: idOf(s, 'budget') }),
  'reports.customer-statement': (s) => ({ customerId: s.fx.rich.customerId, ...WIDE_RANGE }),
  'reports.customer-statement.pdf': (s) => ({ customerId: s.fx.rich.customerId, ...WIDE_RANGE }),
  'reports.pl-comparative': () => ({ from: '2026-01-01', to: '2026-12-31', priorFrom: '2025-01-01', priorTo: '2025-12-31' }),
  'reports.pl-monthly': () => ({ year: YEAR }),
  'reports.pivot': () => ({ rows: 'account', ...WIDE_RANGE }),
  'smart-defaults.bills': (s) => ({ form: 'bill', vendorId: idOf(s, 'vendorWithNumber') }),
  'smart-defaults.expenses': (s) => ({ form: 'check', vendorId: idOf(s, 'vendorWithNumber') }),
  'smart-defaults.sales': (s) => ({ form: 'invoice', customerId: s.fx.rich.customerId }),
  'terms.compute': () => ({ terms: 'Net 30', date: '2026-03-01' }),
  'why-changed': (s) => ({ since: '2026-01-01T00:00:00.000Z', accounts: s.fx.acct['1000'] }),
};

/** Extra query of one standard report (reports.std.get), by report key. */
export const REPORT_QUERY_OF: Record<string, (s: CaseSources) => Record<string, string>> = {
  'budget-overview': (s) => ({ budgetId: idOf(s, 'budget') }),
  'budget-vs-actual-report': (s) => ({ budgetId: idOf(s, 'budget') }),
  'forecast-overview': (s) => ({ budgetId: idOf(s, 'budget') }),
  'cash-flow-forecast': () => ({ from: '2026-11-01', to: '2026-12-31' }),
};

/**
 * More cases of one operation: the other answer shapes a query or body switch gives (the JSON form
 * of a PDF form, a CSV or a workbook), each with the case's own query on top of QUERY_OF.
 */
export const VARIANTS_OF: Record<string, (s: CaseSources) => Array<{ label: string; query?: Record<string, string>; body?: unknown }>> = {
  'payroll.940': () => [{ label: 'format=json', query: { format: 'json' } }],
  'payroll.941': () => [{ label: 'format=json', query: { format: 'json' } }],
  'payroll.w3': () => [{ label: 'format=json', query: { format: 'json' } }],
  'inventory.worksheet': () => [{ label: 'format=csv', query: { format: 'csv' } }],
  'export.statements.batch': () => [{ label: 'format=open_item', query: { format: 'open_item' } }],
  'memorized-reports.process': (s) => [{ label: 'format=xlsx', body: { ids: [idOf(s, 'memorizedReport')], format: 'xlsx' } }],
  'transaction-log': () => [{ label: 'everything', query: { limit: '5000' } }],
  // Every kind of the inventory-by-site report (the case itself is report=qoh): each reaches other
  // code, and all but transactions make the default site on first use.
  'inventory-sites.reports': (s): Array<{ label: string; query: Record<string, string> }> => [
    { label: 'report=stock-status', query: { report: 'stock-status' } },
    { label: 'report=reorder', query: { report: 'reorder' } },
    { label: 'report=serial-lot', query: { report: 'serial-lot' } },
    { label: 'report=transactions', query: { report: 'transactions', includeReversed: '1' } },
    // The widget once it exists; before the first-use records, the company's first item.
    { label: 'report=item', query: { report: 'item', itemId: idOf(s, 'inventoryItem') || (s.table.items ?? '') } },
    { label: 'report=invariants', query: { report: 'invariants' } },
  ],
  // Every page, so the rows of the vendors, employees and bank accounts made early are read too.
  'audit-trail': (s) =>
    Array.from({ length: Math.max(1, Math.ceil(s.auditRows / AUDIT_PAGE)) }, (_, i) => ({
      label: `page ${i + 1}`,
      query: { limit: String(AUDIT_PAGE), offset: String(i * AUDIT_PAGE) },
    })),
};

/** Bodies of the reads that are POSTs. */
export const BODY_OF: Record<string, (s: CaseSources) => unknown> = {
  'bank-rules.test': () => ({ name: 'Paper', matchField: 'description', matchOperator: 'contains', matchValue: 'PAPER' }),
  'checks.pdf': (s) => ({ source: 'expense', id: idOf(s, 'queuedCheck') }),
  'export.reports': () => ({
    format: 'pdf',
    filename: 'trial-balance',
    title: 'Trial Balance',
    columns: [{ header: 'Account' }, { header: 'Amount', numeric: true }],
    rows: [['Checking', '1000.00']],
  }),
  'form-templates.preview': () => ({ formType: 'invoice' }),
  'import.csv-preview': () => ({ content: 'Date,Description,Amount\n2026-01-05,Coffee,-4.50\n', csvMapping: { dateCol: 0, descriptionCol: 1, amountCol: 2 } }),
  'landed-cost.preview': (s) => ({
    billId: idOf(s, 'landedCostBill'),
    billLineId: idOf(s, 'landedCostDutyLine'),
    method: 'quantity',
    itemReceiptIds: [idOf(s, 'itemReceipt')],
  }),
  'letters.envelopes': (s) => ({ recipientType: 'vendor', recipientIds: [idOf(s, 'contractor')] }),
  'letters.labels': (s) => ({ recipientType: 'vendor', recipientIds: [idOf(s, 'contractor')] }),
  'letters.prepare': (s) => ({ recipientType: 'vendor', recipientIds: [idOf(s, 'contractor')], body: 'Hello, your account is current.' }),
  'loans.what-if': () => ({ originalAmount: '10000.00', annualRate: '6', termMonths: 36, originDate: '2026-01-01', firstPaymentDate: '2026-02-01' }),
  'memorized-reports.process': (s) => ({ ids: [idOf(s, 'memorizedReport')] }),
  'payroll.calc': () => ({ grossPerPeriod: '2000', periodsPerYear: 26, filingStatus: 'single', year: 2026 }),
  'payroll.state-tax': () => ({ grossPerPeriod: '2000', periodsPerYear: 26, state: 'IL' }),
  'pricing.quote': (s) => ({ customerId: s.fx.rich.customerId, date: '2026-03-01', lines: [{ itemId: s.table.items ?? '', quantity: '2' }] }),
  'print-queue.run': (s) => ({ items: [{ source: 'expense', id: idOf(s, 'queuedCheck'), checkNumber: '5001' }] }),
  'report-builder': () => ({ groupBy: 'account', ...WIDE_RANGE }),
};

/**
 * The cases of every operation, for this company. `reportKeys` are the standard reports' keys
 * (lib/reports/catalog.ts), `listKeys` the simple lists' (lib/services/lists/simpleLists.ts).
 */
export async function buildCases(
  db: DB,
  fx: ReadsCompany,
  keys: { reportKeys: readonly string[]; listKeys: readonly string[] },
): Promise<CasesFor> {
  const rows = async <T>(q: string): Promise<T[]> => {
    try {
      return ((await db.execute(sql.raw(q))) as unknown as { rows: T[] }).rows;
    } catch {
      return [];
    }
  };
  const company = fx.ctx.companyId;
  const table: Record<string, string | null> = {};
  for (const t of new Set(Object.values(TABLE_OF))) {
    table[t] = (await rows<{ id: string }>(`select id::text as id from "${t}" where company_id = '${company}' order by created_at limit 1`))[0]?.id ?? null;
  }
  const [att] = await rows<{ entity_type: string; entity_id: string }>(
    `select entity_type, entity_id::text as entity_id from attachments where company_id = '${company}' and entity_id is not null limit 1`,
  );
  const [line] = fx.ids.salesOrder
    ? await rows<{ id: string }>(`select id::text as id from sales_order_lines where sales_order_id = '${fx.ids.salesOrder}' limit 1`)
    : [];
  let drilldown: CaseSources['drilldown'] = null;
  try {
    const pl = (await runStandardReport(fx.ctx, 'profit-loss', { ...WIDE_RANGE })) as unknown as {
      rows: Array<{ id?: string; kind?: string; cells?: Record<string, unknown> }>;
      columns: Array<{ key: string; type?: string }>;
    };
    const col = pl.columns.find((c) => c.type === 'money');
    const row = pl.rows.find((r) => r.kind === 'data' && typeof r.id === 'string' && r.id && col && r.cells?.[col.key] != null);
    if (row && col) drilldown = { row: row.id!, col: col.key };
  } catch {
    drilldown = null;
  }
  const audit = await rows<{ id: string; entity_type: string; action: string; v: string }>(
    `select id::text as id, entity_type, action::text as action, coalesce(old_values::text, '') || ' ' || coalesce(new_values::text, '') as v
       from audit_logs where company_id = '${company}' order by created_at, id`,
  );
  const auditWithSecrets = audit
    .filter((a) => findSecrets(a.v).length > 0)
    .map((a, i) => ({ id: a.id, label: `${a.entity_type} ${a.action} ${i + 1}` }));
  const src: CaseSources = {
    fx,
    table,
    drilldown,
    attachment: att ? { entityType: att.entity_type, entityId: att.entity_id } : null,
    salesOrderLineId: line?.id ?? null,
    auditRows: audit.length,
    auditWithSecrets,
  };

  return (op) => {
    const query = QUERY_OF[op.id]?.(src) ?? {};
    const body = BODY_OF[op.id]?.(src);
    const input = (params: Record<string, string> = {}, extra: Record<string, string> = {}): OperationInput => {
      const q = { ...query, ...extra };
      return {
        ...(Object.keys(params).length ? { params } : {}),
        ...(Object.keys(q).length ? { query: q } : {}),
        ...(body !== undefined ? { body } : {}),
      };
    };
    if (op.params.length === 0) {
      const variants = (VARIANTS_OF[op.id]?.(src) ?? []).map((v) => {
        const plain = input({}, v.query ?? {});
        return { label: `${op.id} ${v.label}`, input: v.body !== undefined ? { ...plain, body: v.body } : plain };
      });
      return [{ label: op.id, input: input() }, ...variants];
    }
    if (op.id === 'reports.std.get') {
      return keys.reportKeys.map((report) => ({
        label: `${op.id} ${report}`,
        input: input({ report }, { ...WIDE_RANGE, ...(REPORT_QUERY_OF[report]?.(src) ?? {}) }),
      }));
    }
    if (op.id === 'reports.drilldown.get') {
      // One amount of the Profit & Loss.
      if (!src.drilldown) return null;
      return [{ label: `${op.id} profit-loss`, input: input({ report: 'profit-loss' }, { ...WIDE_RANGE, ...src.drilldown }) }];
    }
    if (op.id === 'lists.get') return keys.listKeys.map((list) => ({ label: `${op.id} ${list}`, input: input({ list }) }));
    if (op.id === 'type-lists.get') return ['customer', 'vendor'].map((kind) => ({ label: `${op.id} ${kind}`, input: input({ kind }) }));
    if (op.id === 'registers.get') return [{ label: op.id, input: input({ accountId: fx.ids.checking }) }];
    if (op.id === 'sales-forms.pdf') {
      return table.invoices ? [{ label: `${op.id} invoice`, input: input({ kind: 'invoice', id: table.invoices }) }] : null;
    }
    if (op.params.length === 1 && op.params[0] === 'id') {
      const found = SEEDED_ID[op.id] ? fx.ids[SEEDED_ID[op.id]] : TABLE_OF[op.id] ? table[TABLE_OF[op.id]] : undefined;
      if (!found) return null;
      const more = (MORE_IDS_OF[op.id] ?? []).filter((k) => fx.ids[k]).map((k) => ({ label: `${op.id} ${k}`, input: input({ id: fx.ids[k] }) }));
      // Every audit row that holds a protected value (a new vendor's tax ID, an employee's SSN …).
      const rowsWithSecrets = op.id === 'audit-trail.get' ? src.auditWithSecrets.map((a) => ({ label: `${op.id} ${a.label}`, input: input({ id: a.id }) })) : [];
      return [{ label: op.id, input: input({ id: found }) }, ...more, ...rowsWithSecrets];
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// The agent the tests read as
// ---------------------------------------------------------------------------

export interface ReadsAgent {
  /** The agent's own context, as lib/agentContext.ts builds it: the read-only handle. */
  base: ServiceContext;
  /** The bridge's actor: the agent on its own policy (no approval, no reveal). */
  actor: BridgeActor;
  /** The ceiling of its roles (agent limits applied). */
  ceiling: EffectiveAccess;
}

/**
 * An agent whose role is Admin: every area, both View flags (full SSNs, full account numbers)
 * held by the role. The bridge switches the flags off for any run without an approved reveal.
 */
export async function makeReadsAgent(db: DB, fx: ReadsCompany, name = 'Reads Agent'): Promise<ReadsAgent> {
  const admin: ServiceContext = { ...fx.ctx, role: 'owner', access: fullAccess() };
  const made = await createAgent(admin, { name, roleKeys: ['admin'], preset: 'trusted_bookkeeper' });
  const ceiling = await agentAccess(db, { companyId: fx.ctx.companyId, roleKeys: ['admin'] });
  const base: ServiceContext = {
    db: readOnlyDb(db),
    companyId: fx.ctx.companyId,
    userId: null,
    role: 'viewer',
    closingDateOverride: false,
    access: ceiling,
    agent: { id: made.agent.id, name, mode: 'post', onBehalfOf: fx.ctx.userId },
    readOnly: true,
  };
  const actor: BridgeActor = {
    agent: { id: made.agent.id, name, preset: 'trusted_bookkeeper', onBehalfOf: fx.ctx.userId },
    access: ceiling,
    role: 'admin',
    userId: null,
    approval: { approvedBy: null, requestId: null, grantId: null },
    reveal: false,
    secrets: {},
    folders: [],
    atHost: true,
  };
  return { base, actor, ceiling };
}

// ---------------------------------------------------------------------------
// What an agent sees of one answer, as text to scan
// ---------------------------------------------------------------------------

export interface AnswerText {
  /** Where each piece came from ("answer", "error", "file report.csv") and its text. */
  parts: Array<{ where: string; text: string }>;
  /** A staged file whose content could not be read as text, with why. */
  unscanned: string | null;
}

const TEXT_TYPE = /^(text\/|application\/(json|xml|csv|x-ndjson)|[^;]*\+(json|xml))/i;

/**
 * Everything of a bridge answer that reaches the agent: the JSON answer, the error, the warnings,
 * the preview, and the staged file (text and CSV as they are, a PDF's text layer via pdf.js, the
 * XML parts of an .xlsx or .zip).
 */
export async function answerText(owner: FileOwner, r: BridgeResult): Promise<AnswerText> {
  const parts: AnswerText['parts'] = [];
  const json = (where: string, v: unknown) => {
    if (v !== null && v !== undefined) parts.push({ where, text: JSON.stringify(v) });
  };
  json('answer', r.result);
  json('error', r.error);
  if (r.warnings.length) json('warnings', r.warnings);
  json('preview', r.preview);
  let unscanned: string | null = null;
  if (r.file) {
    json('file info', r.file);
    const staged = await readStagedFile(owner, r.file.fileId);
    const where = `file ${r.file.name} (${r.file.type})`;
    if (!staged) unscanned = `${where}: the staged file could not be read back`;
    else {
      const bytes = staged.bytes;
      const type = r.file.type.toLowerCase();
      if (TEXT_TYPE.test(type) || /\.(csv|txt|xml|json|iif|qbo|ofx)$/i.test(r.file.name)) {
        parts.push({ where, text: Buffer.from(bytes).toString('utf8') });
      } else if (type.includes('pdf')) {
        try {
          const doc = await readPdfDocument(bytes, { maxPages: 50, maxScannedPages: 0 });
          parts.push({ where, text: doc.lines.map((l) => l.text).join('\n') });
          if (doc.pages > 50) unscanned = `${where}: only the first 50 of ${doc.pages} pages were read`;
        } catch (err) {
          unscanned = `${where}: pdf.js could not read it (${err instanceof Error ? err.message : String(err)})`;
        }
      } else if (/zip|spreadsheetml|excel/.test(type)) {
        try {
          const zip = new AdmZip(Buffer.from(bytes));
          for (const e of zip.getEntries()) {
            if (/\.(xml|rels|csv|txt|json)$/i.test(e.entryName)) parts.push({ where: `${where} ${e.entryName}`, text: e.getData().toString('utf8') });
            else if (/\.pdf$/i.test(e.entryName)) {
              const doc = await readPdfDocument(new Uint8Array(e.getData()), { maxPages: 50, maxScannedPages: 0 });
              parts.push({ where: `${where} ${e.entryName}`, text: doc.lines.map((l) => l.text).join('\n') });
            } else if (!e.isDirectory) unscanned = `${where}: ${e.entryName} inside it is not text, XML or PDF`;
          }
        } catch (err) {
          unscanned = `${where}: could not be unzipped (${err instanceof Error ? err.message : String(err)})`;
        }
      } else {
        unscanned = `${where}: not a text, PDF or zip file`;
      }
    }
  }
  return { parts, unscanned };
}
