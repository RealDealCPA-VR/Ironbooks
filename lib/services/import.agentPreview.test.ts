/**
 * A bank import's auto-posting (lib/services/import.ts) loads the AI settings, and loading them
 * looks the saved *.ts.net AI addresses up in DNS. An agent's import only stages the lines (as the
 * agent's statement import does), and no rolled-back preview loads the settings: so an agent's dry
 * run and its real run do the same thing, and neither makes a name lookup. A person's import
 * auto-posts exactly as before.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const calls = vi.hoisted(() => ({ loadSettings: 0, autoApply: 0 }));
vi.mock('./aiSettings', async (orig) => {
  const real = await orig<typeof import('./aiSettings')>();
  return {
    ...real,
    loadSettings: async (...args: Parameters<typeof real.loadSettings>) => {
      calls.loadSettings += 1;
      return real.loadSettings(...args);
    },
  };
});
vi.mock('./aiCategorizer', async (orig) => ({
  ...(await orig<typeof import('./aiCategorizer')>()),
  autoApplyBankSuggestions: async () => {
    calls.autoApply += 1;
    return { applied: [], skipped: [] };
  },
}));

const { bankAccounts, bankTransactions } = await import('@/lib/db/schema');
const { runWithEffects } = await import('@/lib/effects');
const { importTransactions } = await import('./import');
const { makeTestCompany } = await import('./testkit.prefs');
type TestCompany = Awaited<ReturnType<typeof makeTestCompany>>;

const AGENT = { id: '00000000-0000-4000-8000-0000000000d5', name: 'Bank agent', mode: 'post' as const };

let t: TestCompany;
let bankAccountId: string;
let n = 0;

/** One new line each time, so every import really brings a line in. */
const lines = () => {
  n += 1;
  return { bankAccountId, fileType: 'rows' as const, content: '', rows: [{ date: '2026-03-05', description: `Line ${n}`, amount: `-${n}.00` }] };
};
const reset = () => {
  calls.loadSettings = 0;
  calls.autoApply = 0;
};

beforeAll(async () => {
  t = await makeTestCompany('import-agent-preview');
  const [ba] = await t.db
    .insert(bankAccounts)
    .values({ companyId: t.ctx.companyId, accountId: t.acct['1000'], bankName: 'Preview Bank', accountNumber: '000111222' })
    .returning();
  bankAccountId = ba.id;
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('auto-posting after a bank import', () => {
  it("a person's import loads the settings and auto-posts as before (on by default for a new company)", async () => {
    reset();
    expect((await importTransactions(t.ctx, lines())).imported).toBe(1);
    expect(calls.loadSettings).toBeGreaterThan(0);
    expect(calls.autoApply).toBe(1);
  });

  it("an agent's import only stages the lines: in its preview and in its real run", async () => {
    reset();
    const before = (await t.db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, bankAccountId))).length;
    const agentCtx = { ...t.ctx, agent: AGENT };
    const preview = await runWithEffects('capture', () => importTransactions(agentCtx, lines()));
    expect(preview.value.imported).toBe(1);
    const real = await runWithEffects('defer', () => importTransactions(agentCtx, lines()));
    expect(real.value).toMatchObject({ imported: 1 });
    expect(real.value).not.toHaveProperty('autoPosted');
    expect(await importTransactions(agentCtx, lines())).toMatchObject({ imported: 1 });
    expect(calls).toEqual({ loadSettings: 0, autoApply: 0 });
    const after = (await t.db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, bankAccountId))).length;
    expect(after).toBe(before + 3);
  });

  it('no rolled-back preview loads the settings, whoever runs it; skipAutoPost still leaves every line', async () => {
    reset();
    await runWithEffects('capture', () => importTransactions(t.ctx, lines()));
    await importTransactions(t.ctx, { ...lines(), skipAutoPost: true });
    expect(calls).toEqual({ loadSettings: 0, autoApply: 0 });
  });
});
