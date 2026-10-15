/**
 * Receipt capture — phone upload links and the one session-less route, plus the local vision
 * model path. Security focus: the token is the only credential, so it must be unguessable,
 * stored hashed, single-company, short-lived, revocable, upload-limited (also under parallel
 * uploads), tied to a still-active member, add-only, and the route must reject wrong types,
 * oversized bodies and token guessing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { receiptScans, receiptUploadTokens, userCompanies } from '@/lib/db/schema';
import { encodePng } from '@/lib/receipts/png';
import { MOBILE_MAX_BYTES } from '@/lib/receipts/files';
import { setOcrEngineForTests } from '@/lib/receipts/ocr';
import { createCompany } from './company';
import { updateSettings } from './aiSettings';
import { removeFilePassword, setFilePassword } from './fileLock';
import {
  createUploadToken,
  extractReceipt,
  getReceipt,
  getReceiptSettingsView,
  hashUploadToken,
  listUploadTokens,
  revokeUploadToken,
  setReceiptSettings,
  setServerStartedAtForTests,
  uploadLinkStatus,
  uploadReceipt,
  uploadWithToken,
} from './receipts';
import type { ServiceContext } from './_base';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';
import { GET as linkGET, POST as linkPOST } from '@/app/api/receipts/mobile/[token]/route';

let t: TestCompany;
const png = () => encodePng(4, 4, new Uint8Array(16).fill(128), 1);
const file = (bytes: Uint8Array = png(), filename = 'IMG_1.png') => ({ filename, bytes });

function multipart(token: string, bytes: Uint8Array, opts: { name?: string; type?: string; contentLength?: string | null } = {}) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: opts.type ?? 'image/png' }), opts.name ?? 'photo.png');
  const req = new Request(`http://localhost/api/receipts/mobile/${token}`, { method: 'POST', body: form });
  return req;
}

async function toNextRequest(req: Request, override?: { contentLength?: string | null; contentType?: string }) {
  const body = await req.arrayBuffer();
  const headers = new Headers(req.headers);
  if (override?.contentType) headers.set('content-type', override.contentType);
  if (override?.contentLength === null) headers.delete('content-length');
  else headers.set('content-length', override?.contentLength ?? String(body.byteLength));
  return new NextRequest(req.url, { method: req.method, headers, body });
}

const params = (token: string) => ({ params: Promise.resolve({ token }) });

function resetLimiter() {
  delete (globalThis as { __bkaReceiptLinkLimiter?: unknown }).__bkaReceiptLinkLimiter;
}

async function settle(ctx: ServiceContext, id: string) {
  for (let i = 0; i < 50; i++) {
    const r = await getReceipt(ctx, id);
    if (r.status !== 'pending' && r.status !== 'processing') return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('receipt never finished reading');
}

describe('receipt capture: phone upload links (integration)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('receiptphone');
    setOcrEngineForTests({ recognize: async () => 'PHONE SHOP\nTotal 3.50' });
  });
  afterAll(async () => {
    setOcrEngineForTests(undefined);
    await t.cleanup();
  });
  afterEach(() => {
    resetLimiter();
    vi.unstubAllGlobals();
  });

  it('issues an unguessable token, stores only its hash, and expires it in 15 minutes', async () => {
    const now = new Date('2026-10-15T10:00:00Z');
    const link = await createUploadToken(t.ctx, { now });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 random bits
    expect(link.expiresAt.toISOString()).toBe('2026-10-15T10:15:00.000Z');
    expect(link.maxUploads).toBe(20);
    const [row] = await t.db.select().from(receiptUploadTokens).where(eq(receiptUploadTokens.id, link.id));
    expect(row.tokenHash).toBe(hashUploadToken(link.token));
    expect(JSON.stringify(row)).not.toContain(link.token);
    const other = await createUploadToken(t.ctx);
    expect(other.token).not.toBe(link.token);
  });

  it('a phone upload lands in the issuing company inbox, marked as from a phone', async () => {
    const link = await createUploadToken(t.ctx, { maxUploads: 3 });
    const status = await uploadLinkStatus(t.db, link.token);
    expect(status).toMatchObject({ companyName: 'receiptphone Co', remaining: 3, maxBytes: MOBILE_MAX_BYTES });
    const { receipt, remaining } = await uploadWithToken(t.db, link.token, file());
    expect(remaining).toBe(2);
    expect(receipt).toMatchObject({ source: 'phone', status: 'pending' });
    const [scan] = await t.db.select().from(receiptScans).where(eq(receiptScans.id, receipt.id));
    expect(scan.companyId).toBe(t.ctx.companyId);
    expect(scan.createdBy).toBe(t.ctx.userId);
  });

  it('refuses expired, revoked, used-up and made-up tokens', async () => {
    const link = await createUploadToken(t.ctx, { maxUploads: 1 });
    const later = new Date(Date.now() + 16 * 60_000);
    await expect(uploadWithToken(t.db, link.token, file(), later)).rejects.toMatchObject({ problem: 'expired' });
    await expect(uploadLinkStatus(t.db, link.token, later)).rejects.toMatchObject({ problem: 'expired' });

    await uploadWithToken(t.db, link.token, file());
    await expect(uploadWithToken(t.db, link.token, file())).rejects.toMatchObject({ problem: 'used_up' });

    const revoked = await createUploadToken(t.ctx);
    await revokeUploadToken(t.ctx, revoked.id);
    await expect(uploadWithToken(t.db, revoked.token, file())).rejects.toMatchObject({ problem: 'revoked' });
    expect((await listUploadTokens(t.ctx)).map((l) => l.id)).not.toContain(revoked.id);

    for (const bad of ['', 'x', 'a'.repeat(43), `${link.token}x`, '../../etc/passwd', "' OR 1=1 --"]) {
      await expect(uploadWithToken(t.db, bad, file())).rejects.toMatchObject({ problem: 'invalid', code: 'NOT_FOUND' });
    }
  });

  it('checks the file (type by bytes, size) before using up an upload', async () => {
    const link = await createUploadToken(t.ctx, { maxUploads: 2 });
    await expect(uploadWithToken(t.db, link.token, file(Buffer.from('MZ\x90\x00 not a photo at all'), 'a.jpg'))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const big = new Uint8Array(MOBILE_MAX_BYTES + 1);
    big.set(png());
    await expect(uploadWithToken(t.db, link.token, file(big))).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await uploadLinkStatus(t.db, link.token)).remaining).toBe(2);
  });

  it('parallel uploads can never exceed the limit', async () => {
    const link = await createUploadToken(t.ctx, { maxUploads: 3 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => uploadWithToken(t.db, link.token, file())));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(3);
    const [row] = await t.db.select().from(receiptUploadTokens).where(eq(receiptUploadTokens.id, link.id));
    expect(row.uploadCount).toBe(3);
  });

  it('stops working when the person who made it loses access', async () => {
    const member = await addMember(t, 'accountant', 'phone-member');
    const link = await createUploadToken(member);
    await uploadWithToken(t.db, link.token, file());
    await t.db.update(userCompanies).set({ isActive: false }).where(eq(userCompanies.userId, member.userId!));
    await expect(uploadWithToken(t.db, link.token, file())).rejects.toMatchObject({ problem: 'not_allowed' });
    await expect(uploadLinkStatus(t.db, link.token)).rejects.toMatchObject({ problem: 'not_allowed' });
  });

  it('is bound to one company: a token from company A never adds to company B', async () => {
    const otherCo = await createCompany(t.db, { name: 'Other Co', ownerId: t.ctx.userId! });
    const octx: ServiceContext = { db: t.db, companyId: otherCo.id, userId: t.ctx.userId };
    const linkB = await createUploadToken(octx);
    const { receipt } = await uploadWithToken(t.db, linkB.token, file());
    await expect(getReceipt(t.ctx, receipt.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getReceipt(octx, receipt.id)).id).toBe(receipt.id);
    // Company A can't revoke or list company B's links.
    await expect(revokeUploadToken(t.ctx, linkB.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listUploadTokens(t.ctx)).map((l) => l.id)).not.toContain(linkB.id);
  });

  it('view-only members cannot make links', async () => {
    await expect(createUploadToken({ ...t.ctx, role: 'viewer' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  describe('company-file password (the phone has no unlock cookie)', () => {
    afterEach(async () => {
      setServerStartedAtForTests(undefined);
      await removeFilePassword(t.db, 'file-pass-123').catch(() => {});
    });

    it('a link made before the app was restarted is refused while the file has a password', async () => {
      const before = await createUploadToken(t.ctx, { maxUploads: 3 });
      await setFilePassword(t.db, 'file-pass-123');
      // The app restarts: the file is locked again until someone opens it on the computer.
      setServerStartedAtForTests(new Date(Date.now() + 1000));
      await expect(uploadLinkStatus(t.db, before.token)).rejects.toMatchObject({ problem: 'locked' });
      await expect(uploadWithToken(t.db, before.token, file())).rejects.toMatchObject({ problem: 'locked' });
      // Nothing was added and no upload was used up.
      const [row] = await t.db.select().from(receiptUploadTokens).where(eq(receiptUploadTokens.id, before.id));
      expect(row.uploadCount).toBe(0);

      const gotStatus = await linkGET(new NextRequest(`http://localhost/api/receipts/mobile/${before.token}`), params(before.token));
      expect(gotStatus.status).toBe(423);
      expect((await gotStatus.json()).error).toMatch(/Open the company on your computer first/);
      const posted = await linkPOST(await toNextRequest(multipart(before.token, png())), params(before.token));
      expect(posted.status).toBe(423);
      expect((await t.db.select().from(receiptUploadTokens).where(eq(receiptUploadTokens.id, before.id)))[0].uploadCount).toBe(0);

      // Once the company is opened again (unlocked to make a new link), the new link works.
      setServerStartedAtForTests(new Date(Date.now() - 1000));
      const fresh = await createUploadToken(t.ctx);
      await expect(uploadWithToken(t.db, fresh.token, file())).resolves.toMatchObject({ remaining: fresh.maxUploads - 1 });
    });

    it('without a file password a restart does not cut off a live link', async () => {
      const link = await createUploadToken(t.ctx);
      setServerStartedAtForTests(new Date(Date.now() + 1000));
      await expect(uploadLinkStatus(t.db, link.token)).resolves.toMatchObject({ remaining: link.maxUploads });
    });

    it('a link made in this launch keeps working with a file password set', async () => {
      await setFilePassword(t.db, 'file-pass-123');
      const link = await createUploadToken(t.ctx);
      await expect(uploadWithToken(t.db, link.token, file())).resolves.toMatchObject({ remaining: link.maxUploads - 1 });
    });
  });

  describe('the public route /api/receipts/mobile/[token]', () => {
    it('needs no session, answers only "received" and leaves the receipt in the inbox', async () => {
      const link = await createUploadToken(t.ctx, { maxUploads: 5 });
      const get = await linkGET(new NextRequest(`http://localhost/api/receipts/mobile/${link.token}`), params(link.token));
      expect(get.status).toBe(200);
      expect(get.headers.get('cache-control')).toBe('no-store');
      expect(await get.json()).toMatchObject({ companyName: 'receiptphone Co', remaining: 5 });

      const res = await linkPOST(await toNextRequest(multipart(link.token, png())), params(link.token));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['filename', 'received', 'remaining']);
      expect(body).toMatchObject({ received: true, remaining: 4 });
      const [scan] = await t.db.select().from(receiptScans).where(eq(receiptScans.source, 'phone'));
      expect(scan).toBeTruthy();
      // The upload is read in the background on this machine.
      const [latest] = (await t.db.select().from(receiptScans).where(eq(receiptScans.companyId, t.ctx.companyId))).sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      const done = await settle(t.ctx, latest.id);
      expect(done.total).toBe('3.50');
    });

    it('answers 404 for unknown tokens, 410 for expired ones, and locks out guessing', async () => {
      const unknown = 'Z'.repeat(43);
      const r404 = await linkGET(new NextRequest(`http://localhost/api/receipts/mobile/${unknown}`), params(unknown));
      expect(r404.status).toBe(404);
      const link = await createUploadToken(t.ctx, { now: new Date(Date.now() - 20 * 60_000) });
      const r410 = await linkPOST(await toNextRequest(multipart(link.token, png())), params(link.token));
      expect(r410.status).toBe(410);
      for (let i = 0; i < 10; i++) await linkGET(new NextRequest('http://localhost/api/receipts/mobile/x'), params('x'));
      const valid = await createUploadToken(t.ctx);
      const locked = await linkGET(new NextRequest(`http://localhost/api/receipts/mobile/${valid.token}`), params(valid.token));
      expect(locked.status).toBe(429);
      expect(locked.headers.get('retry-after')).toBeTruthy();
    });

    it('refuses non-multipart bodies, missing or oversized lengths and non-receipt files', async () => {
      const link = await createUploadToken(t.ctx, { maxUploads: 5 });
      const json = new NextRequest(`http://localhost/api/receipts/mobile/${link.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body: '{}',
      });
      expect((await linkPOST(json, params(link.token))).status).toBe(415);
      const noLength = await toNextRequest(multipart(link.token, png()), { contentLength: null });
      expect((await linkPOST(noLength, params(link.token))).status).toBe(411);
      const huge = await toNextRequest(multipart(link.token, png()), { contentLength: String(MOBILE_MAX_BYTES + 10 * 1024 * 1024) });
      expect((await linkPOST(huge, params(link.token))).status).toBe(413);
      const html = await linkPOST(
        await toNextRequest(multipart(link.token, Buffer.from('<svg onload=alert(1)></svg>'), { name: 'x.png', type: 'image/png' })),
        params(link.token),
      );
      expect(html.status).toBe(400);
      expect((await uploadLinkStatus(t.db, link.token)).remaining).toBe(5);
    });
  });

  describe('local vision model (optional alternative to OCR)', () => {
    it('only local Ollama models can be picked, and photos go only to them', async () => {
      const saved = await updateSettings(t.ctx, {
        providers: [
          { id: 'vision-local', kind: 'ollama', label: 'GPU box', baseUrl: 'http://127.0.0.1:11434', model: 'llava', enabled: true },
          { id: 'cloud', kind: 'anthropic', label: 'Claude', model: 'claude-sonnet-5-5', enabled: true, apiKey: 'sk-test' },
        ],
        cloudEnabled: true,
        taskPolicies: { categorize: 'cloud-only' },
      });
      const localId = saved.providers.find((p) => p.kind === 'ollama')!.id;
      const cloudId = saved.providers.find((p) => p.kind === 'anthropic')!.id;
      const view = await getReceiptSettingsView(t.ctx);
      expect(view.visionModels.map((m) => m.id)).toEqual([localId]);
      await expect(setReceiptSettings(t.ctx, { visionProviderId: cloudId })).rejects.toMatchObject({ code: 'VALIDATION' });
      await setReceiptSettings(t.ctx, { visionProviderId: localId, preferVision: true });

      const calls: { url: string; body: string }[] = [];
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? '') });
        return new Response(JSON.stringify({ model: 'llava', message: { content: 'VISION MART\nDate: 2026-10-01\nTotal 12.00' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      setOcrEngineForTests(null);
      try {
        const up = await uploadReceipt(t.ctx, { filename: 'v.png', bytes: png() });
        const r = await extractReceipt(t.ctx, up.id);
        expect(r).toMatchObject({ method: 'vision', vendorName: 'Vision Mart', total: '12.00', date: '2026-10-01' });
        expect(calls.length).toBe(1);
        expect(new URL(calls[0].url).hostname).toBe('127.0.0.1');
        const sent = JSON.parse(calls[0].body);
        expect(sent.messages[0].images[0]).toBe(png().toString('base64'));
      } finally {
        setOcrEngineForTests({ recognize: async () => 'PHONE SHOP\nTotal 3.50' });
        await setReceiptSettings(t.ctx, { visionProviderId: null, preferVision: false });
      }
    });
  });
});
