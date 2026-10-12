/**
 * Test fixture (not a test file): builds a company with many document types through the real
 * services, so backup / portable-file / condense round-trip tests exercise realistic data —
 * lists, sales + purchase documents, payments, deposits, transfers, a voided entry, classes,
 * an attachment file and the running transaction log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { accounts, attachments, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
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
import { createVendorCredit } from './vendorCredits';
import { postJournalEntry, voidJournalEntry } from './posting';

export interface RichCompany {
  ctx: ServiceContext;
  acct: Record<string, string>;
  customerId: string;
  vendorId: string;
}

/** Seed a realistic company into `db` (whose data dir is `dataDir`). */
export async function seedRichCompany(db: DB, dataDir: string, name = 'Rich Test Co'): Promise<RichCompany> {
  const [user] = await db
    .insert(users)
    .values({ email: `owner-${Date.now()}@test.local`, name: 'Owner Person', passwordHash: '$2a$10$abcdefghijklmnopqrstuv' })
    .returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const acct: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;

  const cls = await createClass(ctx, { name: 'Retail' });
  const customer = await createCustomer(ctx, {
    displayName: 'Acme "Quoted" Corp',
    email: 'ap@acme.test',
    billingAddress: { line1: '1 Main St', city: 'Springfield', state: 'IL', zip: '62701' },
  });
  const customer2 = await createCustomer(ctx, { displayName: 'Zeta Ünïcode Ltd' });
  const vendor = await createVendor(ctx, { displayName: 'Paper Supply Co', is1099: true });
  const service = await createItem(ctx, {
    name: 'Consulting',
    type: 'service',
    salesPrice: '125.50',
    incomeAccountId: acct['4100'],
  });

  await postJournalEntry(ctx, {
    date: new Date('2025-01-01'),
    description: 'Owner investment',
    lines: [
      { accountId: acct['1000'], debit: '25000.00' },
      { accountId: acct['3000'], credit: '25000.00' },
    ],
  });

  const inv1 = await createInvoice(ctx, {
    customerId: customer.id,
    date: new Date('2025-01-10'),
    dueDate: new Date('2025-02-09'),
    classId: cls.id,
    lines: [
      { itemId: service.id, description: 'Strategy session', quantity: 3, rate: '125.50' },
      { accountId: acct['4000'], description: 'Materials', quantity: 1, rate: '99.99' },
    ],
    memo: 'Thanks for your business',
  });
  await createInvoice(ctx, {
    customerId: customer2.id,
    date: new Date('2025-01-15'),
    lines: [{ accountId: acct['4000'], description: 'Open invoice', quantity: 2, rate: '40.00' }],
  });
  const pmt = await receivePayment(ctx, {
    customerId: customer.id,
    date: new Date('2025-01-20'),
    method: 'check',
    reference: '1001',
    amount: inv1.total,
    applications: [{ invoiceId: inv1.id, amountApplied: inv1.total }],
  });
  const sr = await createSalesReceipt(ctx, {
    customerId: customer2.id,
    date: new Date('2025-01-21'),
    lines: [{ accountId: acct['4000'], description: 'Counter sale', quantity: 1, rate: '15.25' }],
  });
  await createDeposit(ctx, {
    depositAccountId: acct['1000'],
    date: new Date('2025-01-22'),
    paymentIds: [pmt.payment.id],
    salesReceiptIds: [sr.id],
    memo: 'Weekly deposit',
  });
  await createCreditMemo(ctx, {
    customerId: customer2.id,
    date: new Date('2025-01-25'),
    lines: [{ accountId: acct['4000'], description: 'Return', quantity: 1, rate: '5.00' }],
  });
  await createEstimate(ctx, {
    customerId: customer.id,
    date: new Date('2025-01-26'),
    lines: [{ description: 'Phase 2', quantity: 10, rate: '125.50' }],
  });

  const bill = await createBill(ctx, {
    vendorId: vendor.id,
    billNumber: 'PS-77',
    date: new Date('2025-01-12'),
    lines: [{ accountId: acct['6300'], description: 'Paper', amount: '310.40', classId: cls.id }],
  });
  await payBills(ctx, {
    vendorId: vendor.id,
    date: new Date('2025-01-28'),
    method: 'check',
    paymentAccountId: acct['1000'],
    applications: [{ billId: bill.id, amountApplied: '310.40' }],
  });
  await createBill(ctx, {
    vendorId: vendor.id,
    billNumber: 'PS-78',
    date: new Date('2025-01-29'),
    lines: [{ accountId: acct['6600'], description: 'Utilities', amount: '88.12' }],
  });
  await createVendorCredit(ctx, {
    vendorId: vendor.id,
    date: new Date('2025-01-30'),
    lines: [{ accountId: acct['6300'], description: 'Damaged paper', amount: '12.00' }],
  });
  await createExpense(ctx, {
    vendorId: vendor.id,
    date: new Date('2025-01-18'),
    method: 'credit_card',
    paymentAccountId: acct['2100'],
    lines: [{ accountId: acct['6000'], description: 'Ads', amount: '45.67' }],
  });
  await createTransfer(ctx, {
    date: new Date('2025-01-31'),
    fromAccountId: acct['1000'],
    toAccountId: acct['1010'],
    amount: '1000.00',
    memo: 'To savings',
  });
  const mistake = await postJournalEntry(ctx, {
    date: new Date('2025-01-19'),
    description: 'Posted in error',
    lines: [
      { accountId: acct['6400'], debit: '700.00' },
      { accountId: acct['1000'], credit: '700.00' },
    ],
  });
  await voidJournalEntry(ctx, mistake.id);

  // An attachment stored in the company data dir (the service resolves the active dir, so
  // the fixture writes the file + row directly with the same layout).
  const attDir = path.join(dataDir, 'attachments');
  fs.mkdirSync(attDir, { recursive: true });
  const diskName = `${bill.id}-receipt.txt`;
  fs.writeFileSync(path.join(attDir, diskName), 'Receipt for bill PS-77\nTotal: 310.40\n');
  await db.insert(attachments).values({
    companyId: company.id,
    entityType: 'bill',
    entityId: bill.id,
    filename: 'receipt.txt',
    storagePath: path.join('attachments', diskName),
    mimeType: 'text/plain',
    sizeBytes: 37,
  });

  return { ctx, acct, customerId: customer.id, vendorId: vendor.id };
}
