/**
 * Independent QA (tester) — adversarial tests for the pure AI layer: router privacy
 * invariants, redaction edge cases, endpoint classification tricks, key vault, categorizer
 * numerics. No network: providers are fakes / fetch is mocked.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AiRouter } from './router';
import { Redactor } from './redact';
import { classifyEndpoint, classifyHost } from './tailnet';
import { createOllamaProvider, createOpenAiCompatibleProvider, localityOf, type FetchLike } from './providers';
import { decryptSecret, encryptSecret } from './keyVault';
import { emptyState, learn, predict, dropLabel } from './categorizer';
import { AiError, type AiProvider, type ChatMessage } from './types';

function fakeProvider(id: string, locality: 'local' | 'cloud', replies: Array<string | Error>): AiProvider & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    id,
    kind: locality === 'local' ? 'ollama' : 'anthropic',
    locality,
    seen,
    async chat(messages) {
      seen.push(messages.map((m) => ({ ...m })));
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { content: r, model: `${id}-model`, providerId: id };
    },
    async listModels() {
      return [];
    },
    async health() {
      return { ok: true, latencyMs: 1 };
    },
  };
}
const noSleep = async () => {};
const allWire = (p: { seen: ChatMessage[][] }) => p.seen.flat().map((m) => m.content).join('\n');

// ---------------------------------------------------------------------------
// Router — privacy + resilience
// ---------------------------------------------------------------------------

describe('QA: router never leaks restored PII back to a cloud model', () => {
  it('the structured-output REPAIR turn sent to a cloud model contains no unredacted names', async () => {
    // The cloud model echoes a placeholder where an account code was expected. The router
    // restores placeholders BEFORE zod validation, so the zod error text contains the real
    // name — and that error text is then sent back to the cloud model in the repair turn.
    const cloud = fakeProvider('cloud', 'cloud', ['{"accountCode":"[EMPLOYEE_1]"}', '{"accountCode":"6000"}']);
    const r = new AiRouter({
      providers: [cloud],
      cloudEnabled: true,
      taskPolicies: { categorize: 'cloud-only' },
      redactorFactory: () => new Redactor([{ text: 'Jane Smith', kind: 'EMPLOYEE' }]),
      sleep: noSleep,
    });
    const res = await r.chatJson(
      'categorize',
      [{ role: 'user', content: 'Reimbursement to Jane Smith for mileage' }],
      z.object({ accountCode: z.enum(['6000', '6100']) }),
    );
    expect(res.data.accountCode).toBe('6000');
    expect(cloud.seen).toHaveLength(2);
    expect(allWire(cloud)).not.toMatch(/Jane|Smith/);
  });

  it('local-then-cloud: local failure falls back to a REDACTED cloud call (system prompt too)', async () => {
    const local = fakeProvider('local', 'local', [new AiError('NETWORK', 'down')]);
    const cloud = fakeProvider('cloud', 'cloud', ['ok [CUSTOMER_1]']);
    const r = new AiRouter({
      providers: [local, cloud],
      cloudEnabled: true,
      taskPolicies: { assistant: 'local-then-cloud' },
      redactorFactory: () => new Redactor([{ text: 'Globex Industries', kind: 'CUSTOMER' }]),
      retries: 0,
      sleep: noSleep,
    });
    const res = await r.chat('assistant', [
      { role: 'system', content: 'Customer of interest: Globex Industries, ssn 123-45-6789' },
      { role: 'user', content: 'Did Globex Industries pay? Call (212) 555-0199.' },
    ]);
    expect(local.seen[0][1].content).toContain('Globex Industries'); // local may see raw data
    const wire = allWire(cloud);
    expect(wire).not.toMatch(/Globex|123-45-6789|555-0199/);
    expect(res.content).toBe('ok Globex Industries');
    expect(res.redacted).toBe(true);
  });

  it('cloud-only with cloud disabled never calls any provider, even a local one', async () => {
    const local = fakeProvider('local', 'local', ['x']);
    const cloud = fakeProvider('cloud', 'cloud', ['x']);
    const r = new AiRouter({ providers: [local, cloud], cloudEnabled: false, taskPolicies: { assistant: 'cloud-only' } });
    await expect(r.chat('assistant', [{ role: 'user', content: 'q' }])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(local.seen).toHaveLength(0);
    expect(cloud.seen).toHaveLength(0);
  });

  it('retries 5xx / 429 up to the configured count, then gives up', async () => {
    const p = fakeProvider('l', 'local', [
      new AiError('HTTP', 'busy', undefined, 503),
      new AiError('HTTP', 'rate', undefined, 429),
      new AiError('HTTP', 'busy', undefined, 503),
    ]);
    const r = new AiRouter({ providers: [p], cloudEnabled: false, retries: 2, sleep: noSleep });
    await expect(r.chat('categorize', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(p.seen).toHaveLength(3);
  });

  it('a caller abort stops the router from trying further providers', async () => {
    const ac = new AbortController();
    const first: AiProvider = {
      id: 'first', kind: 'ollama', locality: 'local',
      chat: async () => {
        ac.abort();
        throw new AiError('NETWORK', 'aborted');
      },
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 0 }),
    };
    const second = fakeProvider('second', 'local', ['should not be used']);
    const r = new AiRouter({ providers: [first, second], cloudEnabled: false, retries: 2, sleep: noSleep });
    await expect(r.chat('categorize', [{ role: 'user', content: 'x' }], { signal: ac.signal })).rejects.toBeInstanceOf(AiError);
    expect(second.seen).toHaveLength(0);
  });

  it('structured output: non-JSON twice from the only provider → UNAVAILABLE, never returns garbage', async () => {
    const p = fakeProvider('l', 'local', ['I think 6000', 'definitely 6000']);
    const r = new AiRouter({ providers: [p], cloudEnabled: false });
    await expect(r.chatJson('categorize', [{ role: 'user', content: 'x' }], z.object({ a: z.string() }))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(p.seen).toHaveLength(2); // exactly one repair
  });
});

describe('QA: providers on public hosts are cloud and excluded by local-only', () => {
  it('an Ollama / OpenAI-compatible server on a public IP or domain is never used under local-only', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ message: { content: 'x' }, choices: [{ message: { content: 'x' } }] }), { status: 200 });
    };
    const pub1 = createOllamaProvider({ id: 'p1', kind: 'ollama', label: 'x', baseUrl: 'http://8.8.8.8:11434', model: 'm', enabled: true }, { fetch });
    const pub2 = createOpenAiCompatibleProvider({ id: 'p2', kind: 'openai-compatible', label: 'x', baseUrl: 'https://api.example.com', model: 'm', enabled: true }, { fetch });
    const trick = createOllamaProvider({ id: 'p3', kind: 'ollama', label: 'x', baseUrl: 'http://gpu.tail1.ts.net@evil.example.com:11434', model: 'm', enabled: true }, { fetch });
    expect([pub1.locality, pub2.locality, trick.locality]).toEqual(['cloud', 'cloud', 'cloud']);
    const r = new AiRouter({ providers: [pub1, pub2, trick], cloudEnabled: true });
    await expect(r.chat('assistant', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Redaction edge cases
// ---------------------------------------------------------------------------

describe('QA: redaction edge cases', () => {
  it('unlabeled SSN written with spaces is redacted', () => {
    const r = new Redactor();
    expect(r.redact('Payroll adj for 123 45 6789 approved')).not.toContain('6789');
  });

  it('a known 7-digit vendor phone (no area code) from the company list is redacted', () => {
    // buildCompanyRedactor pushes vendor phones as PHONE entities; the "numeric names" filter
    // in the Redactor constructor silently drops them.
    const r = new Redactor([{ text: '555-0100', kind: 'PHONE' }]);
    expect(r.redact('Call the vendor at 555-0100 tomorrow')).not.toContain('555-0100');
  });

  it('a known employee SSN stored with spaces is redacted', () => {
    const r = new Redactor([{ text: '123 45 6789', kind: 'SSN' }]);
    expect(r.redact('emp 123 45 6789')).not.toContain('6789');
  });

  it('names with possessives, punctuation and regex metacharacters', () => {
    const r = new Redactor([
      { text: 'A+B (Holdings)', kind: 'CUSTOMER' },
      { text: 'Acme Corp', kind: 'CUSTOMER' },
      { text: 'O\'Brien & Sons', kind: 'VENDOR' },
    ]);
    const red = r.redact("Acme Corp's invoice; A+B (Holdings) paid O'Brien & Sons.");
    expect(red).not.toMatch(/Acme|Holdings|Brien/);
    expect(r.restore(red)).toBe("Acme Corp's invoice; A+B (Holdings) paid O'Brien & Sons.");
  });

  it('accented names are redacted and restored exactly', () => {
    const r = new Redactor([{ text: 'José García', kind: 'EMPLOYEE' }]);
    const red = r.redact('Paid José García $500.00');
    expect(red).toBe('Paid [EMPLOYEE_1] $500.00');
    expect(r.restore(red)).toBe('Paid José García $500.00');
  });

  it('money figures, negatives and parenthesised amounts survive untouched', () => {
    const r = new Redactor();
    const s = 'Net (1,200.00), loss -500.00, total $1,234,567.89, big 12345678.90, code 6000, JE #1042';
    expect(r.redact(s)).toBe(s);
  });

  it('Luhn-valid card with dashes and an Amex are redacted; restore round-trips', () => {
    const r = new Redactor();
    const s = 'Visa 4111-1111-1111-1111 and amex 3782 822463 10005';
    const red = r.redact(s);
    expect(red).not.toMatch(/4111|10005/);
    expect(r.restore(red)).toBe(s);
  });

  it('the same value redacted in two different turns maps to the same placeholder', () => {
    const r = new Redactor();
    const a = r.redact('email bob@x.io');
    const b = r.redact('BOB@x.io wrote back');
    expect(a.match(/\[EMAIL_\d+\]/)![0]).toBe('[EMAIL_1]');
    // case-insensitive email normalisation → stable placeholder
    expect(b).toContain('[EMAIL_1]');
  });

  it('restore leaves unknown placeholders alone and is idempotent', () => {
    const r = new Redactor([{ text: 'Initech', kind: 'CUSTOMER' }]);
    const red = r.redact('Initech');
    const once = r.restore(`${red} and [CUSTOMER_9]`);
    expect(once).toBe('Initech and [CUSTOMER_9]');
    expect(r.restore(once)).toBe(once);
  });

  it('restoreDeep handles nested arrays/objects and leaves non-strings intact', () => {
    const r = new Redactor([{ text: 'Initech', kind: 'CUSTOMER' }]);
    r.redact('Initech');
    expect(r.restoreDeep({ a: [{ b: '[CUSTOMER_1]' }, 3, null, true] })).toEqual({ a: [{ b: 'Initech' }, 3, null, true] });
  });
});

// ---------------------------------------------------------------------------
// Tailnet classification tricks
// ---------------------------------------------------------------------------

describe('QA: endpoint classification', () => {
  it('CGNAT boundaries', () => {
    expect(classifyHost('100.63.255.255')).toBe('public');
    expect(classifyHost('100.64.0.0')).toBe('tailnet');
    expect(classifyHost('100.127.255.255')).toBe('tailnet');
    expect(classifyHost('100.128.0.1')).toBe('public');
    expect(classifyHost('172.15.0.1')).toBe('public');
    expect(classifyHost('172.32.0.1')).toBe('public');
    expect(classifyHost('256.1.1.1')).not.toBe('lan');
  });

  it('look-alike hostnames are public', () => {
    expect(classifyHost('localhost.evil.com')).toBe('public');
    expect(classifyHost('ts.net.evil.com')).toBe('public');
    expect(classifyHost('evil-ts.net')).toBe('public');
  });

  it('userinfo tricks and numeric IP encodings resolve to the real host', () => {
    expect(classifyEndpoint('http://gpu.tail1.ts.net@evil.example.com/').hostClass).toBe('public');
    expect(classifyEndpoint('http://2130706433:11434').hostClass).toBe('loopback'); // 127.0.0.1
    expect(classifyEndpoint('http://0x64.0x40.0.1:11434').hostClass).toBe('tailnet'); // 100.64.0.1
    expect(classifyEndpoint('http://[fd7a:115c:a1e0::5]:11434').hostClass).toBe('tailnet');
    expect(classifyEndpoint('http://[::1]:11434').hostClass).toBe('loopback');
  });

  it('non-http schemes are rejected and are never local', () => {
    for (const u of ['ftp://100.64.0.1', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const c = classifyEndpoint(u);
      expect(c.isPrivate).toBe(false);
      expect(localityOf({ kind: 'ollama', baseUrl: u })).toBe('cloud');
    }
  });

  it('public HTTP warns; tailnet HTTP does not', () => {
    expect(classifyEndpoint('http://203.0.113.5:11434').warning).toMatch(/PUBLIC/);
    expect(classifyEndpoint('http://100.101.102.103:11434').warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Key vault
// ---------------------------------------------------------------------------

describe('QA: key vault', () => {
  const secret = 'qa-secret-abcdef';
  it('round-trips unicode / one-char keys and uses a fresh IV each time', () => {
    // (Empty keys are never stored — updateSettings ignores blank apiKey input.)
    const a = encryptSecret('sk-ünïcødé-🔑', 'c1', secret);
    const b = encryptSecret('sk-ünïcødé-🔑', 'c1', secret);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, 'c1', secret)).toBe('sk-ünïcødé-🔑');
    expect(decryptSecret(encryptSecret('k', 'c1', secret), 'c1', secret)).toBe('k');
  });

  it('fails closed on wrong company, wrong secret, truncation, bit flips and junk', () => {
    const blob = encryptSecret('sk-live-123', 'c1', secret);
    expect(decryptSecret(blob, 'c2', secret)).toBeNull();
    expect(decryptSecret(blob, 'c1', 'other-secret')).toBeNull();
    expect(decryptSecret(blob.slice(0, 20), 'c1', secret)).toBeNull();
    const raw = Buffer.from(blob.slice(3), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(decryptSecret('v1:' + raw.toString('base64'), 'c1', secret)).toBeNull();
    expect(decryptSecret('sk-live-123', 'c1', secret)).toBeNull();
    expect(decryptSecret('v1:!!!notbase64', 'c1', secret)).toBeNull();
    expect(decryptSecret(null, 'c1', secret)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Categorizer numerics
// ---------------------------------------------------------------------------

describe('QA: categorizer numerics', () => {
  it('stays finite and within [0,1] with thousands of examples and many labels', () => {
    const s = emptyState();
    for (let i = 0; i < 3000; i++) {
      learn(s, {
        payee: `Vendor ${i % 97} store ${i}`,
        memo: `memo word${i % 13}`,
        amount: `${(i % 500) + 0.37}`,
        direction: i % 7 === 0 ? 'in' : 'out',
        labels: { account: `acct-${i % 41}`, class: i % 3 ? null : `cls-${i % 5}` },
      }, { track: true });
    }
    const p = predict(s, { payee: 'Vendor 5 store 99999', amount: '42.37', direction: 'out' });
    expect(p.account).not.toBeNull();
    for (const c of [p.account!.confidence, ...p.account!.alternatives.map((a) => a.confidence)]) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    const alts = p.account!.alternatives.map((a) => a.confidence);
    expect([...alts].sort((a, b) => b - a)).toEqual(alts);
  });

  it('an empty allowed set yields no suggestion (never an inactive account)', () => {
    const s = emptyState();
    for (let i = 0; i < 5; i++) learn(s, { payee: 'Shell', amount: '40', direction: 'out', labels: { account: 'fuel' } });
    expect(predict(s, { payee: 'Shell', amount: '40', direction: 'out' }, { allowed: { account: new Set() } }).account).toBeNull();
  });

  it('dropLabel removes a merged/deleted account from future predictions', () => {
    const s = emptyState();
    for (let i = 0; i < 5; i++) learn(s, { payee: 'Shell', amount: '40', direction: 'out', labels: { account: 'fuel' } });
    learn(s, { payee: 'Shell', amount: '40', direction: 'out', labels: { account: 'auto' } });
    dropLabel(s, 'account', 'fuel');
    expect(predict(s, { payee: 'Shell', amount: '40', direction: 'out' }).account!.label).toBe('auto');
  });

  it('a payee seen once can never clear a 0.95 auto-apply threshold', () => {
    const s = emptyState();
    learn(s, { payee: 'One Time Vendor', amount: '999.99', direction: 'out', labels: { account: 'x' } });
    expect(predict(s, { payee: 'One Time Vendor', amount: '999.99', direction: 'out' }).account!.confidence).toBeLessThan(0.95);
  });
});

describe('fix round: numeric known entities do not shred ordinary numbers', () => {
  it('a known phone matches across separators but leaves amounts, dates and short codes alone', () => {
    const r = new Redactor([
      { text: '(212) 555-0100', kind: 'PHONE' },
      { text: '1234', kind: 'ACCOUNT' }, // too short to be safe — ignored
    ]);
    const out = r.redact('Call 212.555.0100 or 2125550100 re: $2,125,550.10 on 2026-01-23, acct code 1234');
    expect(out).not.toMatch(/555.?0100/);
    expect(out).toContain('$2,125,550.10');
    expect(out).toContain('2026-01-23');
    expect(out).toContain('1234');
    expect(r.restore(out)).toContain('212.555.0100');
  });

  it('spaced-SSN detector does not fire inside longer digit sequences', () => {
    const r = new Redactor();
    expect(r.redact('ref 1 123 45 6789 2')).toBe('ref 1 123 45 6789 2');
  });
});
