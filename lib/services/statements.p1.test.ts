/**
 * p1/salesforms: open-item statements rebuilt AS OF the statement date (later payments don't
 * reduce them; open credits and General Journal items are listed; total == A/R aging), and
 * foreign-currency balance-forward statements in home currency with exchange-rate adjustment
 * lines (closing == home A/R in the GL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createInvoice } from './invoices';
import { createCreditMemo } from './creditMemos';
import { receivePayment, applyPayment } from './payments';
import { createManualEntry } from './journal';
import { arAging } from './reportsExtra';
import { customerArLedgerBalance, customerStatement, openItemStatement } from './statements';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-statements');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let custId: string;
let fxCustId: string;
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function agingTotal(customerId: string, asOf: Date) {
  const rep = await arAging(ctx, asOf);
  return rep.rows.find((r) => r.id === customerId)?.total ?? '0.00';
}

describe('p1/salesforms — statements', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1st@t.local', name: 'S', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'P1 Stmt Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    custId = (await db.insert(customers).values({ companyId: c.id, displayName: 'Open Item Co' }).returning())[0].id;
    fxCustId = (await db.insert(customers).values({ companyId: c.id, displayName: 'Euro GmbH' }).returning())[0].id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('open-item statement: as of a past date, lists open credits + GJ items and ties to A/R aging', async () => {
    const inv = await createInvoice(ctx, {
      customerId: custId,
      date: D('2026-03-01'),
      dueDate: D('2026-03-31'),
      refNumber: 'INV-500',
      lines: [{ description: 'Work', quantity: 1, rate: 500, accountId: acct['4000'] }],
    });
    // GJ charge named for the customer.
    await createManualEntry(ctx, {
      date: D('2026-03-05'),
      description: 'Rebill freight',
      lines: [
        { accountId: acct['1200'], debit: '30.00', entityType: 'customer', entityId: custId },
        { accountId: acct['4000'], credit: '30.00' },
      ],
    });
    // Unapplied credit memo and unapplied payment (open credits).
    await createCreditMemo(ctx, {
      customerId: custId,
      date: D('2026-03-10'),
      refNumber: 'CM-7',
      taxRateId: null,
      lines: [{ description: 'Return', quantity: 1, rate: 50, accountId: acct['4000'] }],
    });
    await receivePayment(ctx, {
      customerId: custId,
      date: D('2026-03-20'),
      method: 'check',
      reference: '1001',
      amount: '80.00',
      applications: [],
    });
    // A payment AFTER the statement date that pays 200 of the invoice.
    await receivePayment(ctx, {
      customerId: custId,
      date: D('2026-04-15'),
      method: 'check',
      reference: '1002',
      amount: '200.00',
      applications: [{ invoiceId: inv.id, amountApplied: '200.00' }],
    });

    const asOf = D('2026-04-01');
    const st = await openItemStatement(ctx, custId, asOf);
    const byType = (t: string) => st.lines.filter((l) => l.type === t);
    expect(byType('invoice')).toHaveLength(1);
    expect(byType('invoice')[0]).toMatchObject({ refNumber: 'INV-500', balanceDue: '500.00', amountPaid: '0.00', label: 'Invoice INV-500' });
    expect(byType('credit_memo')[0]).toMatchObject({ refNumber: 'CM-7', balanceDue: '-50.00' });
    expect(byType('payment')[0]).toMatchObject({ refNumber: '1001', balanceDue: '-80.00' });
    expect(byType('general_journal')[0].balanceDue).toBe('30.00');
    expect(st.totalDue).toBe('400.00');
    expect(st.totalDue).toBe(await agingTotal(custId, asOf));

    // After the later payment: invoice open 300.
    const later = await openItemStatement(ctx, custId, D('2026-05-01'));
    expect(later.lines.find((l) => l.type === 'invoice')!.balanceDue).toBe('300.00');
    expect(later.totalDue).toBe('200.00');
    expect(later.totalDue).toBe(await agingTotal(custId, D('2026-05-01')));
    // ...and today it ties to the GL too.
    expect(later.totalDue).toBe(await customerArLedgerBalance(ctx, custId));
  });

  it('foreign-currency balance-forward statement is in home currency and ties to home A/R', async () => {
    const inv = await createInvoice(ctx, {
      customerId: fxCustId,
      date: D('2026-03-01'),
      currency: 'EUR',
      exchangeRate: '1.10',
      taxRateId: null,
      lines: [{ description: 'EUR work', quantity: 1, rate: 200, accountId: acct['4000'] }],
    });
    // Unapplied EUR payment at 1.20, then applied to the invoice booked at 1.10 → FX adjustment.
    const { payment } = await receivePayment(ctx, {
      customerId: fxCustId,
      date: D('2026-03-05'),
      method: 'bank_transfer',
      amount: '150.00',
      depositAccountId: acct['1000'],
      applications: [],
      currency: 'EUR',
      exchangeRate: '1.200000',
    });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '150.00' }] });

    const st = await customerStatement(ctx, fxCustId, {});
    expect(st.homeCurrency).toBe(true);
    const inv1 = st.lines.find((l) => l.type === 'invoice')!;
    expect(inv1.amount).toBe('220.00'); // 200 EUR × 1.10
    const pay = st.lines.find((l) => l.type === 'payment')!;
    expect(pay.amount).toBe('180.00'); // 150 EUR × 1.20 credited to A/R
    const fx = st.lines.filter((l) => l.type === 'exchange_adjustment');
    expect(fx).toHaveLength(1);
    expect(fx[0].amount).toBe('15.00'); // A/R debit plug: 150 × (1.20 − 1.10)
    const gl = await customerArLedgerBalance(ctx, fxCustId);
    expect(st.closingBalance).toBe(gl);
    expect(gl).toBe('55.00'); // 50 EUR still open × 1.10

    // With a date range: opening balance from the GL, still ties.
    const ranged = await customerStatement(ctx, fxCustId, { from: D('2026-03-04'), to: D('2026-12-31') });
    expect(ranged.openingBalance).toBe('220.00');
    expect(ranged.closingBalance).toBe(gl);
  });
});
