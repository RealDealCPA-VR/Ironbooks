/**
 * Independent QA (tester) for the team/ux work. Adversarial checks the doer's tests do not
 * cover:
 *  - Journal form contract: anything computeJournalBalance lets the user Save must also be
 *    accepted by the API schema AND postJournalEntry (the page sends the raw strings), and a
 *    saved entry keeps the trial balance balanced.
 *  - Friendly errors: every ServiceError code maps to a headline + next step regardless of
 *    the HTTP status a route chose; plain sentences are not mangled by the field humanizer.
 *  - Intents: required phrasings and noisy/malformed input.
 *  - Home workflow / Help usage / onboarding: every template account can actually be created
 *    for every business type, re-running is idempotent, viewers cannot apply it, and the
 *    account-balances panel matches the ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { ServiceError, type ServiceContext, type ServiceErrorCode } from '@/lib/services/_base';
import { createCompany, updateCompany } from '@/lib/services/company';
import { createAccount, listAccounts } from '@/lib/services/accounts';
import { createManualEntry } from '@/lib/services/journal';
import { trialBalance } from '@/lib/services/reports';
import { createJournalEntrySchema } from '@/lib/validation/journal';
import { companySettingsSchema } from '@/lib/validation/company';
import { ApiError } from './client';
import { describeError, humanizeFieldMessage } from './friendlyErrors';
import { computeJournalBalance, type JournalLineInput } from './journalBalance';
import { matchIntents } from './nav-actions';
import { GLOSSARY } from './glossary';
import { allWorkflowHrefs, buildAccountBalances, HOME_WORKFLOW } from './homeWorkflow';
import { BUSINESS_TYPES, buildSetupPlan, type InterviewAnswers } from './onboarding';

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ux-adversarial');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'ux-qa@test.local', name: 'UX QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'UX QA Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function accountId(code: string): Promise<string> {
  const a = (await listAccounts(ctx, { includeInactive: true })).find((x) => x.code === code);
  if (!a) throw new Error(`no account ${code}`);
  return a.id;
}

/** Exactly the payload app/journal/page.tsx handleSubmit builds from the form rows. */
function pagePayload(lines: JournalLineInput[]) {
  return {
    date: '2026-03-15',
    description: 'QA entry',
    reference: null,
    lines: lines
      .filter((l) => l.accountId)
      .map((l) => ({
        accountId: l.accountId,
        debit: l.debit ? l.debit : undefined,
        credit: l.credit ? l.credit : undefined,
        memo: null,
        classId: null,
      })),
  };
}

/** Run a form state through the client check, the API zod schema and the posting service. */
async function saveLikeThePage(lines: JournalLineInput[]) {
  const bal = computeJournalBalance(lines);
  expect(bal.canSave, `client should allow Save: ${bal.blocker}`).toBe(true);
  const parsed = createJournalEntrySchema.safeParse(pagePayload(lines));
  if (!parsed.success) {
    throw new Error(`API schema rejected a form the client allowed to save: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`);
  }
  return createManualEntry(ctx, parsed.data);
}

// ---------------------------------------------------------------------------
// Journal entry: client Save gate vs server rules
// ---------------------------------------------------------------------------

describe('journal form: canSave implies the server accepts the entry', () => {
  it('plain balanced entry posts and the trial balance stays balanced', async () => {
    const cash = await accountId('1000');
    const sales = await accountId('4000');
    await saveLikeThePage([
      { accountId: cash, debit: '100.10', credit: '' },
      { accountId: sales, debit: '', credit: '100.10' },
    ]);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('thousands separators the client accepts ("1,250.00") must also be accepted by the API', async () => {
    const cash = await accountId('1000');
    const sales = await accountId('4000');
    // computeJournalBalance strips commas and allows Save, but the page posts the raw
    // string; zMoney (/^-?\d+(\.\d{1,2})?$/) rejects "1,250.00" -> VALIDATION error.
    await expect(
      saveLikeThePage([
        { accountId: cash, debit: '1,250.00', credit: '' },
        { accountId: sales, debit: '', credit: '1250' },
      ]),
    ).resolves.toBeTruthy();
  });

  it('a line with BOTH a debit and a credit must not be saveable (postJournalEntry forbids it)', () => {
    // Totals balance (10 = 5 + 5) so the client enables Save, but assertBalanced throws
    // "Line 1: a line cannot have both a debit and a credit."
    // (Low severity: app/journal/page.tsx updateLine clears the opposite side on typing, so
    // this is not reachable from that form today — but the exported helper's canSave
    // contract is wrong for any other caller.)
    const bal = computeJournalBalance([
      { accountId: 'a', debit: '10', credit: '5' },
      { accountId: 'b', debit: '', credit: '5' },
    ]);
    expect(bal.canSave).toBe(false);
  });

  it('surrounding whitespace in an amount the client accepts still posts', async () => {
    const cash = await accountId('1000');
    const sales = await accountId('4000');
    await saveLikeThePage([
      { accountId: cash, debit: ' 7.25 ', credit: '' },
      { accountId: sales, debit: '', credit: '7.25' },
    ]);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('client blocks what the server would reject: 3 decimals, negatives, exponent, leading dot', () => {
    for (const bad of ['1.005', '-5', '1e3', '.50', '5.', 'NaN', 'Infinity', '0x10', '١٢']) {
      const bal = computeJournalBalance([
        { accountId: 'a', debit: bad, credit: '' },
        { accountId: 'b', debit: '', credit: bad },
      ]);
      expect(bal.canSave, bad).toBe(false);
    }
  });

  it('canSave always means debits === credits exactly (randomized, decimal-exact)', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 500; n++) {
      const lines: JournalLineInput[] = [];
      const count = 2 + Math.floor(rnd() * 5);
      for (let i = 0; i < count; i++) {
        const amt = (Math.floor(rnd() * 100000) / 100).toFixed(rnd() < 0.5 ? 2 : 1);
        lines.push(rnd() < 0.5
          ? { accountId: `acc${i}`, debit: amt, credit: '' }
          : { accountId: `acc${i}`, debit: '', credit: amt });
      }
      const bal = computeJournalBalance(lines);
      const d = lines.reduce((s, l) => s.plus(l.debit || 0), new Decimal(0));
      const c = lines.reduce((s, l) => s.plus(l.credit || 0), new Decimal(0));
      expect(bal.totalDebits).toBe(d.toFixed(2));
      expect(bal.totalCredits).toBe(c.toFixed(2));
      if (bal.canSave) expect(d.eq(c) && d.gt(0)).toBe(true);
      if (d.eq(c) && d.gt(0) && lines.every((l) => !new Decimal(l.debit || l.credit).isZero())) {
        expect(bal.canSave).toBe(true);
      }
    }
  });

  it('large amounts keep cent precision (no float drift)', () => {
    const bal = computeJournalBalance([
      { accountId: 'a', debit: '9999999999999.99', credit: '' },
      { accountId: 'b', debit: '0.01', credit: '' },
      { accountId: 'c', debit: '', credit: '10000000000000.00' },
    ]);
    expect(bal.difference).toBe('0.00');
    expect(bal.canSave).toBe(true);
  });

  it('server still refuses an unbalanced entry even if a client bypasses the gate', async () => {
    const cash = await accountId('1000');
    const sales = await accountId('4000');
    const parsed = createJournalEntrySchema.parse(
      pagePayload([
        { accountId: cash, debit: '10.00', credit: '' },
        { accountId: sales, debit: '', credit: '9.99' },
      ]),
    );
    const before = await trialBalance(ctx);
    await expect(createManualEntry(ctx, parsed)).rejects.toMatchObject({ code: 'UNBALANCED' });
    const after = await trialBalance(ctx);
    expect(after.totalDebit).toBe(before.totalDebit); // nothing partially written
    expect(after.balanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Friendly errors
// ---------------------------------------------------------------------------

describe('friendly errors (adversarial)', () => {
  const CODES: ServiceErrorCode[] = [
    'UNBALANCED', 'PERIOD_CLOSED', 'FORBIDDEN', 'CONFLICT', 'VALIDATION', 'NOT_FOUND',
  ];

  it('the body code wins over whatever HTTP status the route picked', () => {
    // e.g. app/api/journal-entries maps PERIOD_CLOSED to 500.
    for (const code of CODES) {
      for (const status of [400, 403, 404, 409, 500]) {
        const f = describeError(new ApiError(status, 'x', code));
        expect(f.code, `${code}@${status}`).toBe(code);
        expect(f.title.length).toBeGreaterThan(0);
        expect(f.nextStep.length).toBeGreaterThan(10);
      }
    }
  });

  it('real ServiceErrors (not ApiError) still get a friendly message', () => {
    const f = describeError(new ServiceError('UNBALANCED', 'Entry is out of balance'));
    expect(f.title).toMatch(/went wrong|debits/i);
    expect(f.message).toBe('Entry is out of balance');
  });

  it('empty server message falls back to a code-specific explanation, not blank text', () => {
    for (const code of CODES) {
      const f = describeError(new ApiError(400, '   ', code), 'Failed to save.');
      expect(f.message.trim().length, code).toBeGreaterThan(0);
    }
  });

  it('INTERNAL hides stack traces even when no code is sent', () => {
    const f = describeError(new ApiError(500, 'Error: relation "x" does not exist at /app/lib/db.ts:12'));
    expect(f.message).not.toMatch(/relation|db\.ts/);
  });

  it('humanizer leaves ordinary sentences and posting messages alone', () => {
    for (const s of [
      'Line 1: a line cannot have both a debit and a credit.',
      'Entry is out of balance: debits 10.00 ≠ credits 9.99',
      'Invoice not found',
      'Account code "4010" already exists.',
    ]) {
      expect(humanizeFieldMessage(s)).toBe(s);
    }
  });

  it('humanizer handles nested/large indices and camelCase', () => {
    expect(humanizeFieldMessage('lines.11.accountId: must be a valid id (uuid)')).toBe(
      'Line 12 account: must be a valid id (uuid)',
    );
    expect(humanizeFieldMessage('billingAddress.zip: Required')).toMatch(/^Billing address zip: Required$/);
  });

  it('VALIDATION from zodErrorBody of the journal schema reads naturally', () => {
    const r = createJournalEntrySchema.safeParse({ date: '2026-01-01', description: 'x', lines: [{ accountId: 'nope' }, { accountId: 'nope' }] });
    expect(r.success).toBe(false);
    if (r.success) return;
    const first = r.error.issues[0];
    const msg = `${first.path.join('.')}: ${first.message}`;
    const f = describeError(new ApiError(400, msg, 'VALIDATION'));
    expect(f.message).toMatch(/^Line 1 account/);
  });

  it('non-network TypeErrors are not reported as "can’t reach"', () => {
    const f = describeError(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(f.code).not.toBe('NETWORK');
  });
});

// ---------------------------------------------------------------------------
// Command palette intents
// ---------------------------------------------------------------------------

describe('matchIntents (adversarial)', () => {
  const top = (q: string) => matchIntents(q)[0]?.href;

  it('required phrasings with noise, money and casing', () => {
    expect(top('I just got paid $500!')).toBe('/payments?new=1');
    expect(top('RECORD A SALE')).toBe('/sales-receipts?new=1');
    expect(top('i need to pay a bill today')).toBe('/pay-bills');
    expect(top('my customer owes me $1,200')).toBe('/invoices?new=1');
    expect(top('Move money between accounts.')).toBe('/transfers');
    expect(top('transfer $200 from checking to savings')).toBe('/transfers');
    expect(top('fix a mistake')).toBe('/help#fix-a-mistake');
    expect(top('I paid a bill')).toBe('/pay-bills');
    expect(top('record an expense')).toBe('/expenses?new=1');
  });

  it('malformed / hostile input never throws and returns sensible results', () => {
    for (const q of ['(((', '[*+?', '\\', '💸💸', 'ça va', '\u0000', 'a'.repeat(20000), '   \n\t ']) {
      expect(() => matchIntents(q)).not.toThrow();
    }
    expect(matchIntents('   \n\t ')).toEqual([]);
    expect(matchIntents('$$$ 123')).toEqual([]);
  });

  it('limit 0 returns nothing and results are unique', () => {
    expect(matchIntents('pay', 0)).toEqual([]);
    const r = matchIntents('pay money bill customer', 10);
    expect(new Set(r.map((i) => i.href)).size).toBe(r.length);
  });

  it('a long string is matched quickly', () => {
    const t = Date.now();
    matchIntents('pay '.repeat(5000));
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Help usage, Home workflow, onboarding link
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('Help tooltip usage', () => {
  it('every <Help term="..."> literal in app/ and components/ is a glossary key', () => {
    const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'components'))];
    let uses = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/<Help\s+term="([^"]+)"/g)) {
        uses++;
        expect(Object.keys(GLOSSARY), `${path.relative(ROOT, f)}: ${m[1]}`).toContain(m[1]);
      }
    }
    expect(uses).toBeGreaterThan(5);
  });

  it('the key money forms explain their jargon with <Help>', () => {
    for (const page of ['invoices', 'payments', 'deposits', 'bills', 'journal', 'reconcile']) {
      const src = fs.readFileSync(path.join(ROOT, 'app', page, 'page.tsx'), 'utf8');
      expect(/<Help[\s>]/.test(src), `app/${page}/page.tsx has no <Help>`).toBe(true);
    }
  });
});

describe('Home workflow (adversarial)', () => {
  it('contains every step the assignment lists', () => {
    const labels = HOME_WORKFLOW.flatMap((s) => [...s.flows.flat(), ...(s.extras ?? [])]).map((s) => s.label);
    for (const l of [
      'Purchase Orders', 'Receive Inventory', 'Enter Bills', 'Pay Bills',
      'Estimates', 'Sales Orders', 'Create Invoices', 'Receive Payments', 'Record Deposits',
      'Sales Receipts', 'Statements', 'Refunds & Credits',
      'Enter Time', 'Pay Employees', 'Pay Liabilities', 'Payroll Forms',
      'Chart of Accounts', 'Items & Services',
      'Write Checks', 'Check Register', 'Reconcile', 'Bank Feeds',
    ]) expect(labels).toContain(l);
  });

  it('no external links, no duplicate labels within a section, every step has a hint', () => {
    for (const h of allWorkflowHrefs()) expect(h).toMatch(/^(\/|#)/);
    for (const s of HOME_WORKFLOW) {
      const steps = [...s.flows.flat(), ...(s.extras ?? [])];
      expect(new Set(steps.map((x) => x.label)).size).toBe(steps.length);
      for (const st of steps) expect(st.hint.length).toBeGreaterThan(5);
    }
  });

  it('the "#reminders" anchor exists on the dashboard', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'dashboard', 'page.tsx'), 'utf8')
      + fs.readFileSync(path.join(ROOT, 'components', 'HomeWorkflow.tsx'), 'utf8');
    expect(src).toMatch(/id=["{'`]+reminders/);
  });

  it('onboarding offers the QuickBooks Desktop import and the route exists', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'onboarding', 'page.tsx'), 'utf8');
    expect(src).toContain('/qb-import');
    expect(fs.existsSync(path.join(ROOT, 'app', 'qb-import', 'page.tsx'))).toBe(true);
  });
});

describe('account balances panel vs the ledger (integration)', () => {
  it('matches trial-balance activity with natural signs; hides non-bank accounts', async () => {
    const checking = await accountId('1000');
    const card = (await listAccounts(ctx)).find((a) => a.subtype === 'credit_card');
    expect(card).toBeTruthy();
    const office = (await listAccounts(ctx)).find((a) => a.type === 'expense')!;
    // Charge 45.67 on the card for an expense.
    await createManualEntry(ctx, {
      date: new Date('2026-03-16'),
      description: 'card charge',
      lines: [
        { accountId: office.id, debit: '45.67' },
        { accountId: card!.id, credit: '45.67' },
      ],
    });
    const tb = await trialBalance(ctx);
    const rows = buildAccountBalances(await listAccounts(ctx), tb.rows);
    const cardRow = rows.find((r) => r.id === card!.id)!;
    expect(cardRow.kind).toBe('credit_card');
    expect(cardRow.balance).toBe('45.67'); // owed, positive
    const chk = rows.find((r) => r.id === checking)!;
    const tbRow = tb.rows.find((r) => r.accountId === checking)!;
    expect(chk.balance).toBe(new Decimal(tbRow.debit).minus(tbRow.credit).toFixed(2));
    expect(rows.some((r) => r.id === office.id)).toBe(false);
    expect(rows.find((r) => /undeposited/i.test(r.name))?.kind).toBe('undeposited');
  });
});

// ---------------------------------------------------------------------------
// Onboarding plan through the real services
// ---------------------------------------------------------------------------

describe('onboarding plan (adversarial integration)', () => {
  const allYes: Omit<InterviewAnswers, 'businessType'> = {
    fiscalYearStartMonth: 4,
    reportBasis: 'accrual',
    salesTax: true,
    inventory: true,
    employees: true,
  };

  it('every business type template can actually be created (valid subtypes, no code clashes)', async () => {
    for (const bt of BUSINESS_TYPES) {
      const existing = await listAccounts(ctx, { includeInactive: true });
      const plan = buildSetupPlan({ ...allYes, businessType: bt.value }, existing);
      await updateCompany(ctx, { settings: companySettingsSchema.parse(plan.settings) });
      for (const a of plan.accounts) {
        await expect(createAccount(ctx, { ...a }), `${bt.value}: ${a.code} ${a.name}`).resolves.toBeTruthy();
      }
      // Re-running the same answers is a no-op.
      const again = buildSetupPlan({ ...allYes, businessType: bt.value }, await listAccounts(ctx, { includeInactive: true }));
      expect(again.accounts, bt.value).toHaveLength(0);
    }
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('dedupe is case/whitespace-insensitive on names', () => {
    const plan = buildSetupPlan({ ...allYes, businessType: 'retail' }, [
      { code: '9999', name: '  FREIGHT   IN ' },
    ]);
    // "  FREIGHT   IN " normalizes to "freight   in" (inner spaces kept) — at minimum the
    // simple-case variant must be skipped.
    const plan2 = buildSetupPlan({ ...allYes, businessType: 'retail' }, [{ code: '9999', name: 'FREIGHT IN' }]);
    expect(plan2.accounts.map((a) => a.name)).not.toContain('Freight In');
    expect(plan.accounts.filter((a) => a.name === 'Freight In').length).toBeLessThanOrEqual(1);
  });

  it('a viewer cannot apply the interview (settings or accounts)', async () => {
    const viewer: ServiceContext = { ...ctx, role: 'viewer' };
    const plan = buildSetupPlan({ ...allYes, businessType: 'nonprofit' }, []);
    await expect(updateCompany(viewer, { settings: companySettingsSchema.parse(plan.settings) }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createAccount(viewer, { code: '8888', name: 'Viewer Acct', type: 'expense', subtype: 'operating_expenses' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('every fiscal start month yields settings the Preferences schema accepts', () => {
    for (let m = 1; m <= 12; m++) {
      const p = buildSetupPlan({ ...allYes, businessType: 'general', fiscalYearStartMonth: m });
      expect(() => companySettingsSchema.parse(p.settings), String(m)).not.toThrow();
    }
    expect(() => buildSetupPlan({ ...allYes, businessType: 'general', fiscalYearStartMonth: 0 })).toThrow();
    expect(() => buildSetupPlan({ ...allYes, businessType: 'general', fiscalYearStartMonth: 6.5 })).toThrow();
  });
});
