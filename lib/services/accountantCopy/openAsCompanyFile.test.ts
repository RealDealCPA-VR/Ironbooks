/**
 * Opening an Accountant's Copy transfer file (.ibac) from File > Open or by double-clicking it
 * (electron/main.js openAccountantCopyFlow): the shell posts it to /api/accountant-copy/open with
 * its internal token, a scratch folder and the .ironbooks file the accountant chose. The copy is
 * restored, verified, turned into the accountant's working copy and written out as ONE company
 * file there — no company needs to be open, and nothing lands in the hidden working-copy folder.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-open-file');
const CLIENT_DIR = path.join(ROOT, 'client');
process.env.BKA_DATA_DIR = CLIENT_DIR;
process.env.BKA_INTERNAL_TOKEN = 'acctcopy-open-file-token';

import { closeDb, getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { createCompany } from '../company';
import { createAccountantCopy } from './client';
import { POST as openPOST } from '@/app/api/accountant-copy/open/route';
import companyFileFormat from '@/electron/companyFileFormat';

let transfer: Buffer;

function open(query: string, token: string | null, body: Buffer) {
  return openPOST(
    new NextRequest(`http://127.0.0.1/api/accountant-copy/open?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...(token ? { 'x-bka-internal': token } : {}) },
      body: new Uint8Array(body),
    }),
  );
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const db = await getDb(CLIENT_DIR);
  const [user] = await db.insert(users).values({ email: 'owner-openfile@test.local', name: 'Client Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Open File Client Co', ownerId: user.id });
  const res = await createAccountantCopy({ db, companyId: company.id, userId: user.id }, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR });
  transfer = res.buffer;
});

afterAll(async () => {
  await closeDb(CLIENT_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("Accountant's Copy opened from the desktop shell", () => {
  it('without the internal token, no destination can be named (the signed-in route still applies)', async () => {
    const target = path.join(ROOT, 'nope', 'data');
    const packAs = path.join(ROOT, 'Nope.ironbooks');
    const res = await open(`target=${encodeURIComponent(target)}&packAs=${encodeURIComponent(packAs)}`, 'wrong-token', transfer);
    expect(res.status).toBe(403);
    expect(fs.existsSync(packAs)).toBe(false);
  });

  it('writes the working copy as one .ironbooks company file where the accountant chose', async () => {
    const target = path.join(ROOT, 'scratch', 'data');
    const packAs = path.join(ROOT, "Open File Client Co (Accountant's Copy).ironbooks");
    const res = await open(`target=${encodeURIComponent(target)}&packAs=${encodeURIComponent(packAs)}`, process.env.BKA_INTERNAL_TOKEN!, transfer);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ companyName: 'Open File Client Co', dividingDate: '2026-03-31', packed: packAs });
    expect(companyFileFormat.isCompanyFile(packAs)).toBe(true);
  });

  it('never overwrites an existing company file', async () => {
    const target = path.join(ROOT, 'scratch2', 'data');
    const packAs = path.join(ROOT, "Open File Client Co (Accountant's Copy).ironbooks");
    const res = await open(`target=${encodeURIComponent(target)}&packAs=${encodeURIComponent(packAs)}`, process.env.BKA_INTERNAL_TOKEN!, transfer);
    expect(res.status).toBe(409);
  });
});
