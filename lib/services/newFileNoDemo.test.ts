/**
 * A brand-new company file stays empty until its Admin is set up: the desktop shell's own launch-
 * time calls (backup schedule, update-check policy) and the title bar's save indicator must never
 * reach getServerContext's session-less first-run fallback, which would put a "Demo Company"
 * (and a demo user) into the person's new file before they create their own.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ headers: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-new-file-no-demo');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'new-file-no-demo-secret';
process.env.BKA_INTERNAL_TOKEN = 'new-file-internal-token';

import { getDb, closeDb } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { POST as autoBackupPOST } from '@/app/api/dashboard/auto-backup/route';
import { GET as policyGET } from '@/app/api/network-policy/check/route';
import { GET as statusGET } from '@/app/api/company-file/status/route';
import { GET as myPrefsGET } from '@/app/api/preferences/my/route';
import { GET as companiesGET } from '@/app/api/companies/route';

function req(url: string, method: string, internal: boolean) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, new URL(`http://127.0.0.1${url}`).pathname);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.headers.set('host', '127.0.0.1');
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers: { host: '127.0.0.1', ...(internal ? { 'x-bka-internal': 'new-file-internal-token' } : {}) },
  });
}

describe('a new company file before its Admin is set up', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    await getDb(TEST_DIR);
  });
  afterAll(async () => {
    delete process.env.BKA_INTERNAL_TOKEN;
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('launch-time shell calls and the save indicator create nothing', async () => {
    const backup = await autoBackupPOST(req('/api/dashboard/auto-backup?start=1', 'POST', true));
    expect(await backup.json()).toEqual({ status: 'no-company' });
    const policy = await policyGET(
      req(`/api/network-policy/check?purpose=updates&url=${encodeURIComponent('https://github.com/x/y/releases')}`, 'GET', true),
    );
    expect((await policy.json()).allowed).toBe(false);
    const status = await statusGET(req('/api/company-file/status', 'GET', false));
    expect(status.status).toBe(401);
    // Any page-level call before sign-in (My Preferences, the company list) is refused rather
    // than answered by a first-run demo company — for a single company file.
    process.env.BKA_COMPANY_FILE = path.join(TEST_DIR, '..', 'New Co.ironbooks');
    try {
      req('/api/preferences/my', 'GET', false); // stamps the route headers
      expect((await myPrefsGET()).status).toBeGreaterThanOrEqual(400);
      expect((await companiesGET(req('/api/companies', 'GET', false))).status).toBe(401);
    } finally {
      delete process.env.BKA_COMPANY_FILE;
    }

    const db = await getDb(TEST_DIR);
    expect(await db.select().from(companies)).toEqual([]);
    expect(await db.select().from(users)).toEqual([]);
  });
});
