/**
 * P2 security — independent tester for *.ts.net classification (DNS mocked).
 *  - The verified-name cache is exact: verifying a.tailX.ts.net does not vouch for a sub-name or
 *    a look-alike under another domain.
 *  - Case / trailing dot variants share one verification.
 *  - A name that was tailnet and is later answered with a public (Funnel) address is revoked on
 *    the very next outbound check, so it is blocked as cloud by default (guard.checkOutbound).
 *  - Address checks: IPv4-mapped public addresses and neighbours of the tailnet ranges are not
 *    tailnet.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classifyHost, clearTailnetVerifications } from './cidr';
import { isTailnetAddress, setHostLookup, verifyTailnetName } from './tailnetVerify';
import { checkOutbound } from './guard';
import { classifyEndpoint } from '@/lib/ai/tailnet';
import { makeTestCompany, type TestCompany } from '@/lib/services/testkit.prefs';

const DNS: Record<string, string[]> = {};
let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('p1-tester-net');
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

beforeAll(() => {
  setHostLookup(async (h) => {
    if (!(h in DNS)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return DNS[h];
  });
});

afterEach(() => {
  clearTailnetVerifications();
  for (const k of Object.keys(DNS)) delete DNS[k];
});

afterAll(() => setHostLookup(null));

describe('*.ts.net verification is exact and revocable', () => {
  it('verifying one name does not vouch for sub-names or look-alikes', async () => {
    DNS['box.tail9.ts.net'] = ['100.100.10.10'];
    expect(await verifyTailnetName('box.tail9.ts.net')).toBe(true);
    expect(classifyHost('box.tail9.ts.net')).toBe('tailnet');
    expect(classifyHost('evil.box.tail9.ts.net')).toBe('public');
    expect(classifyHost('box.tail9.ts.net.attacker.example')).toBe('public');
    // A look-alike never triggers a lookup / verification.
    expect(await verifyTailnetName('box.tail9.ts.net.attacker.example')).toBe(false);
  });

  it('case and trailing-dot variants share the verification', async () => {
    DNS['gpu.tail9.ts.net'] = ['fd7a:115c:a1e0::42'];
    expect(await verifyTailnetName('GPU.Tail9.TS.NET.')).toBe(true);
    expect(classifyHost('gpu.tail9.ts.net')).toBe('tailnet');
    expect(classifyHost('GPU.TAIL9.TS.NET')).toBe('tailnet');
    expect(classifyEndpoint('http://gpu.tail9.ts.net:11434')).toMatchObject({ hostClass: 'tailnet' });
  });

  it('a tailnet name that turns into a Funnel (public) answer is revoked at the next outbound check', async () => {
    DNS['llm.tail9.ts.net'] = ['100.70.0.9'];
    const first = await checkOutbound('https://llm.tail9.ts.net/v1/chat/completions', 'ai', t.ctx);
    expect(first.hostClass).toBe('tailnet');
    expect(first.allowed).toBe(true);
    DNS['llm.tail9.ts.net'] = ['203.0.113.50'];
    const second = await checkOutbound('https://llm.tail9.ts.net/v1/chat/completions', 'ai', t.ctx);
    expect(second.hostClass).toBe('public');
    expect(second.allowed).toBe(false);
    // DNS failure after a good answer: not trusted either.
    DNS['llm.tail9.ts.net'] = ['100.70.0.9'];
    await checkOutbound('https://llm.tail9.ts.net/', 'ai', t.ctx);
    delete DNS['llm.tail9.ts.net'];
    const third = await checkOutbound('https://llm.tail9.ts.net/', 'ai', t.ctx);
    expect(third.hostClass).toBe('public');
  });

  it('only addresses inside 100.64.0.0/10 and fd7a:115c:a1e0::/48 count', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true);
    expect(isTailnetAddress('100.127.255.254')).toBe(true);
    expect(isTailnetAddress('100.63.255.255')).toBe(false);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
    expect(isTailnetAddress('fd7a:115c:a1e1::1')).toBe(false);
    expect(isTailnetAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isTailnetAddress('8.8.8.8')).toBe(false);
    expect(isTailnetAddress('not-an-ip')).toBe(false);
  });
});
