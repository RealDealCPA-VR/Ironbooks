/**
 * Review round 5 — POST /api/export/reports with a file name outside Latin-1 (a report titled in
 * Chinese, an emoji, an em dash) answered HTTP 500: a header value must be a ByteString, so
 * building the Content-Disposition header threw. The file downloads with a UTF-8 name instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ({ db: null, companyId: 'x', userId: 'u' })) }));
import { POST } from '@/app/api/export/reports/route';

const post = (filename: string) =>
  POST(
    new NextRequest('http://localhost/api/export/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'xlsx', filename, title: 'Report', columns: [{ header: 'A' }], rows: [['1']] }),
    }),
  );

describe('export file names', () => {
  it('a non-Latin-1 name downloads (UTF-8 filename*), not a 500', async () => {
    const res = await post('利润表 — Q1 🚀');
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/^attachment; filename="[\x20-\x7E]+\.xlsx"; filename\*=UTF-8''/);
    expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1])).toBe('利润表 — Q1 🚀.xlsx');
  });

  it('a plain name is unchanged', async () => {
    const res = await post('profit-loss');
    expect(res.headers.get('content-disposition')).toContain('filename="profit-loss.xlsx"');
  });
});
