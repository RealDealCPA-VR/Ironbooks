/**
 * Ask AI answers "how do I…?" from the product knowledge base (lib/kb) and links into the app:
 *   - with no model connected, the guide's own answer comes back, with links;
 *   - with a model, the guide is attached to the question, the model's links are checked against
 *     the screens that really exist, and the reply carries "take me there" links;
 *   - questions about the numbers still go to the reports;
 *   - a person is never linked to a page their role may not open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeGrant, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import type { FetchLike } from '@/lib/ai/providers';
import { ask, canOpenPage, helpLookup, keepKnownLinks, replyLinks, runTool, type HelpResult } from './aiAssistant';
import { updateSettings } from './aiSettings';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

const accessWith = (grant: PermissionGrant): EffectiveAccess => ({
  roleKeys: ['custom'],
  permissions: normalizeGrant(grant),
  flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
  isAdmin: false,
});

/** A scripted local model (Ollama on this computer). */
function model(script: (body: { messages: { role: string; content: string }[] }) => string) {
  const calls: { messages: { role: string; content: string }[] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }), { status: 200 });
    calls.push(body);
    return new Response(JSON.stringify({ model: 'qwen2.5:14b', message: { role: 'assistant', content: script(body) } }), { status: 200 });
  };
  return { fetch, calls };
}

beforeAll(async () => {
  t = await makeTestCompany('assistant-help');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('Ask AI without a model: the built-in guide answers how-to questions', () => {
  it('answers with the steps and links to the screen', async () => {
    const r = await ask(t.ctx, [], 'How do I reconcile my bank account?');
    expect(r.mode).toBe('offline');
    expect(r.toolCalls.map((c) => c.tool)).toEqual(['help_search']);
    expect(r.answer).toMatch(/^How do I reconcile a bank or credit card account\?/);
    expect(r.answer).toContain('[Reconcile](/reconcile)');
    expect(r.answer).toMatch(/1\. Open Reconcile/);
    expect(r.links[0]).toEqual({ label: 'Reconcile', href: '/reconcile' });
    expect(r.unverifiedNumbers).toEqual([]);
  });

  it('opens the form directly where the screen supports it', async () => {
    const r = await ask(t.ctx, [], 'Where do I create an invoice?');
    expect(r.links[0]).toEqual({ label: 'New Invoice', href: '/invoices?new=1' });
    const bill = await ask(t.ctx, [], 'how do I enter a bill');
    expect(bill.links.map((l) => l.href)).toEqual(expect.arrayContaining(['/bills', '/pay-bills']));
  });

  it('explains a term from the glossary', async () => {
    const r = await ask(t.ctx, [], 'What does undeposited funds mean?');
    expect(r.toolCalls[0].tool).toBe('help_search');
    expect(r.answer).toMatch(/Undeposited Funds/);
    expect(r.links.some((l) => l.href.startsWith('/help#term-'))).toBe(true);
  });

  it('still answers questions about the numbers from the reports', async () => {
    const tool = async (q: string) => (await ask(t.ctx, [], q)).toolCalls[0]?.tool;
    expect(await tool('How did we do this month?')).toBe('profit_and_loss');
    expect(await tool('Who owes us money?')).toBe('ar_aging');
    expect(await tool('What is our cash balance?')).toBe('account_balances');
    expect(await tool('Which bills are overdue?')).toBe('ap_aging');
    expect((await ask(t.ctx, [], 'How did we do this month?')).links).toEqual([]);
  });

  it('offers the guide when nothing in the books matches', async () => {
    const r = await ask(t.ctx, [], 'print checks');
    expect(r.toolCalls.at(-1)?.tool).toBe('help_search');
    expect(r.answer).toMatch(/^How do I print checks?/);
    expect(r.links[0]?.href).toBe('/print-checks');
  });
});

describe('Ask AI with a model', () => {
  beforeAll(async () => {
    await updateSettings(t.ctx, {
      providers: [{ kind: 'ollama', label: 'GPU box', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:14b', enabled: true }],
    });
  });

  it('attaches the guide to a how-to question and keeps only real links', async () => {
    const m = model(() =>
      JSON.stringify({
        action: 'answer',
        answer:
          'Open [Reconcile](/reconcile), enter the Statement Date and Statement Ending Balance, then tick what cleared. ' +
          'You can also try [the wizard](/reconcile/wizard) or [this site](https://example.com). [help_search]',
      }),
    );
    const r = await ask(t.ctx, [], 'How do I reconcile my bank account?', { deps: { fetch: m.fetch } });
    expect(r.mode).toBe('llm');
    // The guide was looked up before the model ran and travelled with the question.
    expect(r.toolCalls.map((c) => c.tool)).toEqual(['help_search']);
    const sent = m.calls[0].messages.at(-1)!.content;
    expect(sent).toContain('HELP_GUIDE');
    expect(sent).toContain('[Reconcile](/reconcile)');
    expect(m.calls[0].messages[0].content).toContain('help_search');
    // A made-up in-app path loses its link; a real one keeps it.
    expect(r.answer).toContain('[Reconcile](/reconcile)');
    expect(r.answer).toContain('try the wizard or');
    expect(r.answer).not.toContain('/reconcile/wizard');
    expect(r.links[0]).toEqual({ label: 'Reconcile', href: '/reconcile' });
    expect(r.links.every((l) => l.href.startsWith('/'))).toBe(true);
    // "0.00" and the like from the guide are not flagged as unverified money.
    expect(r.unverifiedNumbers).toEqual([]);
  });

  it('gives "take me there" links even when the model writes none', async () => {
    const m = model(() => JSON.stringify({ action: 'answer', answer: 'Use Back Up & Restore and click Back up now. [help_search]' }));
    const r = await ask(t.ctx, [], 'How do I back up my books?', { deps: { fetch: m.fetch } });
    expect(r.links[0]).toEqual({ label: 'Back Up & Restore', href: '/backup' });
  });

  it('lets the model call help_search itself, and leaves numbers questions alone', async () => {
    let step = 0;
    const m = model(() =>
      step++ === 0
        ? '{"action":"tool","tool":"help_search","args":{"query":"pay a bill"}}'
        : JSON.stringify({ action: 'answer', answer: 'Enter it in [Enter Bills](/bills), then pay it in [Pay Bills](/pay-bills). [help_search]' }),
    );
    const r = await ask(t.ctx, [], 'paying a vendor bill', { deps: { fetch: m.fetch } });
    expect(r.toolCalls.map((c) => c.tool)).toEqual(['help_search']);
    expect(m.calls[0].messages.at(-1)!.content).not.toContain('HELP_GUIDE');
    expect(r.links.map((l) => l.href)).toEqual(['/bills', '/pay-bills']);

    const n = model(() => JSON.stringify({ action: 'answer', answer: 'I could not tell.' }));
    const numbers = await ask(t.ctx, [], 'How did we do this month?', { deps: { fetch: n.fetch } });
    expect(numbers.toolCalls).toEqual([]);
    expect(n.calls[0].messages.at(-1)!.content).toBe('How did we do this month?');
    expect(numbers.links).toEqual([]);
  });
});

describe('help lookups respect what a role may open', () => {
  it('help_search needs no report permission, but drops links to pages the role cannot open', async () => {
    const salesOnly = { ...t.ctx, access: accessWith({ customers: ['view', 'create'], reports_financial: ['view'] }) };
    expect(canOpenPage(salesOnly, '/invoices')).toBe(true);
    expect(canOpenPage(salesOnly, '/reconcile')).toBe(false);
    expect(canOpenPage(salesOnly, '/help')).toBe(true);

    const help = (await runTool(salesOnly, 'help_search', { query: 'how do I reconcile my bank account' })) as HelpResult;
    expect(help.guides[0].id).toBe('reconcile-monthly');
    expect(help.guides[0].open).toBeUndefined();
    expect(JSON.stringify(help.guides[0])).not.toContain('(/reconcile)');
    expect(help.guides[0].steps[0]).toMatch(/^1\. Open Reconcile/);

    const r = await ask(salesOnly, [], 'How do I reconcile my bank account?');
    expect(r.links.some((l) => l.href === '/reconcile')).toBe(false);
    // A page they can open is still linked.
    const inv = await ask(salesOnly, [], 'How do I create an invoice?');
    expect(inv.links[0]?.href).toBe('/invoices?new=1');
  });

  it('keepKnownLinks and replyLinks only pass real, permitted screens', () => {
    const all = () => true;
    expect(keepKnownLinks('See [Bills](/bills) and [x](/nope) and [y](/api/users).', all)).toBe('See [Bills](/bills) and x and y.');
    expect(keepKnownLinks('See [Bills](/bills).', (p) => !p.startsWith('/bills'))).toBe('See Bills.');
    expect(keepKnownLinks('[ext](https://example.com) stays as text', all)).toBe('[ext](https://example.com) stays as text');

    const help = helpLookup({}, 'how do i pay a bill');
    expect(replyLinks('Open [Pay Bills](/pay-bills).', [help])[0]).toEqual({ label: 'Pay Bills', href: '/pay-bills' });
    expect(replyLinks('Use Enter Bills first.', [help]).map((l) => l.href)).toContain('/bills');
    expect(replyLinks('No screens named here.', [help]).length).toBeGreaterThan(0);
    expect(replyLinks('No screens named here.', [])).toEqual([]);
    expect(replyLinks('a [1](/bills) [2](/pay-bills) [3](/vendors) [4](/expenses) [5](/reconcile)', []).length).toBe(4);
  });
});
