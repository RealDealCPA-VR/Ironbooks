/**
 * Review round 5 — typed-in customer / vendor balances (Migrate from QuickBooks, step 3).
 *
 * The form stripped every comma and space from the amount before sending it, and the server read
 * what was left: a bookkeeper typing "12,50" (a decimal comma) brought in an invoice of 1,250.00,
 * and "1 250,00" one of 125,000.00 — accepted silently, A/R overstated a hundredfold. A comma now
 * only counts in the US thousands form (1,250.00); a decimal comma is refused with a plain message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { invoices, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { importOpenItems, previewOpenItems } from './openItemsImport';
import { manualOpenItems } from '@/app/qb-import/OpenItemsImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-openitems-review5');
let db: DB;
let userId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'openitems-r5@test.local', name: 'R5', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes the dir first. */
  }
});

describe('typed-in balances and the decimal comma', () => {
  it('the form sends the amount as typed (no comma or space stripped out of the number)', () => {
    const rows = (amount: string) => manualOpenItems([{ name: 'Acme', date: '2026-01-05', number: '', amount }], 'ar');
    expect(rows('12,50')[0].openBalance).not.toBe('1250');
    expect(rows('1 250,00')[0].openBalance).not.toBe('125000');
    expect(rows('$1,250.00')[0]).toMatchObject({ kind: 'invoice', openBalance: '1,250.00' });
    expect(rows('(25.00)')[0]).toMatchObject({ kind: 'credit_memo', openBalance: '25.00' });
    expect(rows('-$ 40')[0]).toMatchObject({ kind: 'credit_memo', openBalance: '40' });
    expect(manualOpenItems([{ name: 'Supplier', date: '2026-01-05', number: '', amount: '-5' }], 'ap')[0].kind).toBe('vendor_credit');
  });

  it('the server refuses a decimal comma instead of reading 12,50 as 1,250.00', async () => {
    const co = await createCompany(db, { name: 'Comma Co', ownerId: userId });
    const ctx: ServiceContext = { db, companyId: co.id, userId };
    for (const amount of ['12,50', '1250,00', '1.250,00', '1,25']) {
      await expect(
        previewOpenItems(ctx, { side: 'ar', items: [{ kind: 'invoice', name: 'Acme', date: '2026-01-05', openBalance: amount }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/1,250\.00/) });
    }
    const r = await importOpenItems(ctx, {
      side: 'ar',
      alreadyInGl: false,
      items: [
        { kind: 'invoice', name: 'Acme', date: '2026-01-05', openBalance: '1,250.00' },
        { kind: 'invoice', name: 'Acme', date: '2026-01-06', openBalance: '1 250.00' },
      ],
    });
    expect(r.invoices).toBe(2);
    const totals = (await db.select({ t: invoices.total }).from(invoices).where(eq(invoices.companyId, ctx.companyId))).map((x) => x.t);
    expect(totals.sort()).toEqual(['1250.00', '1250.00']);
  });
});
