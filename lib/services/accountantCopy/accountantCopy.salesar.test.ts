/**
 * Accountant's Copy (PARITY I1) carries the sales-form list fields added by team salesar:
 *  - each line's Sales Tax Code (B9): a "Tax" stated on a "Non" item stays taxed on the client;
 *  - the Customer Message (B8) and the Payment Method list entry (B7);
 *  - a credit memo's class and job, on the header and on each line.
 * Without them the client's import re-derived the code from the item (a different tax than the
 * accountant's file), kept the old message / payment method, and gave every credit memo line the
 * header's class and job.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, items, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createCustomer } from '../customers';
import { createInvoice, getInvoice, updateInvoice } from '../invoices';
import { createCreditMemo, getCreditMemo, updateCreditMemo } from '../creditMemos';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt } from '../salesReceipts';
import { createEstimate, getEstimate, updateEstimate } from '../estimates';
import { createTaxRate } from '../salesTax';
import { createJob } from '../jobs';
import { createClass } from '../dimensions';
import { createEntry, listEntries } from '../lists/simpleLists';
import { createAccountantCopy, importChangesFile } from './client';
import { exportChangesFile, openAccountantCopyFile } from './accountant';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-salesar');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const DIVIDING = '2026-03-31';

let db: DB;
let ctx: ServiceContext;
let actx: ServiceContext;
const acct: Record<string, string> = {};
const R: Record<string, string> = {};

const invoiceBody = (rate: string, messageId: string) =>
  ({
    customerId: R.cust,
    date: d('2026-02-01'),
    refNumber: 'I-1',
    taxRateId: R.rate,
    customerMessageId: messageId,
    lines: [{ itemId: R.nonItem, quantity: 1, rate, salesTaxCodeId: R.tax }],
  }) as never;
const memoBody = (memo: string) =>
  ({
    customerId: R.cust,
    date: d('2026-02-02'),
    taxRateId: null,
    classId: R.cls,
    jobId: R.job,
    memo,
    lines: [{ accountId: acct['4000'], quantity: 1, rate: '20.00', taxable: false, classId: R.cls2, jobId: R.job2 }],
  }) as never;
const receiptBody = (paymentMethodId: string) =>
  ({
    customerId: R.cust,
    date: d('2026-02-03'),
    taxRateId: R.rate,
    depositAccountId: acct['1000'],
    paymentMethodId,
    lines: [{ itemId: R.nonItem, quantity: 1, rate: '50.00', salesTaxCodeId: R.tax }],
  }) as never;
const estimateBody = (rate: string) =>
  ({ customerId: R.cust, date: d('2026-02-04'), taxRateId: R.rate, lines: [{ itemId: R.nonItem, quantity: 1, rate, salesTaxCodeId: R.tax }] }) as never;

describe("Accountant's Copy — sales tax codes, messages, payment methods and credit memo class / job travel", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'acct-salesar@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Salesar Copy Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    const codes = await listEntries(ctx, 'sales-tax-codes');
    R.tax = String(codes.find((c) => c.code === 'Tax')!.id);
    R.non = String(codes.find((c) => c.code === 'Non')!.id);
    R.rate = (await createTaxRate(ctx, { name: 'State', rate: '0.10' })).id;
    const methods = await listEntries(ctx, 'payment-methods');
    R.visa = String(methods.find((m) => m.name === 'Visa')!.id);
    R.echeck = String(methods.find((m) => m.name === 'E-Check')!.id);
    R.m1 = (await createEntry(ctx, 'customer-messages', { message: 'Thank you' })).id;
    R.m2 = (await createEntry(ctx, 'customer-messages', { message: 'See you soon' })).id;
    R.cust = (await createCustomer(ctx, { displayName: 'Acme' })).id;
    R.job = (await createJob(ctx, { customerId: R.cust, name: 'Kitchen' })).id;
    R.job2 = (await createJob(ctx, { customerId: R.cust, name: 'Garage' })).id;
    R.cls = (await createClass(ctx, { name: 'East' } as never)).id;
    R.cls2 = (await createClass(ctx, { name: 'West' } as never)).id;
    const [it] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'Labor (Non)', type: 'service' as never, salesPrice: '100.00', incomeAccountId: acct['4000'], salesTaxCodeId: R.non, taxable: false })
      .returning();
    R.nonItem = it.id;

    R.inv = (await createInvoice(ctx, invoiceBody('100.00', R.m1))).id;
    R.cm = (await createCreditMemo(ctx, memoBody('client'))).id;
    R.sr = (await createSalesReceipt(ctx, receiptBody(R.visa))).id;
    R.est = (await createEstimate(ctx, estimateBody('100.00'))).id;
  }, 120_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("the accountant's edits arrive on the client with the same tax, message, payment method and class / job", async () => {
    expect((await getInvoice(ctx, R.inv)).taxAmount).toBe('10.00');
    const created = await createAccountantCopy(ctx, { dividingDate: DIVIDING, dataDir: CLIENT_DIR });
    await openAccountantCopyFile(created.buffer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: ctx.companyId, userId: ctx.userId };

    await updateInvoice(actx, R.inv, invoiceBody('200.00', R.m2));
    await updateCreditMemo(actx, R.cm, memoBody('accountant'));
    await updateSalesReceipt(actx, R.sr, receiptBody(R.echeck));
    await updateEstimate(actx, R.est, estimateBody('300.00'));
    expect((await getInvoice(actx, R.inv)).taxAmount).toBe('20.00');

    const changes = (await exportChangesFile(actx, {})).buffer;
    const res = await importChangesFile(ctx, changes);
    expect(res.trialBalance.balanced).toBe(true);

    const inv = await getInvoice(ctx, R.inv);
    expect([inv.taxAmount, inv.total, inv.customerMessageId]).toEqual(['20.00', '220.00', R.m2]);
    expect(inv.lines.map((l) => [l.taxable, l.salesTaxCodeId])).toEqual([[true, R.tax]]);

    const cm = await getCreditMemo(ctx, R.cm);
    expect([cm.memo, cm.classId, cm.jobId]).toEqual(['accountant', R.cls, R.job]);
    expect(cm.lines.map((l) => [l.classId, l.jobId])).toEqual([[R.cls2, R.job2]]);

    const sr = await getSalesReceipt(ctx, R.sr);
    expect([sr.paymentMethodId, sr.method, sr.taxAmount]).toEqual([R.echeck, 'ach', '5.00']);
    expect(sr.lines[0].salesTaxCodeId).toBe(R.tax);

    const est = await getEstimate(ctx, R.est);
    expect([est.taxAmount, est.lines[0].salesTaxCodeId]).toEqual(['30.00', R.tax]);
  }, 120_000);
});
