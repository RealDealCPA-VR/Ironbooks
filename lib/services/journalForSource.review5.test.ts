/**
 * Round-5 review regression (Ctrl+Y "Transaction Journal" from an open form): GET
 * /api/journal-entries/for-source answers the document's OWN journal entry. It used to answer the
 * newest live entry carrying the document's source link, and a payment also carries later
 * exchange-rate plugs (applying / unapplying a foreign-currency payment, voiding its refund), so
 * Ctrl+Y on the payment opened an "FX adjustment" entry instead of the payment.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, accounts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { postJournalEntry } from './posting';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { GET as forSourceGET } from '@/app/api/journal-entries/for-source/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-for-source');
let db: DB;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('Transaction Journal lookup (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@forsource.test', name: 'Fern', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Review5 For Source', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it("A: a payment's later FX plug does not replace the payment's own entry", async () => {
    const cust = await createCustomer(ctx, { displayName: 'Plug Co' } as never);
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-05-01'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '80.00' }],
    } as never);
    const pay = await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-05-03'),
      method: 'check',
      amount: '80.00',
      depositAccountId: acct['1050'],
      applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
    } as never);
    const payment = (pay as { payment?: { id: string; postedEntryId: string } }).payment ?? (pay as unknown as { id: string; postedEntryId: string });
    // A later exchange-rate plug on the same payment (what applying / unapplying a foreign
    // payment or voiding its refund posts), with the payment's source link.
    await postJournalEntry(ctx, {
      date: d('2026-05-20'),
      description: 'FX adjustment — unapplied payment applied to invoice',
      sourceRef: `payment:${payment.id}`,
      lines: [
        { accountId: acct['6100'], debit: '0.01', memo: 'Realized exchange loss' },
        { accountId: acct['1200'], credit: '0.01', memo: 'A/R FX adjustment', controlLine: true },
      ],
    });

    const res = await forSourceGET(new NextRequest(`http://localhost/api/journal-entries/for-source?ref=payment:${payment.id}`));
    expect(res.status).toBe(200);
    expect((await res.json()).entryId).toBe(payment.postedEntryId);
  });
});
