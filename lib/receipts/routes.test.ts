/**
 * Receipt capture wiring: permission map entries for every receipt route, the single public
 * route, middleware letting ONLY the phone page through without a session, upload file checks,
 * and navigation / page help.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { API_ROUTE_PERMISSIONS, apiRuleFor, matchRoutePattern, pageAreasFor } from '@/lib/permissions/routes';
import { middleware } from '@/middleware';
import { navGroups, searchPages, simpleNavGroups } from '@/lib/nav';
import { pageHelpFor } from '@/lib/pageHelp';
import { checkReceiptFile, ReceiptFileError, RECEIPT_MAX_BYTES, safeReceiptName, sniffReceiptKind } from './files';
import { isMobileReceiptPage, mobileReceiptUrl } from './mobilePath';
import { encodePng } from './png';

describe('permission map', () => {
  it('maps every receipt route to the right area', () => {
    expect(apiRuleFor('/api/receipts', 'GET')).toEqual({ area: 'lists', action: 'view' });
    expect(apiRuleFor('/api/receipts', 'POST')).toEqual({ area: 'lists', action: 'create' });
    expect(apiRuleFor('/api/receipts/abc', 'GET')).toEqual({ area: 'lists', action: 'view' });
    expect(apiRuleFor('/api/receipts/abc', 'DELETE')).toEqual({ area: 'lists', action: 'delete' });
    expect(apiRuleFor('/api/receipts/abc/extract', 'POST')).toEqual({ area: 'lists', action: 'create' });
    // Saving checks Banking / Vendors in the service, depending on what the receipt becomes.
    expect(apiRuleFor('/api/receipts/abc/save', 'POST')).toBe('member');
    expect(apiRuleFor('/api/receipts/settings', 'GET')).toEqual({ area: 'lists', action: 'view' });
    expect(apiRuleFor('/api/receipts/settings', 'PUT')).toEqual({ area: 'company', action: 'modify' });
    expect(apiRuleFor('/api/receipts/upload-links', 'POST')).toEqual({ area: 'lists', action: 'create' });
    expect(apiRuleFor('/api/receipts/upload-links/abc', 'DELETE')).toEqual({ area: 'lists', action: 'create' });
  });

  it('only the phone link route is public, and only for GET/POST', () => {
    const publicReceiptRoutes = Object.entries(API_ROUTE_PERMISSIONS)
      .filter(([p, rules]) => p.startsWith('/api/receipts') && Object.values(rules).some((r) => r === 'public' || r === 'self'))
      .map(([p]) => p);
    expect(publicReceiptRoutes).toEqual(['/api/receipts/mobile/[token]']);
    expect(apiRuleFor('/api/receipts/mobile/tok', 'GET')).toBe('public');
    expect(apiRuleFor('/api/receipts/mobile/tok', 'POST')).toBe('public');
    expect(apiRuleFor('/api/receipts/mobile/tok', 'DELETE')).toBeNull();
    expect(apiRuleFor('/api/receipts/mobile/tok/extra', 'POST')).toBeNull();
    // Static "mobile" wins over [id]: /api/receipts/mobile/save is the token route, never "save".
    expect(matchRoutePattern('/api/receipts/mobile/save')).toBe('/api/receipts/mobile/[token]');
    expect(matchRoutePattern('/api/receipts/abc/save')).toBe('/api/receipts/[id]/save');
  });

  it('the Receipts pages need Lists; the phone page is not a member page', () => {
    expect(pageAreasFor('/receipts')).toEqual(['lists']);
    expect(pageAreasFor('/receipts/phone')).toEqual(['lists']);
    expect(pageAreasFor('/m/receipt/abc')).toBeNull();
  });
});

describe('middleware: only the phone page skips sign-in', () => {
  const run = (path: string, cookies = '') =>
    middleware(new NextRequest(`http://localhost${path}`, { headers: cookies ? { cookie: cookies } : {} }));
  const redirectedTo = (res: Response) => res.headers.get('location');

  it('lets /m/receipt/<token> through with no cookies at all', () => {
    const res = run('/m/receipt/AbC_d-123');
    expect(redirectedTo(res)).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('still protects everything else, including look-alike paths', () => {
    for (const p of ['/receipts', '/receipts/phone', '/m/receipt/a/b', '/m/receipt/', '/m/receiptx/abc', '/m/receipt/a%2Fb', '/dashboard']) {
      expect(redirectedTo(run(p)), p).toMatch(/\/unlock\/?\?next=/);
    }
    // Unlocked but not signed in: still sent to sign in.
    expect(redirectedTo(run('/receipts', 'bka_unlock=1'))).toMatch(/\/login\?next=%2Freceipts/);
  });

  it('path helper', () => {
    expect(isMobileReceiptPage('/m/receipt/abc')).toBe(true);
    expect(isMobileReceiptPage('/m/receipt/abc/')).toBe(true);
    expect(isMobileReceiptPage('/m/receipt/../dashboard')).toBe(false);
    expect(isMobileReceiptPage('/m/receipt/a.b')).toBe(false);
    expect(mobileReceiptUrl('https://pc.tail1.ts.net:8443/', 'tok_1')).toBe('https://pc.tail1.ts.net:8443/m/receipt/tok_1');
  });
});

describe('upload file checks', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...new Array(20).fill(0)]);
  const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ' + ' '.repeat(10));
  const pdf = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj');
  const heic = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]);
  const mif1 = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypmif1'), 0, 0, 0, 0]);
  const mp4 = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypisom'), 0, 0, 0, 0]);

  it('recognises photos and PDFs by their first bytes', () => {
    expect(sniffReceiptKind(jpeg)).toBe('jpeg');
    expect(sniffReceiptKind(encodePng(2, 2, new Uint8Array(4), 1))).toBe('png');
    expect(sniffReceiptKind(webp)).toBe('webp');
    expect(sniffReceiptKind(pdf)).toBe('pdf');
    expect(sniffReceiptKind(heic)).toBe('heic');
    expect(sniffReceiptKind(mif1)).toBe('heic');
    expect(sniffReceiptKind(mp4)).toBeNull(); // a video is not a receipt
    expect(sniffReceiptKind(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffReceiptKind(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(sniffReceiptKind(new Uint8Array([0xff, 0xd8]))).toBeNull(); // too short
  });

  it('refuses empty, oversized and disguised files with plain messages', () => {
    expect(() => checkReceiptFile({ filename: 'a.jpg', bytes: new Uint8Array(0) })).toThrow(ReceiptFileError);
    expect(() => checkReceiptFile({ filename: 'a.jpg', bytes: jpeg }, { maxBytes: 10 })).toThrow(/too big/);
    expect(() => checkReceiptFile({ filename: 'evil.pdf', bytes: new TextEncoder().encode('<html><script>x</script></html>') })).toThrow(
      /Only photos/,
    );
    const big = new Uint8Array(RECEIPT_MAX_BYTES + 1);
    big.set(jpeg);
    expect(() => checkReceiptFile({ filename: 'big.jpg', bytes: big })).toThrow(/25 MB/);
    expect(checkReceiptFile({ filename: 'x.txt', bytes: pdf })).toEqual({ kind: 'pdf', mimeType: 'application/pdf', filename: 'x.pdf' });
  });

  it('cleans file names and gives them the real extension', () => {
    expect(safeReceiptName('C:\\Users\\me\\Desktop\\IMG 001.HEIC', 'jpeg')).toBe('IMG 001.jpg');
    expect(safeReceiptName('../../etc/passwd', 'pdf')).toBe('passwd.pdf');
    expect(safeReceiptName('a\u0000b<c>.png', 'png')).toBe('abc.png');
    expect(safeReceiptName('', 'png')).toBe('receipt.png');
    expect(safeReceiptName(null, 'webp')).toBe('receipt.webp');
    expect(safeReceiptName('x'.repeat(300) + '.jpg', 'jpeg').length).toBeLessThanOrEqual(124);
  });
});

describe('navigation and help', () => {
  it('Receipts is in the full menu and in Simple mode, with plain-language help', () => {
    expect(navGroups.flatMap((g) => g.links).some((l) => l.path === '/receipts')).toBe(true);
    expect(simpleNavGroups.flatMap((g) => g.links).some((l) => l.path === '/receipts')).toBe(true);
    expect(pageHelpFor('/receipts')?.title).toBe('Receipts');
    expect(pageHelpFor('/receipts/phone')?.title).toBe('Receipts');
    expect(searchPages('receipts').some((r) => r.href.startsWith('/receipts'))).toBe(true);
    expect(searchPages('snap receipt photo').some((r) => r.href.startsWith('/receipts'))).toBe(true);
  });
});
