/**
 * The multi-user proxy's per-launch secret, end to end through the sign-in route (work package
 * G3, item 1; the rule itself is in lib/net/security3.proxySecret.test.ts).
 *
 * A program on this computer that sends the proxy's headers (x-bka-remote-addr, sec-bka-proxy)
 * straight to 127.0.0.1 without this launch's proxy secret:
 *  - cannot spend a teammate's sign-in attempts: its wrong passwords never lock the teammate's
 *    device out of the account;
 *  - cannot put the teammate's address in the session record: it is recorded as
 *    'this computer, outside Ironbooks' (still a network-level session, viaHost).
 * Without a proxy secret configured, the route behaves as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security3-proxy-secret');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'security3-proxy-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { userSessions, users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { PROXY_SECRET_ENV, PROXY_SECRET_HEADER } from '@/lib/net/loopbackHost';
import { UNVERIFIED_LOCAL_ADDR } from '@/lib/net/requestInfo';
import { createCompany } from './company';
import { POST as loginPOST } from '@/app/api/auth/login/route';

const SECRET = 'e9'.repeat(32);
const TEAMMATE = '100.64.0.7';
let db: DB;
let patId: string;

function resetLimiters() {
  const g = globalThis as unknown as { __bkaLoginLimiter?: unknown; __bkaResetLimiter?: unknown };
  g.__bkaLoginLimiter = undefined;
  g.__bkaResetLimiter = undefined;
}

/** A sign-in claiming to come from TEAMMATE through the proxy; `stamp`: the proxy secret sent. */
function signIn(password: string, stamp: string | null) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, '/api/auth/login');
  h.headers.set(ROUTE_METHOD_HEADER, 'POST');
  h.cookies.clear();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: '127.0.0.1:51234',
    'x-bka-remote-addr': TEAMMATE,
    'sec-bka-proxy': '1',
    'user-agent': 'test-agent',
  };
  if (stamp !== null) headers[PROXY_SECRET_HEADER] = stamp;
  return loginPOST(
    new NextRequest('http://127.0.0.1:51234/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'pat@proxy.local', password }),
    }),
  );
}

async function patSessions() {
  return db.select().from(userSessions).where(eq(userSessions.userId, patId));
}

describe('sign-in through the proxy vs. a program posing as it (proxy secret)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [owner] = await db
      .insert(users)
      .values({ email: 'owner@proxy.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
      .returning();
    await createCompany(db, { name: 'Proxy Co', ownerId: owner.id });
    const [pat] = await db
      .insert(users)
      .values({ email: 'pat@proxy.local', name: 'Pat', passwordHash: await hashPassword('patpass12') })
      .returning();
    patId = pat.id;
  });

  afterAll(async () => {
    delete process.env[PROXY_SECRET_ENV];
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetLimiters();
    await db.delete(userSessions).where(eq(userSessions.userId, patId));
  });
  afterEach(() => {
    delete process.env[PROXY_SECRET_ENV];
  });

  it("wrong passwords sent without the proxy's secret never lock the teammate's device out", async () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    for (let i = 0; i < 6; i++) {
      const res = await signIn('wrong-guess', null);
      expect([401, 429]).toContain(res.status);
    }
    // Pat, through the proxy from their own computer (100.64.0.7), still signs in.
    const ok = await signIn('patpass12', SECRET);
    expect(ok.status).toBe(200);
    const [s] = await patSessions();
    expect(s.remoteAddr).toBe(TEAMMATE);
    expect(s.viaHost).toBe(true);
  });

  it('a sign-in without the secret is recorded as this computer, outside Ironbooks, never as the teammate', async () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    for (const stamp of [null, 'f0'.repeat(32), '']) {
      expect((await signIn('patpass12', stamp)).status).toBe(200);
    }
    const sessions = await patSessions();
    expect(sessions).toHaveLength(3);
    for (const s of sessions) {
      expect(s.remoteAddr).toBe(UNVERIFIED_LOCAL_ADDR);
      expect(s.viaHost).toBe(true); // still network-level trust
      expect(s.userAgent).toBe('test-agent');
    }
  });

  it('no proxy secret configured (dev server, tests, e2e scripts): as before, the header is believed', async () => {
    expect((await signIn('patpass12', null)).status).toBe(200);
    const [s] = await patSessions();
    expect(s.remoteAddr).toBe(TEAMMATE);
    expect(s.viaHost).toBe(true);
  });
});
