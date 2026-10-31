/**
 * Feature round (team purchbank): purchases and banking review leftovers. Each test failed on the
 * code before its fix (or pins down a leftover that was already fixed on the base).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  billPayments,
  depositLines,
  itemReceiptLines,
  journalEntries,
  journalEntryLines,
  purchaseOrders,
  taxAgencies,
  users,
  vendors,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount, updateAccount } from './accounts';
import { createExpense, updateExpense } from './expenses';
import { createBill, getBill, updateBill } from './bills';
import { createVendorCredit, updateVendorCredit } from './vendorCredits';
import { createDeposit } from './deposits';
import { createTransfer } from './transfers';
import { payBills, updateBillPayment } from './billPayments';
import { vendor1099Report } from './statements';
import { payCreditCard, payPayrollLiabilities, paySalesTax } from './liabilityPayments';
import { createBankAccount } from './bankAccounts';
import {
  addStatementAdjustments,
  completeReconciliation,
  getReconcileInfo,
  payCreditCardBalance,
  startReconciliation,
} from './reconcile';
import { createTaxAgency, createTaxRate } from './salesTax';
import { createSalesTaxAdjustment } from './accountant/salesTaxTools';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createItem } from './items';
import { createItemReceipt, updateItemReceipt } from './itemReceipts';
import { enterBillForReceivedItems } from './receiving';
import { createPurchaseOrder, updateStatus, convertToBill } from './purchaseOrders';
import { convertToBill as convertReceiptToBill } from './itemReceipts';
import { postJournalEntry } from './posting';
import { txnTypeOf } from './reportEngine';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-purchbank-leftovers');
let db: DB;
let ctx: ServiceContext;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function expectCode(p: Promise<unknown>, code: string, msg?: RegExp) {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the call to fail').toBeInstanceOf(ServiceError);
  expect((caught as ServiceError).code).toBe(code);
  if (msg) expect((caught as Error).message).toMatch(msg);
}

async function vendor(name = `Vendor ${seq}`, extra: Record<string, unknown> = {}) {
  const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: name, ...extra }).returning();
  return v;
}

async function gl(code: string): Promise<string> {
  const row = (await trialBalance(ctx, d('2099-12-31'))).rows.find((r) => r.code === code);
  return row ? Money.sub(row.debit, row.credit).toFixed(2) : '0.00';
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'purchbank-left@test.local', name: 'PB', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Purchbank leftovers ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Purchase forms: Undeposited Funds / Inventory Asset on an account line (no item)
// ---------------------------------------------------------------------------

describe('purchase account lines refuse Undeposited Funds and Inventory Asset', () => {
  it('Write Checks: a line on 1050 or 1300 without an item is refused', async () => {
    for (const code of ['1050', '1300']) {
      await expectCode(
        createExpense(ctx, {
          payeeName: 'Cash',
          date: d('2026-03-01'),
          method: 'check',
          paymentAccountId: acct['1000'],
          lines: [{ accountId: acct[code], amount: '50.00' }],
        }),
        'VALIDATION',
        /Undeposited Funds|inventory asset/,
      );
    }
    expect(await gl('1050')).toBe('0.00');
    expect(await gl('1300')).toBe('0.00');
  });

  it('Enter Bills and vendor credits: an account line on 1300 / 1050 is refused', async () => {
    const v = await vendor();
    await expectCode(
      createBill(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['1300'], amount: '40.00' }] }),
      'VALIDATION',
      /inventory asset/,
    );
    await expectCode(
      createVendorCredit(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['1050'], amount: '40.00' }] } as never),
      'VALIDATION',
      /Undeposited Funds/,
    );
  });
});

// ---------------------------------------------------------------------------
// Ledger-neutral edits keep the entry: its line memos follow the new descriptions
// ---------------------------------------------------------------------------

describe('ledger-neutral edits sync the kept entry line memos', () => {
  async function memos(entryId: string) {
    return (await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId)))
      .map((l) => l.memo)
      .sort();
  }

  it('Write Checks: a description-only edit changes the line memo, same entry', async () => {
    const chk = await createExpense(ctx, {
      payeeName: 'Office Depot',
      date: d('2026-03-02'),
      method: 'check',
      reference: '501',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '25.00', description: 'Paper' }],
    });
    const edited = await updateExpense(ctx, chk.id, {
      payeeName: 'Office Depot',
      date: d('2026-03-02'),
      method: 'check',
      reference: '501',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '25.00', description: 'Printer paper' }],
    });
    expect(edited.postedEntryId).toBe(chk.postedEntryId);
    expect(await memos(chk.postedEntryId!)).toContain('Printer paper');
    expect(await memos(chk.postedEntryId!)).not.toContain('Paper');
  });

  it('Enter Bills: a description-only edit changes the line memo, same entry', async () => {
    const v = await vendor();
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-03-02'), lines: [{ accountId: acct['6400'], amount: '900.00', description: 'March rent' }] });
    const edited = await updateBill(ctx, bill.id, {
      vendorId: v.id,
      date: d('2026-03-02'),
      lines: [{ accountId: acct['6400'], amount: '900.00', description: 'Rent for March' }],
    });
    expect(edited.postedEntryId).toBe(bill.postedEntryId);
    expect(await memos(bill.postedEntryId!)).toContain('Rent for March');
  });

  it('vendor credits: a description-only edit changes the line memo, same entry', async () => {
    const v = await vendor();
    const vc = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-03-02'), lines: [{ accountId: acct['6300'], amount: '10.00', description: 'Returned toner' }] } as never);
    const edited = await updateVendorCredit(ctx, vc.id, {
      vendorId: v.id,
      date: d('2026-03-02'),
      lines: [{ accountId: acct['6300'], amount: '10.00', description: 'Toner returned (damaged)' }],
    } as never);
    expect(edited.postedEntryId).toBe(vc.postedEntryId);
    expect(await memos(vc.postedEntryId!)).toContain('Toner returned (damaged)');
  });

  it('bill payments: a check-number-only edit changes the bank line memo, same entry', async () => {
    const v = await vendor();
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-03-02'), lines: [{ accountId: acct['6300'], amount: '60.00' }] });
    const input = {
      vendorId: v.id,
      date: d('2026-03-05'),
      method: 'check' as const,
      reference: '701',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '60.00' }],
    };
    const bp = await payBills(ctx, input);
    expect(await memos(bp.postedEntryId!)).toContain('Bill payment — ref: 701');
    const edited = await updateBillPayment(ctx, bp.id, { ...input, reference: '702' });
    expect(edited.postedEntryId).toBe(bp.postedEntryId);
    const after = await memos(bp.postedEntryId!);
    expect(after).toContain('Bill payment — ref: 702');
    expect(after).not.toContain('Bill payment — ref: 701');
  });

  it('item receipts: a reference / description edit changes the line memos, same entry', async () => {
    const v = await vendor();
    const item = await createItem(ctx, {
      name: `Memo item ${seq}`,
      type: 'inventory',
      incomeAccountId: acct['4000'],
      expenseAccountId: acct['5000'],
      assetAccountId: acct['1300'],
    } as never);
    const r = await createItemReceipt(ctx, {
      vendorId: v.id,
      date: d('2026-03-02'),
      reference: 'PS-1',
      lines: [{ itemId: item.id, quantity: 2, unitCost: '5.00', description: 'Blue widgets' }],
    } as never);
    const edited = await updateItemReceipt(ctx, r.id, {
      vendorId: v.id,
      date: d('2026-03-02'),
      reference: 'PS-2',
      lines: [{ itemId: item.id, quantity: 2, unitCost: '5.00', description: 'Blue widgets (boxed)' }],
    } as never);
    expect(edited.postedEntryId).toBe(r.postedEntryId);
    const after = await memos(r.postedEntryId!);
    expect(after).toContain('Blue widgets (boxed)');
    expect(after).not.toContain('Blue widgets');
    expect(after.some((m) => m?.startsWith('Item receipt PS-2'))).toBe(true);
    expect(after.some((m) => m?.startsWith('Item receipt PS-1'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Make Deposits and Transfer Funds account rules; Received From
// ---------------------------------------------------------------------------

describe('Make Deposits: Deposit To and Received From', () => {
  it('refuses A/R, inventory, fixed asset and non-posting accounts as Deposit To', async () => {
    const np = await createAccount(ctx, { code: '9990', name: 'Estimates', type: 'asset' as never, subtype: 'non_posting' }).catch(() => null);
    for (const id of [acct['1200'], acct['1300'], acct['1500'], np?.id].filter(Boolean) as string[]) {
      await expectCode(
        createDeposit(ctx, { depositAccountId: id, date: d('2026-03-03'), extraLines: [{ accountId: acct['3000'], amount: '100.00' }] }),
        'VALIDATION',
      );
    }
    // A bank account and an other current asset account are fine.
    const oca = await createAccount(ctx, { code: '1400', name: 'Petty cash box', type: 'asset' as never, subtype: 'other_current_asset' });
    const dep = await createDeposit(ctx, { depositAccountId: oca.id, date: d('2026-03-03'), extraLines: [{ accountId: acct['3000'], amount: '100.00' }] });
    expect(dep.total).toBe('100.00');
  });

  it('keeps the Received From name on the deposit line and posts it as the line name', async () => {
    const v = await vendor('Refunding vendor');
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: d('2026-03-03'),
      extraLines: [{ accountId: acct['6300'], amount: '15.00', description: 'Refund', entityType: 'vendor', entityId: v.id }],
    });
    const [line] = await db.select().from(depositLines).where(eq(depositLines.depositId, dep.id));
    expect(line.entityType).toBe('vendor');
    expect(line.entityId).toBe(v.id);
    const [jl] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, dep.postedEntryId!), eq(journalEntryLines.accountId, acct['6300'])));
    expect(jl.entityType).toBe('vendor');
    expect(jl.entityId).toBe(v.id);
  });

  it('refuses a Received From name of another company, or a half-filled name', async () => {
    const other = await createCompany(db, { name: `Other ${seq}`, ownerId: userId });
    const [foreignVendor] = await db.insert(vendors).values({ companyId: other.id, displayName: 'Not mine' }).returning();
    await expectCode(
      createDeposit(ctx, {
        depositAccountId: acct['1000'],
        date: d('2026-03-03'),
        extraLines: [{ accountId: acct['6300'], amount: '15.00', entityType: 'vendor', entityId: foreignVendor.id }],
      }),
      'VALIDATION',
    );
    await expectCode(
      createDeposit(ctx, {
        depositAccountId: acct['1000'],
        date: d('2026-03-03'),
        extraLines: [{ accountId: acct['6300'], amount: '15.00', entityType: 'vendor' } as never],
      }),
      'VALIDATION',
    );
  });
});

describe('Transfer Funds: balance sheet accounts only', () => {
  it('refuses A/R, A/P, income and expense accounts', async () => {
    for (const code of ['1200', '2000', '4000', '6300']) {
      await expectCode(
        createTransfer(ctx, { date: d('2026-03-04'), fromAccountId: acct['1000'], toAccountId: acct[code], amount: '10.00' }),
        'VALIDATION',
      );
    }
    // Bank to credit card or equity is a transfer.
    const t = await createTransfer(ctx, { date: d('2026-03-04'), fromAccountId: acct['1000'], toAccountId: acct['2100'], amount: '10.00' });
    expect(t.postedEntryId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 1099s: voided bill payments never count
// ---------------------------------------------------------------------------

describe('vendor1099Report', () => {
  it('skips a voided bill payment even when its applications are still there (as the worksheet does)', async () => {
    const v = await vendor('Contractor', { is1099: true, taxId: '12-3456789' });
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ accountId: acct['6000'], amount: '3000.00' }] });
    const res = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-02-10'),
      method: 'check',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '3000.00' }],
    });
    const paymentId = (res as { payment?: { id: string }; id?: string }).payment?.id ?? (res as { id: string }).id;
    expect((await vendor1099Report(ctx, { year: 2026 })).find((r) => r.vendorId === v.id)?.total).toBe('3000.00');
    // A void that keeps its applications (a future void flavour, or data restored that way).
    await db.update(billPayments).set({ voidedAt: new Date() }).where(eq(billPayments.id, paymentId));
    expect((await vendor1099Report(ctx, { year: 2026 })).find((r) => r.vendorId === v.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Credit card payments; loans are not credit cards
// ---------------------------------------------------------------------------

describe('Pay Credit Card and reconciled loans', () => {
  it('Pay Bills: a credit card payment drawn on a bank account is refused (the 1099 card exclusion keys on it)', async () => {
    const v = await vendor('Card pay vendor');
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '40.00' }] });
    await expectCode(
      payBills(ctx, {
        vendorId: v.id,
        date: d('2026-03-05'),
        method: 'credit_card',
        paymentAccountId: acct['1000'],
        applications: [{ billId: bill.id, amountApplied: '40.00' }],
      }),
      'VALIDATION',
      /credit card account/,
    );
    // From the card itself it is fine.
    const ok = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-03-05'),
      method: 'credit_card',
      paymentAccountId: acct['2100'],
      applications: [{ billId: bill.id, amountApplied: '40.00' }],
    });
    expect(ok.method).toBe('credit_card');
  });

  it('payCreditCard refuses a pay-from account that is not a bank account', async () => {
    await expectCode(
      payCreditCard(ctx, { creditCardAccountId: acct['2100'], paymentAccountId: acct['6300'], amount: '50.00', date: d('2026-03-05') }),
      'VALIDATION',
      /bank account/,
    );
  });

  it('payCreditCard refuses a liability that is not a credit card (a loan)', async () => {
    const loan = await createAccount(ctx, { code: '2700', name: 'Truck Loan', type: 'liability' as never, subtype: 'long_term_liability' });
    await expectCode(
      payCreditCard(ctx, { creditCardAccountId: loan.id, paymentAccountId: acct['1000'], amount: '50.00', date: d('2026-03-05') }),
      'VALIDATION',
      /credit card/i,
    );
  });

  it('a reconciled loan is not a credit card: no "Write a check for the balance"', async () => {
    const loan = await createAccount(ctx, { code: '2700', name: 'Truck Loan', type: 'liability' as never, subtype: 'long_term_liability' });
    await postJournalEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Loan proceeds',
      lines: [
        { accountId: acct['1000'], debit: '20000.00' },
        { accountId: loan.id, credit: '20000.00' },
      ],
    });
    const link = await createBankAccount(ctx, { accountId: loan.id, bankName: 'Lender', accountNumber: '9988' });
    const info = await getReconcileInfo(ctx, link.id);
    expect(info.isCreditCard).toBe(false);
    expect(info.isLiability).toBe(true);
    const recon = await startReconciliation(ctx, { bankAccountId: link.id, statementDate: d('2026-01-31'), statementBalance: '0.00' });
    await completeReconciliation(ctx, recon.id);
    await expectCode(payCreditCardBalance(ctx, recon.id, { paymentAccountId: acct['1000'], amount: '20000.00' }), 'VALIDATION', /credit card/i);
    expect(await gl('2700')).toBe('-20000.00');
  });

  it('a credit card link is still a credit card', async () => {
    const link = await createBankAccount(ctx, { accountId: acct['2100'], bankName: 'Card', accountNumber: '4444' });
    const info = await getReconcileInfo(ctx, link.id);
    expect(info.isCreditCard).toBe(true);
    expect(info.isLiability).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reconcile service charge / interest earned: their own source refs and report types
// ---------------------------------------------------------------------------

describe('reconcile statement adjustments', () => {
  it('posts the service charge and the interest with distinct sources that reports show as Check / Deposit', async () => {
    const link = await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'Bank', accountNumber: '1234' });
    await postJournalEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Opening',
      lines: [
        { accountId: acct['1000'], debit: '1000.00' },
        { accountId: acct['3000'], credit: '1000.00' },
      ],
    });
    const recon = await startReconciliation(ctx, { bankAccountId: link.id, statementDate: d('2026-01-31'), statementBalance: '997.00' });
    await addStatementAdjustments(ctx, recon.id, {
      serviceCharge: { amount: '5.00', accountId: acct['6100'] },
      interestEarned: { amount: '2.00', accountId: acct['4900'] },
    });
    const entries = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')));
    const charge = entries.find((e) => e.description === 'Bank service charge')!;
    const interest = entries.find((e) => e.description === 'Interest earned')!;
    expect(charge.sourceRef).not.toBe(interest.sourceRef);
    expect(txnTypeOf(charge.sourceRef)).toBe('check');
    expect(txnTypeOf(interest.sourceRef)).toBe('deposit');
  });
});

// ---------------------------------------------------------------------------
// Chart of accounts: list-kept subtypes can't be switched once used
// ---------------------------------------------------------------------------

describe('updateAccount subtype changes with history', () => {
  it('refuses turning a used account into (or out of) Undeposited Funds or Inventory', async () => {
    const savings2 = await createAccount(ctx, { code: '1020', name: 'Savings 2', type: 'asset' as never, subtype: 'savings' });
    await postJournalEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Seed',
      lines: [
        { accountId: savings2.id, debit: '100.00' },
        { accountId: acct['3000'], credit: '100.00' },
      ],
    });
    await expectCode(updateAccount(ctx, savings2.id, { subtype: 'undeposited_funds' }), 'CONFLICT');
    await expectCode(updateAccount(ctx, savings2.id, { subtype: 'inventory' }), 'CONFLICT');
    // 1050 has history once a payment sits in it; out of Undeposited Funds is refused too.
    await postJournalEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Seed UF',
      lines: [
        { accountId: acct['1050'], debit: '10.00' },
        { accountId: acct['3000'], credit: '10.00' },
      ],
    });
    await expectCode(updateAccount(ctx, acct['1050'], { subtype: 'checking' }), 'CONFLICT');
    // Unused accounts may still change.
    const fresh = await createAccount(ctx, { code: '1030', name: 'Fresh', type: 'asset' as never, subtype: 'savings' });
    const changed = await updateAccount(ctx, fresh.id, { subtype: 'other_current_asset' });
    expect(changed.subtype).toBe('other_current_asset');
  });
});

// ---------------------------------------------------------------------------
// Pay Liabilities, Pay Sales Tax (already fixed on the base — pinned here)
// ---------------------------------------------------------------------------

describe('liability payments', () => {
  it('a text amount is a plain VALIDATION error for itemized and lump-sum payments', async () => {
    await expectCode(
      payPayrollLiabilities(ctx, { date: d('2026-03-01'), paymentAccountId: acct['1000'], amount: '12abc' } as never),
      'VALIDATION',
    );
    await expectCode(
      payPayrollLiabilities(ctx, { date: d('2026-03-01'), paymentAccountId: acct['1000'], items: [{ name: 'Federal', amount: 'ten' }] } as never),
      'VALIDATION',
    );
  });

  it('Pay Sales Tax and a sales tax adjustment debit 2200 (where sales put the tax), not the agency account', async () => {
    const own = await createAccount(ctx, { code: '2210', name: 'County Tax Payable', type: 'liability' as never, subtype: 'other_current_liability' });
    const agency = await createTaxAgency(ctx, { name: 'County', liabilityAccountId: own.id });
    const rate = await createTaxRate(ctx, { name: 'County 5%', rate: '0.05', agencyId: agency.id });
    const cust = await createCustomer(ctx, { displayName: 'Taxed customer' } as never);
    await createInvoice(ctx, { customerId: cust.id, date: d('2026-02-01'), taxRateId: rate.id, lines: [{ description: 'Goods', quantity: 1, rate: '100.00' }] } as never);
    expect(await gl('2200')).toBe('-5.00');
    await paySalesTax(ctx, { agencyId: agency.id, amount: '4.00', paymentAccountId: acct['1000'], date: d('2026-02-20') });
    await createSalesTaxAdjustment(ctx, {
      date: d('2026-02-21'),
      agencyId: agency.id,
      amount: '1.00',
      direction: 'reduce',
      adjustmentAccountId: acct['4900'],
      reason: 'discount',
    });
    expect(await gl('2200')).toBe('0.00');
    expect(await gl('2210')).toBe('0.00');
    expect((await db.select().from(taxAgencies).where(eq(taxAgencies.id, agency.id)))[0].liabilityAccountId).toBe(own.id);
  });
});

// ---------------------------------------------------------------------------
// Bills for received items: a memo / ref. no. edit with a negative variance line
// ---------------------------------------------------------------------------

describe('bill for received items billed below the receipt cost', () => {
  it('fixing the memo or vendor ref. no. keeps the bill (no void needed)', async () => {
    const v = await vendor('Widget supplier');
    const item = await createItem(ctx, {
      name: `Widget ${seq}`,
      type: 'inventory',
      salesPrice: '20.00',
      incomeAccountId: acct['4000'],
      expenseAccountId: acct['5000'],
      assetAccountId: acct['1300'],
    } as never);
    const r = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ itemId: item.id, quantity: 4, unitCost: '10.00' }] } as never);
    const [rl] = await db.select().from(itemReceiptLines).where(eq(itemReceiptLines.itemReceiptId, r.id));
    const res = await enterBillForReceivedItems(ctx, {
      vendorId: v.id,
      billNumber: 'INV-9',
      date: d('2026-03-05'),
      lines: [{ receiptLineId: rl.id, quantity: 4, unitCost: '9.00' }],
    });
    const before = await getBill(ctx, res.id);
    expect(before.lines.some((l) => Money.of(l.amount).isNegative())).toBe(true);
    // Re-save from the form: the saved lines as they are, a new memo and reference number.
    const edited = await updateBill(ctx, res.id, {
      vendorId: v.id,
      billNumber: 'INV-9A',
      date: d('2026-03-05'),
      memo: 'Corrected reference',
      lines: before.lines.map((l) =>
        l.itemId
          ? { itemId: l.itemId, accountId: l.accountId, quantity: l.quantity, amount: l.amount, description: l.description }
          : { accountId: l.accountId, amount: l.amount, description: l.description },
      ),
    });
    expect(edited.postedEntryId).toBe(before.postedEntryId);
    expect(edited.billNumber).toBe('INV-9A');
    expect(edited.memo).toBe('Corrected reference');
    // An amount change is still refused (void and enter it again).
    await expectCode(
      updateBill(ctx, res.id, {
        vendorId: v.id,
        date: d('2026-03-05'),
        lines: before.lines.map((l) => ({ accountId: l.accountId, amount: Money.of(l.amount).plus(1).toFixed(2), description: l.description })),
      }),
      'CONFLICT',
      /item receipts/,
    );
  });
});

// ---------------------------------------------------------------------------
// Duplicate vendor reference number on Convert to Bill / Enter Bill for Received Items
// ---------------------------------------------------------------------------

describe('duplicate vendor reference numbers on converted bills', () => {
  async function setup() {
    const v = await vendor('Dup supplier');
    await createBill(ctx, { vendorId: v.id, billNumber: 'A-100', date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '10.00' }] });
    const item = await createItem(ctx, {
      name: `Dup item ${seq}`,
      type: 'inventory',
      incomeAccountId: acct['4000'],
      expenseAccountId: acct['5000'],
      assetAccountId: acct['1300'],
    } as never);
    return { v, item };
  }

  it('Convert PO to Bill warns about a reference number the vendor already used, then accepts the confirmation', async () => {
    const { v } = await setup();
    const po = await createPurchaseOrder(ctx, { vendorId: v.id, date: d('2026-03-02'), lines: [{ accountId: acct['6300'], quantity: 1, rate: '20.00' }] });
    await expectCode(convertToBill(ctx, po.id, { billNumber: 'A-100' }), 'CONFLICT', /already has a bill/);
    const bill = await convertToBill(ctx, po.id, { billNumber: 'A-100', allowDuplicateNumber: true });
    expect(bill.billNumber).toBe('A-100');
  });

  it('item receipt Convert to Bill and Enter Bill for Received Items warn too', async () => {
    const { v, item } = await setup();
    const r1 = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-03-02'), lines: [{ itemId: item.id, quantity: 1, unitCost: '5.00' }] } as never);
    await expectCode(convertReceiptToBill(ctx, r1.id, { billNumber: 'A-100' } as never), 'CONFLICT', /already has a bill/);
    const b1 = await convertReceiptToBill(ctx, r1.id, { billNumber: 'A-100', allowDuplicateNumber: true } as never);
    expect(b1.billNumber).toBe('A-100');

    const r2 = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-03-03'), lines: [{ itemId: item.id, quantity: 1, unitCost: '5.00' }] } as never);
    const [rl] = await db.select().from(itemReceiptLines).where(eq(itemReceiptLines.itemReceiptId, r2.id));
    await expectCode(
      enterBillForReceivedItems(ctx, { vendorId: v.id, billNumber: 'a-100', date: d('2026-03-04'), lines: [{ receiptLineId: rl.id, quantity: 1, unitCost: '5.00' }] }),
      'CONFLICT',
      /already has a bill/,
    );
    const b2 = await enterBillForReceivedItems(ctx, {
      vendorId: v.id,
      billNumber: 'a-100',
      date: d('2026-03-04'),
      allowDuplicateNumber: true,
      lines: [{ receiptLineId: rl.id, quantity: 1, unitCost: '5.00' }],
    });
    expect(b2.billNumber).toBe('a-100');
  });
});

// ---------------------------------------------------------------------------
// A manually closed P.O. stays closed when a receipt edit releases quantity
// ---------------------------------------------------------------------------

describe('manually closed purchase orders', () => {
  it('editing the quantity of a receipt against a P.O. closed by hand keeps it closed', async () => {
    const v = await vendor('PO supplier');
    const item = await createItem(ctx, {
      name: `PO item ${seq}`,
      type: 'inventory',
      incomeAccountId: acct['4000'],
      expenseAccountId: acct['5000'],
      assetAccountId: acct['1300'],
    } as never);
    const po = await createPurchaseOrder(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ itemId: item.id, quantity: 10, rate: '3.00' }] });
    const r = await createItemReceipt(ctx, {
      vendorId: v.id,
      purchaseOrderId: po.id,
      date: d('2026-03-02'),
      lines: [{ itemId: item.id, quantity: 6, unitCost: '3.00' }],
    } as never);
    await updateStatus(ctx, po.id, 'closed');
    const [closed] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    expect(closed.status).toBe('closed');
    expect(closed.closedManually).toBe(true);
    await updateItemReceipt(ctx, r.id, {
      vendorId: v.id,
      purchaseOrderId: po.id,
      date: d('2026-03-02'),
      lines: [{ itemId: item.id, quantity: 4, unitCost: '3.00' }],
    } as never);
    const [after] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    expect(after.status).toBe('closed');
  });
});
