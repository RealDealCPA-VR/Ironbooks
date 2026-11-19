/**
 * Security plan 2.9 (first-run part) and 1.1c: the session-less first-run carve-out of
 * /api/companies (GET lists, POST creates) follows the same rules as getServerContext's fallback:
 * never for a teammate's device through the multi-user host, never for a web page that rebound
 * its name to 127.0.0.1 (Host header), and — while the desktop shell's per-launch pass is
 * enforced — never for another program on this computer without it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ headers: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-first-run');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'security1-first-run-secret';

import { getDb, closeDb } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { LAUNCH_PASS_COOKIE, LAUNCH_PASS_ENV } from '@/lib/net/launchPass';
import { getServerContext } from '@/lib/context';
import { GET as companiesGET, POST as companiesPOST } from '@/app/api/companies/route';

const PASS = '7e'.repeat(32);

/** A request as it reaches the route (and next/headers) through middleware. */
function req(method: 'GET' | 'POST', extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:51234', ...extra };
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, '/api/companies');
  h.headers.set(ROUTE_METHOD_HEADER, method);
  for (const [k, v] of Object.entries(headers)) h.headers.set(k, v);
  return new NextRequest('http://localhost:51234/api/companies', {
    method,
    headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify({ name: 'Should Not Exist' }) } : {}),
  });
}

// Each refusal leaves the file empty; the last test opens it (first run seeds a company and user).
describe('first-run carve-out of /api/companies', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    await getDb(TEST_DIR);
  });
  afterEach(() => {
    delete process.env[LAUNCH_PASS_ENV];
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('is refused to a request naming another host (DNS rebinding)', async () => {
    expect((await companiesGET(req('GET', { host: 'evil.example:51234' }))).status).toBe(401);
    expect((await companiesPOST(req('POST', { host: 'evil.example:51234' }))).status).toBe(401);
  });

  it('is refused to a device through the multi-user host', async () => {
    const proxied = { 'x-bka-remote-addr': '100.64.0.9', 'sec-bka-proxy': '1' };
    expect((await companiesGET(req('GET', proxied))).status).toBe(401);
    expect((await companiesPOST(req('POST', proxied))).status).toBe(401);
  });

  it('is refused to a program on this computer without the launch pass while it is enforced', async () => {
    process.env[LAUNCH_PASS_ENV] = PASS;
    expect((await companiesGET(req('GET'))).status).toBe(401);
    expect((await companiesPOST(req('POST'))).status).toBe(401);
    expect((await companiesPOST(req('POST', { cookie: `${LAUNCH_PASS_COOKIE}=${'00'.repeat(32)}` }))).status).toBe(401);
    // The same central rule closes getServerContext's own first-run fallback.
    req('GET');
    await expect(getServerContext()).rejects.toThrow('Authentication required.');

    const db = await getDb(TEST_DIR);
    expect(await db.select().from(companies)).toEqual([]);
    expect(await db.select().from(users)).toEqual([]);
  });

  it('still opens for the app on this computer (the window carries the pass) before any user exists', async () => {
    process.env[LAUNCH_PASS_ENV] = PASS;
    const withPass = await companiesGET(req('GET', { cookie: `bka_session=x; ${LAUNCH_PASS_COOKIE}=${PASS}` }));
    expect(withPass.status).toBe(200);
    expect((await withPass.json()).length).toBeGreaterThan(0);
  });
});
