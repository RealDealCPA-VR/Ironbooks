/**
 * Round-5 review regressions (memorized journal entries):
 *  A. Memorize keeps the Name column (lib/journalBalance.ts journalPayloadLines is what both Save
 *     and Memorize send). The journal window's Memorize used to drop it, so a memorized entry with
 *     an A/R or A/P line could never be entered ("needs a customer in the Name column") — an
 *     automatic one failed on every run.
 *  B. With "Automatically assign general journal entry numbers" on (the default), each entry made
 *     from a memorized journal entry gets the NEXT number, as in QuickBooks, instead of repeating
 *     the number the entry had when it was memorized.
 *  C. A memorized transaction saved without a next date starts TODAY on this computer's calendar
 *     (a ledger date), not at the current instant — at 9:30 pm in New York that was tomorrow, and
 *     every document it entered carried that time of day.
 *  D. "Run due" (which sends the current instant) enters what is due TODAY on this computer's
 *     calendar: at 9:30 pm in New York it used to enter tomorrow's memorized transactions already.
 *  E. A memorized transaction whose stored amounts are not numbers (templates keep the payload as
 *     typed) is refused with a plain 400 when entered, not an "Internal server error" (500).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, accounts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createManualEntry, getEntry } from './journal';
import { createTemplate, runTemplateNow } from './recurring';
import { journalPayloadLines } from '@/lib/journalBalance';
import { NextRequest } from 'next/server';

vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as recurringPOST } from '@/app/api/recurring/route';
import { POST as runPOST } from '@/app/api/recurring/run/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-recurring');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

describe('memorized journal entries (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@recurring.test', name: 'Remy', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Review5 Recurring', ownerId: user.id });
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

  it('A: a memorized entry with an A/R line keeps its customer and can be entered', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Monthly Fee Co' } as never);
    // The journal window's form lines, as the user typed them.
    const lines = journalPayloadLines([
      { accountId: acct['1200'], debit: '1,250.00', credit: '', memo: ' Monthly fee ', classId: '', name: `customer:${cust.id}` },
      { accountId: acct['4100'], debit: '', credit: '1250.00', memo: '', classId: '', name: '' },
      { accountId: '', debit: '', credit: '', memo: '', classId: '', name: '' },
    ]);
    expect(lines).toEqual([
      { accountId: acct['1200'], debit: '1250.00', credit: undefined, memo: 'Monthly fee', classId: null, entityType: 'customer', entityId: cust.id },
      { accountId: acct['4100'], debit: undefined, credit: '1250.00', memo: null, classId: null, entityType: null, entityId: null },
    ]);
    const t = await createTemplate(ctx, {
      name: 'Monthly fee',
      docType: 'journal_entry',
      frequency: 'monthly',
      nextRunDate: '2026-11-01',
      mode: 'remind',
      template: { date: '2026-10-01', description: 'Monthly fee', reference: null, lines },
    });
    const doc = await runTemplateNow(ctx, t.id, new Date('2026-11-01T00:00:00Z'));
    const e = await getEntry(ctx, doc.docId);
    expect(e.lines.find((l) => l.accountId === acct['1200'])?.entityId).toBe(cust.id);
  });

  it('B: each entry from a memorized journal entry gets the next entry number', async () => {
    const lines = [
      { accountId: acct['6400'], debit: '900.00' },
      { accountId: acct['1000'], credit: '900.00' },
    ];
    const first = await createManualEntry(ctx, { date: new Date('2026-10-01T00:00:00Z'), description: 'Rent', lines });
    const memorizedRef = first.reference!;
    const t = await createTemplate(ctx, {
      name: 'Rent',
      docType: 'journal_entry',
      frequency: 'monthly',
      nextRunDate: '2026-11-01',
      mode: 'remind',
      template: { date: '2026-10-01', description: 'Rent', reference: memorizedRef, lines },
    });
    const a = await getEntry(ctx, (await runTemplateNow(ctx, t.id, new Date('2026-11-01T00:00:00Z'))).docId);
    const b = await getEntry(ctx, (await runTemplateNow(ctx, t.id, new Date('2026-12-01T00:00:00Z'))).docId);
    const refs = [memorizedRef, a.reference, b.reference];
    expect(new Set(refs).size).toBe(3);
    expect(Number(b.reference)).toBe(Number(a.reference) + 1);
  });

  it('C: a memorized transaction saved without a next date starts today (local calendar day)', async () => {
    const realTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T01:30:00Z')); // Oct 26, 9:30 pm in New York
    try {
      const res = await recurringPOST(
        new NextRequest('http://localhost/api/recurring', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Weekly sweep',
            docType: 'journal_entry',
            frequency: 'weekly',
            mode: 'remind',
            template: { description: 'Sweep', lines: [{ accountId: acct['6400'], debit: '1.00' }, { accountId: acct['1000'], credit: '1.00' }] },
          }),
        }),
      );
      expect(res.status).toBe(201);
      expect(new Date((await res.json()).nextRunDate).toISOString()).toBe('2026-10-26T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
      if (realTz === undefined) delete process.env.TZ;
      else process.env.TZ = realTz;
    }
  });

  it("D: Run due at 9:30 pm in New York does not enter tomorrow's memorized transactions", async () => {
    const t = await createTemplate(ctx, {
      name: 'Tomorrow rent',
      docType: 'journal_entry',
      frequency: 'monthly',
      nextRunDate: '2026-10-27',
      mode: 'automatic',
      template: { description: 'Rent', lines: [{ accountId: acct['6400'], debit: '5.00' }, { accountId: acct['1000'], credit: '5.00' }] },
    });
    const realTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T01:30:00Z')); // Oct 26, 9:30 pm in New York
    try {
      const res = await runPOST(
        new NextRequest('http://localhost/api/recurring/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ asOf: new Date().toISOString() }),
        }),
      );
      expect(res.status).toBe(200);
      const out = await res.json();
      expect(out.generated.map((g: { templateId: string }) => g.templateId)).not.toContain(t.id);
    } finally {
      vi.useRealTimers();
      if (realTz === undefined) delete process.env.TZ;
      else process.env.TZ = realTz;
    }
  });

  it('E: entering a memorized transaction with a non-numeric amount is a 400 with a plain message', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Bad Amount Co' } as never);
    const t = await createTemplate(ctx, {
      name: 'Broken invoice',
      docType: 'invoice',
      frequency: 'monthly',
      nextRunDate: '2026-11-01',
      mode: 'remind',
      template: { customerId: cust.id, lines: [{ accountId: acct['4100'], quantity: 1, rate: 'twelve' }] },
    });
    const res = await runPOST(
      new NextRequest('http://localhost/api/recurring/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: t.id }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/twelve/);
  });
});
