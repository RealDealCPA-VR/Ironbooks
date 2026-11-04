/**
 * Ctrl+G from another register opens this one at the transaction (?entry=): the page asks for the
 * newest rows only (last=N), and the server widens that window back to the transaction when it is
 * older — so a transfer far back in a busy account is still found and highlighted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-register-goto-kb');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'register-goto-kb-secret';

import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { GET as registerGET } from '@/app/api/registers/[accountId]/route';

let db: DB;
let owner: string;
let companyId: string;
const acct: Record<string, string> = {};
const entries: string[] = [];

function asOwner() {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, '/api/registers/[accountId]');
  h.headers.set(ROUTE_METHOD_HEADER, 'GET');
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, createSessionToken(owner));
  h.cookies.set(COMPANY_COOKIE, companyId);
}
async function register(qs: string) {
  asOwner();
  const res = await registerGET(new NextRequest(`http://127.0.0.1/api/registers/${acct['1010']}?${qs}`), {
    params: Promise.resolve({ accountId: acct['1010'] }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).register as { rows: { journalEntryId: string; runningBalance: string }[]; totalRows: number; offset: number };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@goto-kb.local', name: 'Owner', passwordHash: await hashPassword('pass12345') }).returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Register GoTo KB', ownerId: owner })).id;
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, companyId))) acct[r.code] = r.id;
  // Six transfers into savings (1010 <- 1000), one a month.
  for (let m = 1; m <= 6; m++) {
    const je = await postJournalEntry({ db, companyId, userId: owner }, {
      date: new Date(`2026-0${m}-05T00:00:00.000Z`),
      description: `Transfer ${m}`,
      lines: [
        { accountId: acct['1010'], debit: '10.00' },
        { accountId: acct['1000'], credit: '10.00' },
      ],
    });
    entries.push((je as { id: string }).id);
  }
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Ctrl+G: the register opens at an older transaction', () => {
  it('last=N alone: the newest N rows', async () => {
    const r = await register('last=2');
    expect(r.rows.map((x) => x.journalEntryId)).toEqual(entries.slice(4));
    expect(r.totalRows).toBe(6);
  });

  it('last=N with an older entry: from that transaction (and a few before it) to the newest, true balances', async () => {
    const r = await register(`last=2&entry=${entries[1]}`);
    const ids = r.rows.map((x) => x.journalEntryId);
    expect(ids).toContain(entries[1]);
    expect(ids[ids.length - 1]).toBe(entries[5]);
    expect(r.offset + r.rows.length).toBe(6); // still the newest rows, back to the transaction
    const at = r.rows.find((x) => x.journalEntryId === entries[1])!;
    expect(at.runningBalance).toBe('20.00');
  });

  it('an entry already among the newest rows, or not in this register, changes nothing', async () => {
    expect((await register(`last=2&entry=${entries[5]}`)).rows.length).toBe(2);
    expect((await register('last=2&entry=00000000-0000-0000-0000-000000000000')).rows.length).toBe(2);
  });
});
