/**
 * Independent QA (tester) — adversarial integration tests for the AI layer against a
 * throwaway PGlite company file: permission bypass, cross-company isolation, malformed
 * model output, proposal validation, rollback on failure, idempotency, and the accounting
 * invariant (trial balance stays balanced). Model servers are mocked; no network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  userCompanies,
  accounts,
  vendors,
  bankAccounts,
  bankTransactions,
  aiAutoApplied,
  aiProposals,
  aiSettings,
  auditLogs,
  journalEntries,
  fiscalPeriods,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createExpense } from './expenses';
import { trialBalance } from './reports';
import { getPublicSettings, updateSettings, testConnection } from './aiSettings';
import { autoApplyBankSuggestions, llmSuggestBankCategory, suggestBankCategories, vendorPrefill } from './aiCategorizer';
import { ask, approveProposal, createJournalProposal, rejectProposal, runTool } from './aiAssistant';
import type { FetchLike } from '@/lib/ai/providers';
import { setNetworkPolicy } from './networkPolicy';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-adversarial');

let db: DB;
let ctx: ServiceContext; // owner, company A
let viewerCtx: ServiceContext;
let accountantCtx: ServiceContext;
let ctxB: ServiceContext; // owner, company B
const acct: Record<string, string> = {};
let bankAccountId: string;
let vendorShell: string;

function ollama(script: (body: any) => string) {
  const calls: any[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }), { status: 200 });
    return new Response(JSON.stringify({ model: 'qwen2.5:14b', message: { role: 'assistant', content: script(body) } }), { status: 200 });
  };
  return { fetch, calls };
}

async function addBankTxn(payee: string, amount: string, date = '2026-09-15') {
  const [t] = await db
    .insert(bankTransactions)
    .values({ companyId: ctx.companyId, bankAccountId, date: new Date(date), payee, description: payee, amount })
    .returning();
  return t.id;
}

async function countProposals(companyId = ctx.companyId) {
  return (await db.select().from(aiProposals).where(eq(aiProposals.companyId, companyId))).length;
}
async function countEntries(companyId = ctx.companyId) {
  return (await db.select().from(journalEntries).where(eq(journalEntries.companyId, companyId))).length;
}

const goodLines = [
  { accountCode: '6200', debit: '150.00' },
  { accountCode: '2000', credit: '150.00', name: 'Shell Oil' },
];

describe('AI layer — adversarial QA', () => {
  beforeAll(async () => {
    process.env.BKA_AUTH_SECRET = 'qa-adversarial-secret-0123456789';
    db = await getDb(TEST_DIR);
    const [owner] = await db.insert(users).values({ email: 'qa-owner@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const [viewer] = await db.insert(users).values({ email: 'qa-viewer@test.local', name: 'Viewer', passwordHash: 'x' }).returning();
    const [accountant] = await db.insert(users).values({ email: 'qa-acct@test.local', name: 'Acct', passwordHash: 'x' }).returning();
    const [ownerB] = await db.insert(users).values({ email: 'qa-ownerb@test.local', name: 'Owner B', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'QA Co A', ownerId: owner.id }).returning();
    const [companyB] = await db.insert(companies).values({ name: 'QA Co B', ownerId: ownerB.id }).returning();
    await db.insert(userCompanies).values([
      { userId: viewer.id, companyId: company.id, role: 'viewer' },
      { userId: accountant.id, companyId: company.id, role: 'accountant' },
    ]);
    ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
    viewerCtx = { db, companyId: company.id, userId: viewer.id, role: 'viewer' };
    accountantCtx = { db, companyId: company.id, userId: accountant.id, role: 'accountant' };
    ctxB = { db, companyId: companyB.id, userId: ownerB.id, role: 'owner' };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['6000', 'Fuel', 'expense', 'operating_expenses'],
      ['6200', 'Office Supplies', 'expense', 'operating_expenses'],
      ['6400', 'Travel', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    // Company B has an account code that does not exist in A.
    await createAccount(ctxB, { code: '7777', name: 'B Only Expense', type: 'expense' as never, subtype: 'operating_expenses' });
    await createAccount(ctxB, { code: '1000', name: 'B Checking', type: 'asset' as never, subtype: 'checking' });

    const [ba] = await db.insert(bankAccounts).values({ companyId: company.id, accountId: acct['1000'], bankName: 'QA Bank', accountNumber: '9876' }).returning();
    bankAccountId = ba.id;
    const [v] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Shell Oil' }).returning();
    vendorShell = v.id;
    for (let i = 0; i < 10; i++) {
      await createExpense(ctx, {
        vendorId: vendorShell,
        date: new Date(Date.UTC(2026, 0, 5 + i * 7)),
        method: 'cash',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6000'], amount: `${40 + i}.00`, description: 'Fuel' }],
      });
    }
    await updateSettings(ctx, {
      providers: [{ kind: 'ollama', label: 'GPU', baseUrl: 'http://100.80.1.2:11434', model: 'qwen2.5:14b', enabled: true }],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.BKA_AUTH_SECRET;
  });

  // -------------------------------------------------------------------------
  // Proposal validation (model output is untrusted)
  // -------------------------------------------------------------------------

  it('rejects an impossible calendar date instead of silently posting on a different day', async () => {
    // "2026-02-30" passes the YYYY-MM-DD regex; JS Date rolls it to 2026-03-02.
    const before = await countProposals();
    await expect(
      createJournalProposal(ctx, { date: '2026-02-30', description: 'bad date', lines: goodLines }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countProposals()).toBe(before);
  });

  it('rejects malformed amounts and line shapes, storing nothing', async () => {
    const before = await countProposals();
    const bad: unknown[] = [
      [{ accountCode: '6200', debit: '-150.00' }, { accountCode: '2000', credit: '-150.00' }],
      [{ accountCode: '6200', debit: '150.005' }, { accountCode: '2000', credit: '150.005' }],
      [{ accountCode: '6200', debit: 'abc' }, { accountCode: '2000', credit: 'abc' }],
      [{ accountCode: '6200', debit: Number.NaN }, { accountCode: '2000', credit: Number.NaN }],
      [{ accountCode: '6200', debit: Number.POSITIVE_INFINITY }, { accountCode: '2000', credit: Number.POSITIVE_INFINITY }],
      [{ accountCode: '6200', debit: '1e3' }, { accountCode: '2000', credit: '1000.00' }],
      [{ accountCode: '6200', debit: '100.00', credit: '100.00' }, { accountCode: '2000', debit: '0', credit: '0' }],
      [{ accountCode: '6200' }, { accountCode: '2000' }],
      [{ accountCode: '6200', debit: '100.00' }, { accountCode: '2000', credit: '99.99' }],
      [{ accountCode: '6200', debit: '100.00' }],
    ];
    for (const lines of bad) {
      await expect(createJournalProposal(ctx, { date: '2026-09-30', description: 'x', lines })).rejects.toBeTruthy();
    }
    expect(await countProposals()).toBe(before);
  });

  it("rejects another company's account code (no cross-company posting via proposals)", async () => {
    await expect(
      createJournalProposal(ctx, { date: '2026-09-30', description: 'x', lines: [{ accountCode: '7777', debit: '10.00' }, { accountCode: '1000', credit: '10.00' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('cross-company: company B cannot approve or reject company A proposals', async () => {
    const p = await createJournalProposal(ctx, { date: '2026-09-30', description: 'A accrual', lines: goodLines });
    const entriesB = await countEntries(ctxB.companyId);
    await expect(approveProposal(ctxB, p.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(rejectProposal(ctxB, p.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await countEntries(ctxB.companyId)).toBe(entriesB);
    const [row] = await db.select().from(aiProposals).where(eq(aiProposals.id, p.id));
    expect(row.status).toBe('pending');
    await rejectProposal(ctx, p.id);
  });

  it('viewer cannot reject; accountant can approve; double approve posts exactly once', async () => {
    const p = await createJournalProposal(ctx, { date: '2026-09-30', description: 'accrual', lines: goodLines });
    await expect(rejectProposal(viewerCtx, p.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const before = await countEntries();
    const results = await Promise.allSettled([approveProposal(accountantCtx, p.id), approveProposal(accountantCtx, p.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await countEntries()).toBe(before + 1);
    await expect(rejectProposal(ctx, p.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('approval into a closed period fails, rolls back, and leaves the proposal pending', async () => {
    const p = await createJournalProposal(ctx, { date: '2026-03-15', description: 'March accrual', lines: goodLines });
    const [fp] = await db
      .insert(fiscalPeriods)
      .values({ companyId: ctx.companyId, periodStart: new Date('2026-03-01T00:00:00Z'), periodEnd: new Date('2026-03-31T23:59:59Z'), isClosed: true })
      .returning();
    const before = await countEntries();
    const auditsBefore = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, p.id))).length;
    await expect(approveProposal(ctx, p.id)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(await countEntries()).toBe(before);
    const [row] = await db.select().from(aiProposals).where(eq(aiProposals.id, p.id));
    expect(row.status).toBe('pending');
    expect((await db.select().from(auditLogs).where(eq(auditLogs.entityId, p.id))).length).toBe(auditsBefore);
    await db.delete(fiscalPeriods).where(eq(fiscalPeriods.id, fp.id));
    await rejectProposal(ctx, p.id);
  });

  it('approval re-checks accounts: an account deactivated after the proposal is not posted to', async () => {
    const p = await createJournalProposal(ctx, {
      date: '2026-09-30',
      description: 'travel accrual',
      lines: [{ accountCode: '6400', debit: '75.00' }, { accountCode: '2000', credit: '75.00' }],
    });
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, acct['6400']));
    try {
      const before = await countEntries();
      await expect(approveProposal(ctx, p.id)).rejects.toBeTruthy();
      expect(await countEntries()).toBe(before);
    } finally {
      await db.update(accounts).set({ isActive: true }).where(eq(accounts.id, acct['6400']));
    }
  });

  // -------------------------------------------------------------------------
  // Assistant: permissions + hostile model output
  // -------------------------------------------------------------------------

  it('a viewer (read-only role) cannot create stored write proposals through the assistant', async () => {
    const m = ollama(() =>
      JSON.stringify({ action: 'answer', answer: 'Prepared for approval.', proposal: { type: 'journal_entry', date: '2026-09-30', description: 'viewer write', lines: goodLines } }),
    );
    const before = await countProposals();
    const r = await ask(viewerCtx, [], 'Record $150 of supplies', { deps: { fetch: m.fetch } });
    expect(r.proposals).toHaveLength(0);
    expect(await countProposals()).toBe(before);
  });

  it('a model that tries to call a write tool cannot write anything (falls back safely)', async () => {
    const m = ollama(() => '{"action":"tool","tool":"create_journal_entry","args":{"debit":"6000","credit":"1000","amount":"999"}}');
    const before = await countEntries();
    const proposalsBefore = await countProposals();
    const r = await ask(ctx, [], 'Book $999 of fuel', { deps: { fetch: m.fetch }, retries: 0, sleep: async () => {} });
    expect(r.mode).toBe('offline');
    expect(r.notice).toMatch(/unavailable/i);
    expect(await countEntries()).toBe(before);
    expect(await countProposals()).toBe(proposalsBefore);
  });

  it('tool errors are reported to the model, not thrown; hostile search text is inert', async () => {
    await expect(runTool(ctx, 'profit_and_loss', { from: '01/01/2026' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(runTool(ctx, 'drop_tables', {})).rejects.toMatchObject({ code: 'VALIDATION' });
    const r = (await runTool(ctx, 'search_transactions', { query: "'; DROP TABLE accounts; --", limit: 5 })) as { entries: unknown[] };
    expect(r.entries).toEqual([]);
    expect((await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).length).toBeGreaterThan(0);

    let step = 0;
    const m = ollama(() => (++step === 1 ? '{"action":"tool","tool":"balance_sheet","args":{"asOf":"yesterday"}}' : '{"action":"answer","answer":"I could not run that."}'));
    const reply = await ask(ctx, [], 'balance sheet?', { deps: { fetch: m.fetch } });
    expect(reply.mode).toBe('llm');
    expect(reply.toolCalls[0].error).toMatch(/Invalid arguments/);
    const lastMsg = m.calls[1].body.messages.at(-1).content as string;
    expect(lastMsg).toMatch(/^TOOL_RESULT balance_sheet ERROR/);
  });

  it('tool results are scoped to the caller company (B sees none of A)', async () => {
    const r = (await runTool(ctxB, 'search_transactions', { query: 'Fuel', limit: 25 })) as { entries: unknown[] };
    expect(r.entries).toEqual([]);
    const a = (await runTool(ctxB, 'list_accounts', {})) as { accounts: { code: string }[] };
    expect(a.accounts.map((x) => x.code).sort()).toEqual(['1000', '7777']);
  });

  // -------------------------------------------------------------------------
  // Settings permissions + validation
  // -------------------------------------------------------------------------

  it('accountants cannot change AI settings or probe endpoints', async () => {
    await expect(updateSettings(accountantCtx, { cloudEnabled: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      testConnection(accountantCtx, { kind: 'ollama', label: 'x', baseUrl: 'http://10.0.0.1:11434', model: 'm', enabled: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await getPublicSettings(ctx)).cloudEnabled).toBe(false);
  });

  it('threshold bounds and coercion', async () => {
    for (const bad of [1.01, 0.4999, 'abc', '', Number.NaN, -1]) {
      await expect(updateSettings(ctx, { autoApplyThreshold: bad as never })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect((await updateSettings(ctx, { autoApplyThreshold: '0.5' })).autoApplyThreshold).toBe('0.5000');
    expect((await updateSettings(ctx, { autoApplyThreshold: 1 })).autoApplyThreshold).toBe('1.0000');
  });

  it('an Anthropic custom base URL must be HTTPS; key never surfaces anywhere client-visible', async () => {
    const cur = await getPublicSettings(ctx);
    const keep = cur.providers.map((p) => ({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled }));
    await expect(
      updateSettings(ctx, { providers: [...keep, { kind: 'anthropic', label: 'C', baseUrl: 'http://proxy.example.com', apiKey: 'sk-ant-QA-PLAINTEXT', enabled: true }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const s = await updateSettings(ctx, { providers: [...keep, { kind: 'anthropic', label: 'C', apiKey: 'sk-ant-QA-PLAINTEXT', enabled: false }] });
    const claude = s.providers.find((p) => p.kind === 'anthropic')!;
    // Test Connection on the saved provider reuses the stored key, but never echoes it.
    const t = await testConnection(ctx, { id: claude.id, kind: 'anthropic', label: 'C', model: '', enabled: true });
    expect(JSON.stringify(t)).not.toContain('QA-PLAINTEXT');
    const [row] = await db.select().from(aiSettings).where(eq(aiSettings.companyId, ctx.companyId));
    expect(JSON.stringify(row)).not.toContain('QA-PLAINTEXT');
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityType, 'ai_settings'));
    const auditJson = JSON.stringify(audits);
    expect(auditJson).not.toContain('QA-PLAINTEXT');
    expect(auditJson).not.toContain('v1:'); // ciphertext not copied into the audit trail either
    expect(JSON.stringify(await getPublicSettings(viewerCtx))).not.toContain('v1:');
    await updateSettings(ctx, { providers: keep });
  });

  // -------------------------------------------------------------------------
  // Bank feeds: auto-apply / suggestions
  // -------------------------------------------------------------------------

  it('cross-company: B cannot read suggestions, LLM-categorize or prefill from A', async () => {
    const txn = await addBankTxn('SHELL OIL 1234', '-41.00', '2026-09-01');
    await expect(suggestBankCategories(ctxB, bankAccountId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(llmSuggestBankCategory(ctxB, txn)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(vendorPrefill(ctxB, { vendorId: vendorShell })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db.delete(bankTransactions).where(eq(bankTransactions.id, txn));
  });

  it('a viewer cannot auto-apply: nothing posts, nothing is logged', async () => {
    await updateSettings(ctx, { autoApplyEnabled: true, autoApplyThreshold: 0.6 });
    const txn = await addBankTxn('SHELL OIL 57444 HOUSTON TX', '-44.00', '2026-09-02');
    const before = await countEntries();
    const res = await autoApplyBankSuggestions(viewerCtx, bankAccountId).catch((e) => ({ applied: [], skipped: [], error: e }));
    expect(res.applied).toHaveLength(0);
    expect(await countEntries()).toBe(before);
    expect((await db.select().from(aiAutoApplied).where(eq(aiAutoApplied.bankTransactionId, txn))).length).toBe(0);
    const [t] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txn));
    expect(t.matched).toBe(false);
  });

  it('auto-apply rolls back per line when posting fails (closed period): no orphan log rows', async () => {
    const [txn] = await db.select().from(bankTransactions).where(and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.matched, false)));
    const [fp] = await db
      .insert(fiscalPeriods)
      .values({ companyId: ctx.companyId, periodStart: new Date('2026-09-01T00:00:00Z'), periodEnd: new Date('2026-09-30T23:59:59Z'), isClosed: true })
      .returning();
    try {
      const sug = await suggestBankCategories(ctx, bankAccountId);
      expect(sug.suggestions.find((s) => s.bankTransactionId === txn.id)?.autoApplyEligible).toBe(true);
      const before = await countEntries();
      const res = await autoApplyBankSuggestions(ctx, bankAccountId);
      expect(res.applied).toHaveLength(0);
      expect(res.skipped.some((s) => s.bankTransactionId === txn.id)).toBe(true);
      expect(await countEntries()).toBe(before);
      expect((await db.select().from(aiAutoApplied).where(eq(aiAutoApplied.bankTransactionId, txn.id))).length).toBe(0);
      const [t] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txn.id));
      expect(t.matched).toBe(false);
    } finally {
      await db.delete(fiscalPeriods).where(eq(fiscalPeriods.id, fp.id));
    }
  });

  it('auto-apply is idempotent: concurrent/re-runs post each bank line once; books balance', async () => {
    const [r1, r2] = await Promise.all([autoApplyBankSuggestions(ctx, bankAccountId), autoApplyBankSuggestions(ctx, bankAccountId)]);
    expect(r1.applied.length + r2.applied.length).toBeGreaterThanOrEqual(1);
    const r3 = await autoApplyBankSuggestions(ctx, bankAccountId);
    expect(r3.applied).toHaveLength(0);
    const logs = await db.select().from(aiAutoApplied).where(eq(aiAutoApplied.companyId, ctx.companyId));
    const perTxn = new Map<string, number>();
    for (const l of logs) perTxn.set(l.bankTransactionId, (perTxn.get(l.bankTransactionId) ?? 0) + 1);
    expect([...perTxn.values()].every((n) => n === 1)).toBe(true);
    for (const l of logs) {
      const jes = await db.select().from(journalEntries).where(eq(journalEntries.sourceRef, `bank_transaction:${l.bankTransactionId}`));
      expect(jes.filter((e) => e.status === 'posted')).toHaveLength(1);
    }
    expect((await trialBalance(ctx)).balanced).toBe(true);
    await updateSettings(ctx, { autoApplyEnabled: false });
  });

  it('suggestions never propose an inactive account or the bank account itself', async () => {
    const txn = await addBankTxn('SHELL OIL 99 DALLAS', '-47.00', '2026-10-01');
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, acct['6000']));
    try {
      const { suggestions } = await suggestBankCategories(ctx, bankAccountId);
      const s = suggestions.find((x) => x.bankTransactionId === txn)!;
      expect(s.accountId).not.toBe(acct['6000']);
      expect(s.accountId).not.toBe(acct['1000']);
      for (const a of s.alternatives) expect([acct['6000'], acct['1000']]).not.toContain(a.accountId);
      const pre = await vendorPrefill(ctx, { vendorId: vendorShell });
      expect(pre.lines.map((l) => l.accountId)).not.toContain(acct['6000']);
    } finally {
      await db.update(accounts).set({ isActive: true }).where(eq(accounts.id, acct['6000']));
    }
  });

  it('LLM categorization: a model insisting on the bank GL / an unknown code yields no account', async () => {
    const [txn] = await db.select().from(bankTransactions).where(and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.matched, false)));
    const m = ollama(() => '{"accountCode":"1000","confidence":1,"reason":"it is the bank"}');
    await expect(llmSuggestBankCategory(ctx, txn.id, { deps: { fetch: m.fetch }, retries: 0, sleep: async () => {} })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(m.calls.filter((c) => c.url.endsWith('/api/chat'))).toHaveLength(2); // one repair, then give up
    const m2 = ollama(() => '{"accountCode":"6000","confidence":7,"reason":"x"}');
    await expect(llmSuggestBankCategory(ctx, txn.id, { deps: { fetch: m2.fetch }, retries: 0 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const [t] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txn.id));
    expect(t.matched).toBe(false);
  });

  it('LLM categorization respects llmSuggestEnabled=false (no model call at all)', async () => {
    const [txn] = await db.select().from(bankTransactions).where(and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.matched, false)));
    await updateSettings(ctx, { llmSuggestEnabled: false });
    const m = ollama(() => '{"accountCode":"6000","confidence":0.5,"reason":"x"}');
    try {
      await expect(llmSuggestBankCategory(ctx, txn.id, { deps: { fetch: m.fetch } })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(m.calls).toHaveLength(0);
    } finally {
      await updateSettings(ctx, { llmSuggestEnabled: true });
    }
  });

  // -------------------------------------------------------------------------
  // Fix-round regressions
  // -------------------------------------------------------------------------

  it('proposal creation is audited; an impossible tool date is rejected, not ignored', async () => {
    const p = await createJournalProposal(ctx, { date: '2026-09-30', description: 'audited', lines: goodLines });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, p.id), eq(auditLogs.action, 'create')));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityType).toBe('ai_proposal');
    await rejectProposal(ctx, p.id);
    await expect(runTool(ctx, 'profit_and_loss', { from: '2026-02-30' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('Test Connection never sends a saved API key to a different base URL', async () => {
    const cur = await getPublicSettings(ctx);
    const keep = cur.providers.map((p) => ({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled }));
    const s = await updateSettings(ctx, {
      providers: [...keep, { kind: 'openai-compatible', label: 'vLLM', baseUrl: 'http://10.0.0.5:8000', model: 'm', apiKey: 'sk-QA-SAVED-KEY', enabled: false }],
    });
    const saved = s.providers.find((p) => p.label === 'vLLM')!;
    const seen: { url: string; auth: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      const h = new Headers(init?.headers as HeadersInit);
      seen.push({ url, auth: h.get('authorization') ?? '' });
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
    };
    try {
      // Default network policy (tailnet-only): the public host is never contacted at all.
      const blocked = await testConnection(ctx, { id: saved.id, kind: 'openai-compatible', label: 'vLLM', baseUrl: 'http://evil.example.com', model: 'm', enabled: true }, { fetch });
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toMatch(/network policy/i);
      expect(seen).toHaveLength(0);
      // Even with cloud AI allowed by the network policy, the saved key stays with its own host.
      await setNetworkPolicy(ctx, { mode: 'allow-cloud', cloudOptIn: { ai: true } });
      await testConnection(ctx, { id: saved.id, kind: 'openai-compatible', label: 'vLLM', baseUrl: 'http://evil.example.com', model: 'm', enabled: true }, { fetch });
      expect(seen.length).toBeGreaterThan(0);
      expect(JSON.stringify(seen)).not.toContain('QA-SAVED-KEY');
      seen.length = 0;
      await testConnection(ctx, { id: saved.id, kind: 'openai-compatible', label: 'vLLM', baseUrl: 'http://10.0.0.5:8000/', model: 'm', enabled: true }, { fetch });
      expect(seen.some((c) => c.auth === 'Bearer sk-QA-SAVED-KEY')).toBe(true);
      // Saving the provider re-pointed at another host drops the stored key.
      const moved = await updateSettings(ctx, {
        providers: [...keep, { id: saved.id, kind: 'openai-compatible', label: 'vLLM', baseUrl: 'http://evil.example.com', model: 'm', enabled: false }],
      });
      expect(moved.providers.find((p) => p.id === saved.id)!.hasApiKey).toBe(false);
    } finally {
      await setNetworkPolicy(ctx, { mode: 'tailnet-only' });
      await updateSettings(ctx, { providers: keep });
    }
  });

  // -------------------------------------------------------------------------
  // Re-test round 1 (tester): probing the fix-round changes
  // -------------------------------------------------------------------------

  it('round2: a viewer calling createJournalProposal directly is FORBIDDEN and stores nothing', async () => {
    const before = await countProposals();
    await expect(
      createJournalProposal(viewerCtx, { date: '2026-09-30', description: 'viewer direct', lines: goodLines }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await countProposals()).toBe(before);
  });

  it('round2: a viewer is told the proposal was not saved; no audit row is written for it', async () => {
    const m = ollama(() =>
      JSON.stringify({ action: 'answer', answer: 'Prepared.', proposal: { type: 'journal_entry', date: '2026-09-30', description: 'viewer write 2', lines: goodLines } }),
    );
    const auditsBefore = (await db.select().from(auditLogs).where(eq(auditLogs.entityType, 'ai_proposal'))).length;
    const r = await ask(viewerCtx, [], 'Record $150 of supplies', { deps: { fetch: m.fetch } });
    expect(r.proposals).toHaveLength(0);
    expect(r.answer).toMatch(/view-only/i);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.entityType, 'ai_proposal'))).length).toBe(auditsBefore);
  });

  it('round2: approval of a proposal whose account was deleted fails cleanly and stays pending', async () => {
    const tmp = await createAccount(ctx, { code: '6950', name: 'Temp Expense', type: 'expense' as never, subtype: 'operating_expenses' });
    const p = await createJournalProposal(ctx, {
      date: '2026-09-30',
      description: 'temp',
      lines: [{ accountCode: '6950', debit: '10.00' }, { accountCode: '2000', credit: '10.00' }],
    });
    await db.delete(accounts).where(eq(accounts.id, tmp.id));
    const before = await countEntries();
    await expect(approveProposal(ctx, p.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countEntries()).toBe(before);
    const [row] = await db.select().from(aiProposals).where(eq(aiProposals.id, p.id));
    expect(row.status).toBe('pending');
    await rejectProposal(ctx, p.id);
  });

  it("round2: a tampered stored payload pointing at another company's account is not posted", async () => {
    const [bAcct] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctxB.companyId), eq(accounts.code, '7777')));
    const p = await createJournalProposal(ctx, { date: '2026-09-30', description: 'tamper', lines: goodLines });
    const [row] = await db.select().from(aiProposals).where(eq(aiProposals.id, p.id));
    const payload = row.payload as any;
    payload.lines[0].accountId = bAcct.id;
    await db.update(aiProposals).set({ payload }).where(eq(aiProposals.id, p.id));
    const before = await countEntries();
    const beforeB = await countEntries(ctxB.companyId);
    await expect(approveProposal(ctx, p.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countEntries()).toBe(before);
    expect(await countEntries(ctxB.companyId)).toBe(beforeB);
    await rejectProposal(ctx, p.id);
  });

  it('round2: a tampered stored impossible date is rejected at approval (no rollover posting)', async () => {
    const p = await createJournalProposal(ctx, { date: '2026-09-30', description: 'date tamper', lines: goodLines });
    const [row] = await db.select().from(aiProposals).where(eq(aiProposals.id, p.id));
    await db.update(aiProposals).set({ payload: { ...(row.payload as any), date: '2026-02-30' } }).where(eq(aiProposals.id, p.id));
    const before = await countEntries();
    await expect(approveProposal(ctx, p.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countEntries()).toBe(before);
    await rejectProposal(ctx, p.id);
  });

  it('round2: impossible dates (Feb 29 non-leap, month 13, Apr 31, month 00) are rejected at creation', async () => {
    const before = await countProposals();
    for (const date of ['2026-02-29', '2026-13-01', '2026-04-31', '2026-00-10']) {
      await expect(createJournalProposal(ctx, { date, description: 'bad date', lines: goodLines })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(await countProposals()).toBe(before);
    // Leap day in a leap year is fine.
    const ok = await createJournalProposal(ctx, { date: '2028-02-29', description: 'leap', lines: goodLines });
    await rejectProposal(ctx, ok.id);
  });

  it('round2: an approved 3-line proposal posts once and keeps the trial balance balanced', async () => {
    const p = await createJournalProposal(ctx, {
      date: '2026-09-30',
      description: 'split',
      lines: [
        { accountCode: '6200', debit: '33.33' },
        { accountCode: '6400', debit: '33.34' },
        { accountCode: '2000', credit: '66.67', name: 'Shell Oil' },
      ],
    });
    const before = await countEntries();
    const v = await approveProposal(ctx, p.id);
    expect(v.status).toBe('approved');
    expect(await countEntries()).toBe(before + 1);
    expect((await trialBalance(ctx)).balanced).toBe(true);
    await expect(approveProposal(ctx, p.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await countEntries()).toBe(before + 1);
  });

  it('round2: the saved key survives a cosmetic base-URL edit but not a kind change', async () => {
    const cur = await getPublicSettings(ctx);
    const keep = cur.providers.map((p) => ({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled }));
    const s = await updateSettings(ctx, {
      providers: [...keep, { kind: 'openai-compatible', label: 'LM', baseUrl: 'http://10.0.0.9:1234', model: 'm', apiKey: 'sk-QA-ROUND2', enabled: false }],
    });
    const saved = s.providers.find((p) => p.label === 'LM')!;
    try {
      const cosmetic = await updateSettings(ctx, {
        providers: [...keep, { id: saved.id, kind: 'openai-compatible', label: 'LM', baseUrl: 'http://10.0.0.9:1234/', model: 'm', enabled: false }],
      });
      expect(cosmetic.providers.find((p) => p.id === saved.id)!.hasApiKey).toBe(true);
      const kindChanged = await updateSettings(ctx, {
        providers: [...keep, { id: saved.id, kind: 'ollama', label: 'LM', baseUrl: 'http://10.0.0.9:1234/', model: 'm', enabled: false }],
      });
      expect(kindChanged.providers.find((p) => p.id === saved.id)!.hasApiKey).toBe(false);
    } finally {
      await updateSettings(ctx, { providers: keep });
    }
  });
});
