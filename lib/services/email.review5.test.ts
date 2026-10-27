/**
 * Review round 5 — emailing a foreign-currency invoice: the email's {{total}} / {{balance}} are in
 * the invoice's currency (as on the attached PDF). Before the fix they always said dollars, so a
 * EUR 1,000 invoice was emailed as "Total: $1,000.00".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';

const sent: Array<{ text: string; subject: string }> = [];
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (opts: { text: string; subject: string }) => {
        sent.push(opts);
        return { messageId: 'test' };
      },
    }),
  },
}));
vi.mock('@/lib/net/guard', async (orig) => ({
  ...(await orig<typeof import('@/lib/net/guard')>()),
  assertOutboundAllowed: async () => undefined,
}));

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { emailInvoice } from './email';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-email');
const SMTP = { SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'books@example.com' };
const saved: Record<string, string | undefined> = {};

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries(SMTP)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'r5-email@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review5 Email Co', ownerId: u.id });
  ctx = { db, companyId: company.id, userId: u.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
}, 180_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort (Windows) */
  }
});

describe('review5: invoice email amounts', () => {
  it('a EUR invoice is emailed with euro amounts', async () => {
    const c = await createCustomer(ctx, { displayName: 'Berlin GmbH', email: 'ap@berlin.example' } as never);
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: new Date('2026-03-02T00:00:00.000Z'),
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [{ accountId: acct['4000'], description: 'Consulting', quantity: 1, rate: '1000.00' }],
    } as never);
    await emailInvoice(ctx, inv.id);
    const mail = sent.at(-1)!;
    expect(mail.text).toContain('€1,000.00');
    expect(mail.text).not.toContain('$1,000.00');
  });
});
