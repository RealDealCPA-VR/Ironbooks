/**
 * Vendor lookup through the company's own SearXNG (lib/services/vendorLookup.ts) and the policy
 * rule behind it: off unless the owner turned it on and set an address, refused offline, only the
 * cleaned vendor name is sent, answers cached, failures retried.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import { decideOutbound, normalizeLookupUrl, normalizePolicy } from '@/lib/net/policy';
import type { ServiceContext } from './_base';
import { setNetworkPolicy } from './networkPolicy';
import { clearVendorLookupCache, lookupQuery, lookupVendor } from './vendorLookup';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-vendor-lookup');
const SEARX = 'http://100.64.1.9:8080';
let db: DB;
let ctx: ServiceContext;

function searx(results: unknown[] | Error) {
  const calls: string[] = [];
  const fetchImpl = async (input: string) => {
    calls.push(input);
    if (results instanceof Error) throw results;
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const FERGUSON = [
  { title: 'Ferguson — Plumbing Supplies, HVAC & Waterworks', url: 'https://www.ferguson.com/', content: 'Wholesale distributor of plumbing supplies, pipe, valves and fittings.' },
  { title: 'Ferguson Enterprises - Wikipedia', url: 'https://en.wikipedia.org/wiki/Ferguson_plc', content: 'Ferguson is a distributor of plumbing and heating products.' },
  { title: 'no url, dropped', url: 'javascript:alert(1)', content: 'x' },
];

describe('lookupQuery: only the business name leaves', () => {
  it.each([
    ['SQ *FERGUSON SUPPLY #2231', 'FERGUSON SUPPLY'],
    ['POS SHELL OIL 57442191 STORE 0412', 'SHELL OIL'],
    ['AMAZON MKTPL*2K4L9 4111111111111111', 'AMAZON MKTPL 2K4L9'],
    ['Corner Store', 'Corner Store'],
  ])('%s -> %s', (raw, cleaned) => {
    expect(lookupQuery(raw)).toBe(cleaned);
  });
});

describe('policy: vendor lookup relays to the internet, so it always needs an explicit OK', () => {
  const pol = (mode: 'offline' | 'tailnet-only' | 'allow-cloud', on: boolean) =>
    normalizePolicy({ mode, cloudOptIn: { 'vendor-lookup': on }, vendorLookupUrl: SEARX });

  it('a tailnet or local SearXNG is refused until turned on, then allowed (but never offline)', () => {
    for (const host of [SEARX, 'http://127.0.0.1:8888', 'http://192.168.1.20:8080']) {
      expect(decideOutbound(pol('tailnet-only', false), `${host}/search`, 'vendor-lookup', undefined).allowed, host).toBe(false);
      expect(decideOutbound(pol('tailnet-only', true), `${host}/search`, 'vendor-lookup', undefined).allowed, host).toBe(true);
      expect(decideOutbound(pol('offline', true), `${host}/search`, 'vendor-lookup', undefined).allowed, host).toBe(false);
    }
  });

  it('a public SearXNG still needs allow-cloud on top of the switch', () => {
    expect(decideOutbound(pol('tailnet-only', true), 'https://searx.example.com/search', 'vendor-lookup', undefined).allowed).toBe(false);
    expect(decideOutbound(pol('allow-cloud', true), 'https://searx.example.com/search', 'vendor-lookup', undefined).allowed).toBe(true);
  });

  it('the address must be a plain http(s) URL', () => {
    expect(normalizeLookupUrl('http://searx.tail1234.ts.net:8080/')).toBe('http://searx.tail1234.ts.net:8080');
    for (const bad of ['ftp://x', 'http://user:pw@x', 'http://x/?q=1', 'not a url', '', null, 42]) {
      expect(normalizeLookupUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('lookupVendor', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'lookup@test.local', name: 'L', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'Lookup Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
  });
  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; next run wipes it. */
    }
  });
  beforeEach(() => clearVendorLookupCache());

  it('is off by default: nothing is fetched', async () => {
    const s = searx(FERGUSON);
    expect(await lookupVendor(ctx, 'FERGUSON SUPPLY', { fetchImpl: s.fetchImpl })).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it('needs both the switch and an address', async () => {
    const s = searx(FERGUSON);
    await setNetworkPolicy(ctx, { mode: 'tailnet-only', cloudOptIn: { 'vendor-lookup': false }, vendorLookupUrl: SEARX });
    expect(await lookupVendor(ctx, 'FERGUSON SUPPLY', { fetchImpl: s.fetchImpl })).toBeNull();
    await setNetworkPolicy(ctx, { mode: 'tailnet-only', cloudOptIn: { 'vendor-lookup': true }, vendorLookupUrl: '' });
    expect(await lookupVendor(ctx, 'FERGUSON SUPPLY', { fetchImpl: s.fetchImpl })).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it('when on: sends only the cleaned name, summarizes real results, caches the answer', async () => {
    await setNetworkPolicy(ctx, { mode: 'tailnet-only', cloudOptIn: { 'vendor-lookup': true }, vendorLookupUrl: SEARX });
    const s = searx(FERGUSON);
    const facts = await lookupVendor(ctx, 'SQ *FERGUSON SUPPLY #2231', { fetchImpl: s.fetchImpl });
    expect(s.calls).toHaveLength(1);
    const url = new URL(s.calls[0]);
    expect(url.origin + url.pathname).toBe(`${SEARX}/search`);
    expect(url.searchParams.get('q')).toBe('FERGUSON SUPPLY');
    expect(url.searchParams.get('format')).toBe('json');
    expect(s.calls[0]).not.toContain('2231');
    expect(facts?.query).toBe('FERGUSON SUPPLY');
    expect(facts?.summary).toContain('Wholesale distributor of plumbing supplies');
    expect(facts?.summary).toContain('(www.ferguson.com)');
    expect(facts?.sources).toHaveLength(2); // the javascript: result is dropped
    expect(await lookupVendor(ctx, 'ferguson supply', { fetchImpl: s.fetchImpl })).toEqual(facts);
    expect(s.calls).toHaveLength(1); // cached
  });

  it('a failure is "nothing known" and is retried next time', async () => {
    await setNetworkPolicy(ctx, { mode: 'tailnet-only', cloudOptIn: { 'vendor-lookup': true }, vendorLookupUrl: SEARX });
    const down = searx(new Error('ECONNREFUSED'));
    expect(await lookupVendor(ctx, 'Acme Hydraulics', { fetchImpl: down.fetchImpl })).toBeNull();
    const up = searx(FERGUSON);
    expect(await lookupVendor(ctx, 'Acme Hydraulics', { fetchImpl: up.fetchImpl })).not.toBeNull();
    expect(up.calls).toHaveLength(1);
  });

  it('offline mode never looks anything up', async () => {
    await setNetworkPolicy(ctx, { mode: 'offline', cloudOptIn: { 'vendor-lookup': true }, vendorLookupUrl: SEARX });
    const s = searx(FERGUSON);
    expect(await lookupVendor(ctx, 'Ferguson Supply', { fetchImpl: s.fetchImpl })).toBeNull();
    expect(s.calls).toHaveLength(0);
  });
});
