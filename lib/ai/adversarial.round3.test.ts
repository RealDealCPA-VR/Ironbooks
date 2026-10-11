/**
 * Independent QA (tester) — re-test round 2. Probes the round-2 fixes: the reverse-map
 * re-redaction in Redactor.redact(), repair-turn errors built from unrestored values, the
 * '.'-free separator class for non-phone numeric entities, and the spaced-SSN lookbehind.
 * No network: providers are fakes.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AiRouter } from './router';
import { Redactor } from './redact';
import type { AiProvider, ChatMessage } from './types';

function fakeCloud(replies: string[]): AiProvider & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    id: 'cloud',
    kind: 'anthropic',
    locality: 'cloud',
    seen,
    async chat(messages) {
      seen.push(messages.map((m) => ({ ...m })));
      return { content: replies[Math.min(i++, replies.length - 1)], model: 'cloud-model', providerId: 'cloud' };
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

function cloudRouter(cloud: AiProvider, redactor: () => Redactor) {
  return new AiRouter({
    providers: [cloud],
    cloudEnabled: true,
    taskPolicies: { categorize: 'cloud-only' },
    redactorFactory: redactor,
    retries: 0,
    sleep: noSleep,
  });
}

describe('QA round 3: repair turn built from unrestored values', () => {
  it('a restored value that fails a length check while its placeholder passes gives no details', async () => {
    // "[CUSTOMER_1]" is 12 chars and passes max(12); the restored name does not. The generic
    // error path must not quote the real name.
    const cloud = fakeCloud(['{"payee":"[CUSTOMER_1]"}', '{"payee":"ok"}']);
    const r = cloudRouter(cloud, () => new Redactor([{ text: 'Johnathan Smithsonian', kind: 'CUSTOMER' }]));
    const res = await r.chatJson(
      'categorize',
      [{ role: 'user', content: 'Refund to Johnathan Smithsonian' }],
      z.object({ payee: z.string().max(12) }),
    );
    expect(res.repaired).toBe(true);
    expect(allWire(cloud)).not.toMatch(/Johnathan|Smithsonian/);
  });

  it('a refine message that interpolates the value only ever sees the placeholder', async () => {
    const cloud = fakeCloud(['{"code":"[ACCOUNT_1]"}', '{"code":"6000"}']);
    const r = cloudRouter(cloud, () => new Redactor());
    await r.chatJson(
      'categorize',
      [{ role: 'user', content: 'Wire from routing # 0210000 21' }],
      z.object({
        code: z.string().superRefine((v, c) => {
          if (!/^\d{4}$/.test(v)) c.addIssue({ code: z.ZodIssueCode.custom, message: `unknown code ${v}` });
        }),
      }),
    );
    expect(allWire(cloud)).not.toMatch(/0210000/);
  });

  it('a context-detected value reappearing unlabeled in a LATER message of the same call is redacted', async () => {
    const cloud = fakeCloud(['{"accountCode":"6000"}']);
    const r = cloudRouter(cloud, () => new Redactor());
    await r.chatJson(
      'categorize',
      [
        { role: 'user', content: 'Our acct # 7654321 at First Bank' },
        { role: 'assistant', content: 'Noted.' },
        { role: 'user', content: 'Categorize the transfer out of 7654321' },
      ],
      z.object({ accountCode: z.enum(['6000', '6100']) }),
    );
    expect(allWire(cloud)).not.toContain('7654321');
  });
});

describe('QA round 3: reverse-map re-redaction keeps amounts intact', () => {
  it('a previously redacted 6-digit account number does not swallow a matching money amount', () => {
    const r = new Redactor();
    r.redact('acct # 123456');
    const out = r.redact('Transfer total 123456.78 posted');
    expect(out).toContain('123456.78');
  });

  it('a previously redacted value is replaced by the SAME placeholder later', () => {
    const r = new Redactor();
    const a = r.redact('acct # 123456');
    const b = r.redact('again 123456 here');
    const ph = /\[ACCOUNT_\d+\]/.exec(a)![0];
    expect(b).toContain(ph);
    expect(r.restore(b)).toBe('again 123456 here');
  });
});

describe('QA round 3: numeric known entities after the "no dot separator" change', () => {
  it('a known employee SSN written with dots is still redacted', () => {
    // The round-2 fix removed '.' from the separator class for non-PHONE kinds; a dotted SSN
    // ("123.45.6789") is a common hand-written form and is not a money amount.
    const r = new Redactor([{ text: '123-45-6789', kind: 'SSN' }]);
    const out = r.redact('Employee ID check: 123.45.6789 on file');
    expect(out).not.toContain('123.45.6789');
  });

  it('a LABELED SSN written with dots is redacted even without a known entity', () => {
    const r = new Redactor();
    expect(r.redact('SSN: 123.45.6789')).not.toContain('123.45.6789');
  });

  it('a known 9-digit tax id does not swallow a 9-digit amount with cents', () => {
    const r = new Redactor([{ text: '12-3456789', kind: 'EIN' }]);
    expect(r.redact('Payment 123456789.00 received')).toContain('123456789.00');
  });

  it('a known phone does not swallow an amount with comma thousands separators', () => {
    const r = new Redactor([{ text: '555-0100', kind: 'PHONE' }]);
    expect(r.redact('Total $5,550,100.00 due')).toContain('5,550,100.00');
  });
});

describe('QA round 3: spaced SSN boundaries', () => {
  it('a spaced SSN at the start of the text is redacted', () => {
    expect(new Redactor().redact('123 45 6789 is the SSN')).not.toContain('123 45 6789');
  });

  it('a spaced SSN followed by a tab and another number is redacted', () => {
    expect(new Redactor().redact('J. Doe\t123 45 6789\t2500.00')).not.toContain('123 45 6789');
  });

  it('a spaced SSN with non-breaking spaces (PDF/web paste) is redacted', () => {
    const ssn = '123 45 6789';
    expect(new Redactor().redact(`Employee SSN ${ssn}`)).not.toContain(ssn);
    expect(new Redactor().redact(`Employee ${ssn}`)).not.toContain(ssn);
  });

  it('a plain amount sequence like "Qty 123 45 6789.00" is not called an SSN', () => {
    const out = new Redactor().redact('Lines: 123 45 6789.00');
    expect(out).toContain('6789.00');
  });
});
