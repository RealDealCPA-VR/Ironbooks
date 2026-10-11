/**
 * Independent QA (tester) — re-test round 1. Probes the fixes for the round-0 findings:
 * the repair-turn re-redaction, digit-matched known entities and the spaced-SSN detector.
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

describe('QA round 2: repair turn re-redaction covers every redacted value', () => {
  it('a labeled 6-digit bank account number echoed by the model does not leak in the repair turn', async () => {
    // "acct # 123456" is redacted by the LABELED account detector. Once restored, the bare
    // "123456" in the zod error text has no label, so pattern re-redaction cannot see it.
    const cloud = fakeCloud(['{"accountCode":"[ACCOUNT_1]"}', '{"accountCode":"6000"}']);
    const r = cloudRouter(cloud, () => new Redactor());
    const res = await r.chatJson(
      'categorize',
      [{ role: 'user', content: 'Transfer from acct # 123456 to savings' }],
      z.object({ accountCode: z.enum(['6000', '6100']) }),
    );
    expect(res.data.accountCode).toBe('6000');
    expect(cloud.seen).toHaveLength(2);
    expect(allWire(cloud)).not.toContain('123456');
  });

  it('a labeled SSN without separators echoed back stays redacted in the repair turn', async () => {
    const cloud = fakeCloud(['{"accountCode":"[TAXID_1]"}', '{"accountCode":"6000"}']);
    const r = cloudRouter(cloud, () => new Redactor());
    await r.chatJson(
      'categorize',
      [{ role: 'user', content: 'Contractor SSN 987654321 paid' }],
      z.object({ accountCode: z.enum(['6000', '6100']) }),
    );
    expect(allWire(cloud)).not.toContain('987654321');
  });

  it('a known customer name and email echoed in several fields stay redacted in the repair turn', async () => {
    const cloud = fakeCloud([
      '{"accountCode":"[CUSTOMER_1]","note":"[EMAIL_1]","n":"x"}',
      '{"accountCode":"6000","note":"ok","n":1}',
    ]);
    const r = cloudRouter(cloud, () => new Redactor([{ text: 'Globex Industries', kind: 'CUSTOMER' }]));
    await r.chatJson(
      'categorize',
      [{ role: 'user', content: 'Globex Industries (ap@globex.example) refund' }],
      z.object({ accountCode: z.enum(['6000', '6100']), note: z.literal('ok'), n: z.number() }),
    );
    expect(allWire(cloud)).not.toMatch(/Globex|ap@globex/);
  });
});

describe('QA round 2: digit-matched known entities must not eat money amounts', () => {
  it('a known 7-digit vendor phone does not swallow the amount 55501.00', async () => {
    const r = new Redactor([{ text: '555-0100', kind: 'PHONE' }]);
    const out = r.redact('Invoice total 55501.00 due; call 555-0100');
    expect(out).toContain('55501.00');
    expect(out).not.toContain('555-0100');
  });

  it('a known EIN does not swallow an amount with a decimal point', async () => {
    const r = new Redactor([{ text: '12-3456789', kind: 'EIN' }]);
    const out = r.redact('Paid $1234567.89 to vendor EIN 12-3456789');
    expect(out).toContain('1234567.89');
    expect(out).not.toContain('12-3456789');
  });

  it('a known phone still matches in its common written forms', async () => {
    const r = new Redactor([{ text: '555-0100', kind: 'PHONE' }]);
    for (const s of ['555-0100', '555 0100', '555.0100', '5550100']) {
      expect(r.redact(`call ${s} today`)).not.toContain(s);
    }
  });
});

describe('QA round 2: spaced SSN detector in tabular text', () => {
  it('an unlabeled spaced SSN in a tab-separated row (after an employee number) is redacted', async () => {
    const r = new Redactor();
    expect(r.redact('E007\t123 45 6789\tJ. Doe')).not.toContain('123 45 6789');
  });

  it('an unlabeled spaced SSN on its own line after a numbered line is redacted', async () => {
    const r = new Redactor();
    expect(r.redact('Employees: 3\n123 45 6789')).not.toContain('123 45 6789');
  });
});
