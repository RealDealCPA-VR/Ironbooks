/**
 * Security package G2 — GET /api/portable names its download with the shared helper
 * (lib/fileDownload.ts contentDisposition).
 *
 * The route kept its own copy of the header code, with the two bugs the shared one had fixed: a
 * lone surrogate made encodeURIComponent throw, and '\' was left in the quoted name. A company name
 * whose 120-character cut (portableFilename) falls inside an emoji leaves a lone surrogate, so the
 * portable file could not be downloaded at all (500).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { GET as portableGET } from '@/app/api/portable/route';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('g2-portable');
  routeCtx = t.ctx;
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

describe('portable company file download name', () => {
  it('a name cut inside an emoji still downloads, with one well-formed header', async () => {
    const name = `${'A'.repeat(119)}\u{1F680} Books`;
    await t.db.update(companies).set({ name }).where(eq(companies.id, t.ctx.companyId));
    const res = await portableGET();
    expect(res.status).toBe(200);
    const header = res.headers.get('Content-Disposition') ?? '';
    expect(header).toMatch(/^attachment; filename="[^"\\]*"; filename\*=UTF-8''[A-Za-z0-9!#$&+\-.^_`|~%]*$/);
    // The half emoji becomes U+FFFD (%EF%BF%BD) instead of failing the download.
    expect(header).toContain('%EF%BF%BD');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  }, 120_000);
});
