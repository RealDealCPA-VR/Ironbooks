/**
 * Command bar (Ctrl+K) — the plain-English command engine.
 *
 *   text ──► deterministic grammar (lib/commands/grammar.ts) ──► CommandIntent ──► executor
 *        └─► (only when the grammar recognizes nothing AND the company has AI configured)
 *            AI router (lib/ai/router.ts, task 'assistant': same local/cloud policy, network
 *            policy and redaction as every other AI feature) ──► zod-validated CommandIntent ──┘
 *
 * The executor is the same for both paths and is READ-ONLY: it matches names against the
 * company's lists (customers, vendors, items, accounts, bank accounts), and returns
 *   - 'prefill'  — a new form filled in for the user to review and SAVE (nothing is posted here),
 *   - 'navigate' — a page or a filtered report,
 *   - 'answer'   — a number computed from the posted general ledger, with a link to the report,
 *   - 'choose'   — the command was ambiguous; each option re-runs with the user's pick,
 *   - 'denied' / 'unknown'.
 * Every query is scoped by ctx.companyId; ids chosen by the user (hints) are re-checked against
 * the company. Results respect the caller's permissions (Users & Roles), like the sidebar.
 */
import { and, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  accounts,
  bankAccounts,
  bills,
  companies,
  creditMemos,
  customers,
  expenses,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  salesReceipts,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import type Decimal from 'decimal.js';
import { Money, formatCurrency, toAmountString } from '@/lib/money';
import { can, type Action, type Area } from '@/lib/permissions/model';
import { searchPages } from '@/lib/nav';
import { AiError } from '@/lib/ai/types';
import { parseCommand, cleanCommand } from '@/lib/commands/grammar';
import {
  fiscalStartMonthFromYearEnd,
  parseDateRange,
  todayStr,
  yearToDate,
  type DateRange,
  type DateRangeOptions,
} from '@/lib/commands/dates';
import {
  ACTION_TITLES,
  FORM_LABELS,
  aiIntentReplySchema,
  commandIntentSchema,
  describeIntent,
  isSalesForm,
  negativeMessage,
  negativeTokens,
  type ActionIntent,
  type CommandIntent,
  type CreateIntent,
  type FormKind,
  type IntentLine,
  type NavigateIntent,
  type QuestionIntent,
  type ReportIntent,
  type ResolveHints,
} from '@/lib/commands/intent';
import { pickName, type NameCandidate } from '@/lib/commands/match';
import { PREFILL_PATHS, formPrefillSchema, type FormPrefill, type PrefillLine } from '@/lib/commands/prefill';
import { ACTION_HREFS, ACTION_NEEDS, COMMAND_ACTIONS, canDoAction, canOpenHref } from '@/lib/commands/actions';
import { type ServiceContext, validation } from './_base';
import { buildRouter, type BuildRouterOptions } from './aiSettings';
import { companyToday } from './preferences';
import { notFiscalCloseEntry, profitAndLoss } from './reports';
import { unpaidBillsDetail } from './reportsLists';
import { openInvoicesReport } from './reportsAging';
import type { StdReport } from '@/lib/reports/types';

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface ChooseOption {
  label: string;
  description?: string;
  /** Re-run with this intent and these hints when picked. */
  intent: CommandIntent;
  hints?: ResolveHints;
}

export type CommandOutcome =
  | { type: 'prefill'; form: FormPrefill['kind']; href: string; title: string; summary: string; notes: string[]; prefill: FormPrefill }
  | { type: 'navigate'; href: string; title: string; summary?: string; notes?: string[] }
  | {
      type: 'answer';
      title: string;
      answer: string;
      amount: string;
      range: DateRange;
      breakdown: { label: string; amount: string }[];
      href: string | null;
      linkLabel: string;
      notes?: string[];
    }
  | { type: 'choose'; question: string; options: ChooseOption[] }
  | { type: 'denied'; message: string }
  | { type: 'unknown'; message: string; examples: string[] };

export type CommandResult = CommandOutcome & {
  /** Who understood the command. 'choice' = the user picked from a "Which one?" list. */
  source: 'grammar' | 'ai' | 'choice' | 'none';
  /** The intent that ran (absent for 'unknown'). */
  intent?: CommandIntent;
  /** One-line description of the intent, for the UI. */
  understood?: string;
  /** Whether a fuzzy AI fallback is configured for this company. */
  aiAvailable?: boolean;
  /** Provider that interpreted the command (AI path only) and whether the text was redacted. */
  ai?: { providerId: string; locality: string; redacted: boolean };
};

export interface RunCommandInput {
  text?: string;
  /** A previously returned intent (from a 'choose' option). */
  intent?: CommandIntent;
  hints?: ResolveHints;
  /** Ask the AI when the grammar does not recognize the text (only if AI is configured). */
  allowAi?: boolean;
}

export interface RunCommandOptions extends BuildRouterOptions {
  today?: Date;
}

export const EXAMPLES = [
  'invoice Acme 3 hours consulting',
  'bill from Staples 120 office supplies',
  'show unpaid bills over 60 days',
  'what did we spend on fuel in Q3',
  'reconcile checking',
  'go to chart of accounts',
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runCommand(
  ctx: ServiceContext,
  input: RunCommandInput,
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  // The company's calendar day (its time zone), not the UTC one — see companyToday.
  const today = opts.today ?? (await companyToday(ctx));
  if (input.intent) {
    const parsed = commandIntentSchema.safeParse(input.intent);
    if (!parsed.success) throw validation('That choice is no longer valid. Type the command again.');
    return withMeta(await executeIntent(ctx, parsed.data, input.hints ?? {}, today), 'choice', parsed.data);
  }
  const text = cleanCommand(input.text ?? '');
  if (!text) throw validation('Type what you want to do.');
  if (text.length > 500) throw validation('That is too long for a command — keep it under 500 characters.');

  const dateOpts = await dateOptsFor(ctx);
  const intent = parseCommand(text, today, dateOpts);
  if (intent) return withMeta(await executeIntent(ctx, intent, input.hints ?? {}, today), 'grammar', intent);

  // Fuzzy fallback: only when asked, only when this company has an eligible AI model.
  let aiAvailable = false;
  if (input.allowAi) {
    const router = await buildRouter(ctx, { deps: opts.deps, sleep: opts.sleep, retries: opts.retries });
    aiAvailable = router.isAvailable('assistant');
    if (aiAvailable) {
      try {
        const res = await router.chatJson('assistant', aiMessages(text, today, dateOpts), aiIntentReplySchema);
        if (res.data.intent) {
          const aiIntent = serverPeriod(res.data.intent, today, dateOpts);
          const out = await executeIntent(ctx, aiIntent, {}, today);
          return {
            ...withMeta(out, 'ai', aiIntent),
            aiAvailable,
            ai: { providerId: res.providerId, locality: res.locality, redacted: res.redacted },
          };
        }
      } catch (err) {
        if (!(err instanceof AiError)) throw err;
        return {
          type: 'unknown',
          message: `I couldn't work that out, and the AI model didn't help (${err.message}). Try one of these:`,
          examples: EXAMPLES,
          source: 'none',
          aiAvailable,
        };
      }
    }
  } else {
    aiAvailable = (await buildRouter(ctx, { deps: opts.deps })).isAvailable('assistant');
  }
  return {
    type: 'unknown',
    message: aiAvailable
      ? "I couldn't work out what you meant. Try one of these:"
      : "I couldn't work out what you meant. Try phrasing it like one of these:",
    examples: EXAMPLES,
    source: 'none',
    aiAvailable,
  };
}

/** Date options for this company: quarters / "this year" / YTD follow its fiscal year. */
async function dateOptsFor(ctx: ServiceContext): Promise<DateRangeOptions> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return { fiscalStartMonth: fiscalStartMonthFromYearEnd(row?.settings?.fiscalYearEnd) };
}

function withMeta(out: CommandOutcome, source: CommandResult['source'], intent: CommandIntent): CommandResult {
  return { ...out, source, intent, understood: describeIntent(intent) };
}

// ---------------------------------------------------------------------------
// AI fallback prompt
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function aiMessages(text: string, today: Date, dateOpts: DateRangeOptions = {}) {
  const day = today.toISOString().slice(0, 10);
  const fs = dateOpts.fiscalStartMonth ?? 0;
  const yearRule =
    fs === 0
      ? 'The fiscal year is the calendar year (quarters are calendar quarters).'
      : `This company's fiscal year starts in ${MONTH_NAMES[fs]}: Q1 is ${MONTH_NAMES[fs]}–${MONTH_NAMES[(fs + 2) % 12]}, and "this year", "last year" and YTD mean fiscal years.`;
  const system = [
    'You turn one short request typed into an accounting app\'s command bar into a JSON intent.',
    'You never perform anything yourself; the app shows the user a form or report to confirm.',
    `Today is ${day}. Dates are YYYY-MM-DD. ${yearRule}`,
    'For a period, put the user\'s own words in "period" (e.g. "Q1", "first quarter", "last month", "this year", "ytd", "September 2026") and leave out from/to — the app works out the dates. Use from/to only for exact dates the user typed.',
    'Reply with ONLY a JSON object {"intent": <intent or null>} — null when the request is not one of these:',
    '{"kind":"create","form":"invoice|bill|expense|estimate|sales_receipt","party":"customer or vendor name as typed","lines":[{"text":"item or expense category","quantity":"3","rate":"150","amount":"450"}],"date":"YYYY-MM-DD","memo":"…","paymentAccount":"bank/card for expenses"}',
    '{"kind":"report","report":"unpaid_bills|unpaid_invoices|profit_loss|balance_sheet|ap_aging|ar_aging","overDays":60,"party":"name","period":"last quarter"}',
    '{"kind":"question","measure":"spend|income","subject":"account, vendor or customer words","period":"Q3"}',
    '{"kind":"action","action":"pay_bills|reconcile|record_deposit|receive_payment|transfer_funds|journal_entry|run_payroll|bank_feeds","target":"account or customer"}',
    '{"kind":"navigate","target":"page name"}',
    'Omit fields you do not know. Amounts are plain numbers without currency symbols. Keep names exactly as typed.',
  ].join('\n');
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: text },
  ];
}

/**
 * A model-supplied period phrase is resolved HERE with the company's fiscal year, so "Q1" means
 * the same thing whichever path understood the command. When the phrase is readable it wins
 * over any from/to the model computed itself (models tend to assume calendar quarters).
 */
function serverPeriod(intent: CommandIntent, today: Date, dateOpts: DateRangeOptions): CommandIntent {
  if ((intent.kind !== 'question' && intent.kind !== 'report') || !intent.period) return intent;
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/^(?:(?:in|for|during|over|of|the)\s+)+/i, '').toLowerCase();
  const rm = parseDateRange(intent.period, today, dateOpts);
  // Only a phrase read in full counts: "Q5 2026" must not quietly become "2026".
  if (!rm || norm(rm.matched) !== norm(intent.period)) {
    return { ...intent, dateProblem: `I don't know the period “${intent.period}” — use Q1–Q4, a month, “last month”, “this year”, or from/to dates.` };
  }
  const range = { from: rm.range.from, to: rm.range.to };
  return intent.kind === 'question' ? { ...intent, ...range, rangeLabel: rm.range.label } : { ...intent, ...range };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function allowed(ctx: ServiceContext, area: Area, action: Action): boolean {
  return !ctx.access || can(ctx.access, area, action);
}

const FORM_NEEDS: Record<FormKind, { area: Area; action: Action }> = {
  invoice: { area: 'customers', action: 'create' },
  estimate: { area: 'customers', action: 'create' },
  sales_receipt: { area: 'customers', action: 'create' },
  bill: { area: 'vendors', action: 'create' },
  expense: { area: 'banking', action: 'create' },
};

const AREA_WORDS: Record<string, string> = {
  customers: 'customer sales forms',
  vendors: 'vendor bills',
  banking: 'checks and banking',
  accounting: 'reconciling and journal entries',
  payroll: 'payroll',
  reports_financial: 'financial reports',
  reports_sales: 'customer reports',
  reports_purchases: 'vendor reports',
};

function denied(area: Area, what: string): CommandOutcome {
  return {
    type: 'denied',
    message: `Your role can't ${what} (${AREA_WORDS[area] ?? area}). Ask an admin to change your access in Users & Roles.`,
  };
}

export async function executeIntent(
  ctx: ServiceContext,
  intent: CommandIntent,
  hints: ResolveHints,
  today: Date,
): Promise<CommandOutcome> {
  switch (intent.kind) {
    case 'create':
      return executeCreate(ctx, intent, hints);
    case 'report':
      return executeReport(ctx, intent, hints, today);
    case 'question':
      return executeQuestion(ctx, intent, hints, today);
    case 'navigate':
      return executeNavigate(ctx, intent);
    case 'action':
      return executeAction(ctx, intent, hints);
  }
}

// ---------------------------------------------------------------------------
// Company lists (active records only, company-scoped)
// ---------------------------------------------------------------------------

interface CustomerRow extends NameCandidate {
  parentId: string | null;
}
interface VendorRow extends NameCandidate {
  defaultExpenseAccountId: string | null;
  prefillAccountIds: string[] | null;
}
interface ItemRow extends NameCandidate {
  type: string;
  description: string | null;
  salesPrice: string | null;
  purchaseCost: string | null;
  taxable: boolean;
  expenseAccountId: string | null;
}
interface AccountRow extends NameCandidate {
  code: string;
  type: string;
  subtype: string;
  parentId: string | null;
}

async function loadCustomers(ctx: ServiceContext): Promise<CustomerRow[]> {
  const rows = await ctx.db
    .select({ id: customers.id, name: customers.displayName, companyName: customers.companyName, parentId: customers.parentId })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.isActive, true)));
  return rows.map((r) => ({ id: r.id, name: r.name, alt: [r.companyName], parentId: r.parentId }));
}

async function loadVendors(ctx: ServiceContext): Promise<VendorRow[]> {
  const rows = await ctx.db
    .select({
      id: vendors.id,
      name: vendors.displayName,
      companyName: vendors.companyName,
      defaultExpenseAccountId: vendors.defaultExpenseAccountId,
      prefillAccountIds: vendors.prefillAccountIds,
    })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.isActive, true)));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    alt: [r.companyName],
    defaultExpenseAccountId: r.defaultExpenseAccountId,
    prefillAccountIds: r.prefillAccountIds,
  }));
}

async function loadItems(ctx: ServiceContext): Promise<ItemRow[]> {
  const rows = await ctx.db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      type: items.type,
      description: items.description,
      salesPrice: items.salesPrice,
      purchaseCost: items.purchaseCost,
      taxable: items.taxable,
      expenseAccountId: items.expenseAccountId,
    })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.isActive, true)));
  return rows.map((r) => ({ ...r, alt: [r.sku] }));
}

async function loadAccounts(ctx: ServiceContext): Promise<AccountRow[]> {
  const rows = await ctx.db
    .select({ id: accounts.id, name: accounts.name, code: accounts.code, type: accounts.type, subtype: accounts.subtype, parentId: accounts.parentId })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.isActive, true)));
  return rows.map((r) => ({ ...r, alt: [r.code] }));
}

/** Items that make sense on a sales line. */
const SALES_ITEM_TYPES = new Set(['service', 'inventory', 'non_inventory', 'bundle', 'other_charge', 'inventory_assembly', 'assembly', 'group']);
/** Items that make sense on a purchase line. */
const PURCHASE_ITEM_TYPES = new Set(['service', 'inventory', 'non_inventory', 'other_charge', 'inventory_assembly', 'assembly']);

function decStr(v: Decimal): string {
  // Up to 4 decimals, trailing zeros trimmed — for quantities and unit rates.
  return v.toDecimalPlaces(4).toFixed().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

const TOO_LARGE = 'That amount is too large — use at most 13 digits before the decimal point.';
/** A computed quantity / unit rate that must fit a form field (≤ 13 integer digits). */
function fitDec(v: Decimal): string {
  if (!v.isFinite() || v.isNegative()) throw validation(TOO_LARGE);
  const s = decStr(v);
  if (!/^\d{1,13}(\.\d{1,4})?$/.test(s)) throw validation(TOO_LARGE);
  return s;
}
/** A computed line amount that must fit a form field and the ledger (≤ 13 integer digits, 2 dp). */
function fitAmount(v: Decimal): string {
  if (!v.isFinite() || v.isNegative()) throw validation(TOO_LARGE);
  const s = toAmountString(v);
  if (!/^\d{1,13}\.\d{2}$/.test(s)) throw validation(TOO_LARGE);
  return s;
}
/** amount ÷ quantity, refusing a zero quantity instead of producing Infinity. */
function perUnit(amount: string, qty: string): string {
  if (Money.isZero(qty)) throw validation("A quantity of zero can't be used — enter 1 or more.");
  return fitDec(Money.div(amount, qty));
}

// ---------------------------------------------------------------------------
// create → prefilled form
// ---------------------------------------------------------------------------

async function executeCreate(ctx: ServiceContext, intent: CreateIntent, hints: ResolveHints): Promise<CommandOutcome> {
  const form: FormKind = hints.form ?? intent.form;
  const needs = FORM_NEEDS[form];
  if (!allowed(ctx, needs.area, needs.action)) return denied(needs.area, `create ${/^[aeiou]/.test(FORM_LABELS[form]) ? 'an' : 'a'} ${FORM_LABELS[form]}`);
  // A negative line is a credit: refuse it rather than fill it in with the sign dropped.
  const negative = negativeTokens(intent);
  if (negative.length) throw validation(negativeMessage(form, negative));
  const sales = isSalesForm(form);
  const notes: string[] = [];
  const prefill: FormPrefill = { kind: form, lines: [] };
  if (intent.date) prefill.date = intent.date;
  if (intent.memo) prefill.memo = intent.memo;
  const reIntent = (patch: Partial<CreateIntent>): CreateIntent => ({ ...intent, form, ...patch });

  // ---- party (customer / vendor) ----
  const custs = sales ? await loadCustomers(ctx) : [];
  const vends = sales ? [] : await loadVendors(ctx);
  let vendor: VendorRow | undefined;
  let partyName: string | undefined;
  const partyList: NameCandidate[] = sales ? custs : vends;
  const setParty = (id: string, name: string) => {
    partyName = name;
    if (sales) prefill.customerId = id;
    else {
      prefill.vendorId = id;
      vendor = vends.find((v) => v.id === id);
    }
  };
  if (hints.partyId) {
    const hit = partyList.find((c) => c.id === hints.partyId);
    if (!hit) throw validation(`That ${sales ? 'customer' : 'vendor'} is not in this company.`);
    setParty(hit.id, hit.name);
  } else if (intent.party) {
    let pick = pickName(intent.party, partyList);
    // "invoice Acme consulting 3 hours": the grammar can't tell where the name ends, so try
    // shorter leading parts of it; the leftover words describe the first line.
    if (pick.status === 'none') {
      const narrowed = narrowName(intent.party, partyList);
      if (narrowed) {
        pick = narrowed.pick;
        const first = intent.lines[0];
        intent = {
          ...intent,
          party: narrowed.name,
          lines: first && !first.text ? [{ ...first, text: narrowed.rest }, ...intent.lines.slice(1)] : first ? intent.lines : [{ text: narrowed.rest }],
        };
      }
    }
    if (pick.status === 'one') {
      setParty(pick.match.id, pick.match.name);
      // "Acme Corporation consulting 3 hours": the words after the name describe the line.
      const rest = wordsAfterName(intent.party ?? '', pick.match);
      const first = intent.lines[0];
      if (rest && first && !first.text) intent = { ...intent, lines: [{ ...first, text: rest }, ...intent.lines.slice(1)] };
    } else if (pick.status === 'many') {
      return {
        type: 'choose',
        question: `Which ${sales ? 'customer' : 'vendor'} did you mean by “${intent.party}”?`,
        options: pick.matches.map((m) => ({ label: m.name, intent: reIntent({}), hints: { ...hints, form, partyId: m.id } })),
      };
    } else {
      // Not on this side — is it a name on the other side (a customer typed into "bill …")?
      const other: NameCandidate[] = sales ? await loadVendors(ctx) : await loadCustomers(ctx);
      const flip = pickName(intent.party ?? '', other);
      const flipForm: FormKind = sales ? 'bill' : 'invoice';
      const flipNeeds = FORM_NEEDS[flipForm];
      if (flip.status !== 'none' && allowed(ctx, flipNeeds.area, flipNeeds.action)) {
        const matches = flip.status === 'one' ? [flip.match] : flip.matches;
        return {
          type: 'choose',
          question: `“${intent.party}” is a ${sales ? 'vendor' : 'customer'}, not a ${sales ? 'customer' : 'vendor'}. What did you want to do?`,
          options: [
            ...matches.map((m) => ({
              label: `${flipForm === 'bill' ? 'Enter a bill from' : 'Create an invoice for'} ${m.name}`,
              intent: { ...intent, form: flipForm, lines: flipForm === 'invoice' ? purchaseLinesAsSales(intent.lines) : intent.lines },
              hints: { form: flipForm, partyId: m.id },
            })),
            {
              label: `Continue the ${FORM_LABELS[form]} and pick the ${sales ? 'customer' : 'vendor'} myself`,
              intent: { ...reIntent({}), party: undefined },
              hints: { ...hints, form },
            },
          ],
        };
      }
      if (form === 'expense') {
        prefill.payeeName = intent.party;
        notes.push(`“${intent.party}” isn't on your vendor list, so it is filled in as a one-time payee.`);
      } else {
        notes.push(`No ${sales ? 'customer' : 'vendor'} matches “${intent.party}” — pick one on the form.`);
      }
    }
  }

  // ---- lines ----
  const itemList = await loadItems(ctx);
  const acctList = sales ? [] : await loadAccounts(ctx);
  const expenseAccounts = acctList.filter((a) => a.type === 'expense');
  const vendorDefault = vendor
    ? acctList.find((a) => a.id === (vendor!.defaultExpenseAccountId ?? vendor!.prefillAccountIds?.[0]))
    : undefined;

  for (let i = 0; i < intent.lines.length; i++) {
    const l = intent.lines[i];
    const key = String(i);
    const text = l.text?.trim();
    if (l.unclear?.length) {
      const what = l.unclear.map((u) => `“${u}”`).join(' and ');
      notes.push(`I couldn't tell what ${what} was for on line ${i + 1}, so ${l.unclear.length === 1 ? 'it was' : 'they were'} left out — check the amounts on the form.`);
    }
    if (sales) {
      const salesItems = itemList.filter((it) => SALES_ITEM_TYPES.has(it.type));
      let item: ItemRow | undefined;
      if (hints.itemIds?.[key]) {
        item = itemList.find((it) => it.id === hints.itemIds![key]);
        if (!item) throw validation('That item is not in this company.');
      } else if (text) {
        const pick = pickName(text, salesItems);
        if (pick.status === 'one') item = pick.match;
        else if (pick.status === 'many') {
          return {
            type: 'choose',
            question: `Which item did you mean by “${text}”?`,
            options: pick.matches.map((m) => ({
              label: m.name,
              description: m.salesPrice ? `${formatCurrency(m.salesPrice)} each` : undefined,
              intent: reIntent({}),
              hints: { ...hints, form, itemIds: { ...(hints.itemIds ?? {}), [key]: m.id } },
            })),
          };
        } else notes.push(`No item matches “${text}” — choose the item on line ${i + 1}.`);
      }
      const { quantity, rate } = salesQtyRate(l, item);
      if (rate) fitAmount(Money.mul(quantity, rate)); // the form's line total must fit too
      const line: PrefillLine = {
        ...(item ? { itemId: item.id, itemName: item.name, itemType: item.type, taxable: item.taxable } : {}),
        description: item ? (item.description || item.name) : (text ?? ''),
        quantity,
        ...(rate ? { rate } : {}),
        ...(l.rate || l.amount ? { rateFromUser: true } : {}),
      };
      if (!rate) notes.push(`Line ${i + 1} has no price yet — enter the rate on the form.`);
      prefill.lines.push(line);
    } else {
      // Purchases: an expense account ("office supplies"), else an item, else the vendor default.
      let account: AccountRow | undefined;
      let item: ItemRow | undefined;
      if (hints.accountIds?.[key]) {
        account = acctList.find((a) => a.id === hints.accountIds![key]);
        if (!account) throw validation('That account is not in this company.');
      } else if (hints.itemIds?.[key]) {
        item = itemList.find((it) => it.id === hints.itemIds![key]);
        if (!item) throw validation('That item is not in this company.');
      } else if (text) {
        const pick = pickName(text, expenseAccounts);
        if (pick.status === 'one') account = pick.match;
        else if (pick.status === 'many') {
          return {
            type: 'choose',
            question: `Which expense account is “${text}”?`,
            options: pick.matches.map((m) => ({
              label: `${m.code ? `${m.code} · ` : ''}${m.name}`,
              intent: reIntent({}),
              hints: { ...hints, form, accountIds: { ...(hints.accountIds ?? {}), [key]: m.id } },
            })),
          };
        } else {
          const ip = pickName(text, itemList.filter((it) => PURCHASE_ITEM_TYPES.has(it.type)));
          if (ip.status === 'one') item = ip.match;
          else if (ip.status === 'many') {
            return {
              type: 'choose',
              question: `Which item did you mean by “${text}”?`,
              options: ip.matches.map((m) => ({
                label: m.name,
                intent: reIntent({}),
                hints: { ...hints, form, itemIds: { ...(hints.itemIds ?? {}), [key]: m.id } },
              })),
            };
          }
        }
      }
      if (item) {
        // "bill from Staples 3 widgets": a bare whole number on an ITEM line is a count, not $3.
        const asCount = l.amountMaybeCount && l.amount && !l.quantity && !l.rate;
        const qty = (asCount ? l.amount : l.quantity) ?? '1';
        const typedAmount = asCount ? undefined : l.amount;
        const unit = l.rate ?? (typedAmount ? perUnit(typedAmount, qty) : item.purchaseCost ?? undefined);
        const amount = typedAmount ?? (unit ? fitAmount(Money.mul(qty, unit)) : undefined);
        if (!unit) notes.push(`Line ${i + 1} has no cost yet — enter it on the form.`);
        prefill.lines.push({
          itemId: item.id,
          itemName: item.name,
          itemType: item.type,
          description: text && normalizeEq(text, item.name) ? item.name : (text ?? item.name),
          quantity: fitDec(Money.of(qty)),
          ...(unit ? { rate: fitDec(Money.of(unit)) } : {}),
          ...(amount ? { amount: fitAmount(Money.of(amount)) } : {}),
        });
        continue;
      }
      if (!account && vendorDefault) {
        account = vendorDefault;
        notes.push(`Line ${i + 1} uses ${vendor!.name}'s usual account, ${vendorDefault.name}.`);
      } else if (!account && text) {
        notes.push(`No expense account matches “${text}” — choose the account on line ${i + 1}.`);
      } else if (!account) {
        notes.push(`Choose the expense account on line ${i + 1}.`);
      }
      const amount = l.amount ?? (l.rate ? fitAmount(Money.mul(l.quantity ?? '1', l.rate)) : undefined);
      if (!amount) notes.push(`Line ${i + 1} has no amount yet — enter it on the form.`);
      prefill.lines.push({
        ...(account ? { accountId: account.id } : {}),
        description: text ?? '',
        ...(amount ? { amount: fitAmount(Money.of(amount)) } : {}),
      });
    }
  }
  // Purchases with no lines typed: start from the vendor's usual account.
  if (!sales && prefill.lines.length === 0 && vendorDefault) {
    prefill.lines.push({ accountId: vendorDefault.id, description: '' });
  }

  // ---- expense: paid from which bank / card ----
  if (form === 'expense') {
    const payAccts = (acctList.length ? acctList : await loadAccounts(ctx)).filter(
      (a) => a.subtype === 'checking' || a.subtype === 'savings' || a.subtype === 'credit_card',
    );
    if (hints.paymentAccountId) {
      if (!payAccts.some((a) => a.id === hints.paymentAccountId)) throw validation('That bank account is not in this company.');
      prefill.paymentAccountId = hints.paymentAccountId;
    } else if (intent.paymentAccount) {
      const pick = pickName(intent.paymentAccount, payAccts);
      if (pick.status === 'one') prefill.paymentAccountId = pick.match.id;
      else if (pick.status === 'many') {
        return {
          type: 'choose',
          question: `Which account did you pay from (“${intent.paymentAccount}”)?`,
          options: pick.matches.map((m) => ({ label: m.name, intent: reIntent({}), hints: { ...hints, form, paymentAccountId: m.id } })),
        };
      } else notes.push(`No bank or card account matches “${intent.paymentAccount}” — choose it on the form.`);
    }
  }

  const total = prefill.lines.reduce(
    (s, l) => s.plus(l.amount ? Money.of(l.amount) : l.quantity && l.rate ? Money.mul(l.quantity, l.rate) : Money.zero()),
    Money.zero(),
  );
  const who = partyName ?? prefill.payeeName;
  const title = `New ${FORM_LABELS[form]}${who ? ` ${sales ? 'for' : 'from'} ${who}` : ''}`;
  const lineWords = prefill.lines
    .map((l) => {
      const what = l.itemName ?? l.description ?? '';
      if (l.quantity && l.rate) return `${l.quantity} × ${what} at ${formatCurrency(l.rate)}`;
      if (l.amount) return `${what} ${formatCurrency(l.amount)}`.trim();
      return what;
    })
    .filter(Boolean)
    .join('; ');
  const summary = `${title}${lineWords ? `: ${lineWords}` : ''}${total.isZero() ? '' : ` — total ${formatCurrency(toAmountString(total))}`}. Nothing is saved until you review it and click Save.`;
  prefill.note = 'Filled in from the command bar — check everything, then save.';
  const valid = checkedPrefill(prefill);
  return { type: 'prefill', form, href: PREFILL_PATHS[form], title, summary, notes, prefill: valid };
}

/** Validate a prefill before handing it to a form: a bad value is a 400, never a 500. */
function checkedPrefill(prefill: unknown): FormPrefill {
  const parsed = formPrefillSchema.safeParse(prefill);
  if (!parsed.success) throw validation("Some of those values can't be filled into the form. Check the amounts and try again.");
  return parsed.data;
}

/** Words typed after a record's full name ("Acme Corporation consulting" → "consulting"). */
function wordsAfterName(typed: string, cand: NameCandidate): string | null {
  const t = typed.trim().split(/\s+/);
  for (const n of [cand.name, ...(cand.alt ?? [])]) {
    if (!n) continue;
    const nw = n.trim().split(/\s+/);
    if (t.length > nw.length && nw.every((w, i) => w.toLowerCase() === t[i].toLowerCase())) return t.slice(nw.length).join(' ');
  }
  return null;
}

/**
 * Lines parsed for a bill/check, re-read for an invoice: a whole number with no price was a
 * quantity on a sales form ("50 widgets"), not a dollar amount.
 */
function purchaseLinesAsSales(lines: IntentLine[]): IntentLine[] {
  return lines.map((l) =>
    l.amount && !l.quantity && !l.rate && /^\d+$/.test(l.amount) ? { ...(l.text ? { text: l.text } : {}), quantity: l.amount } : l,
  );
}

/** Longest leading part of `typed` that names exactly one record; the rest is returned too. */
function narrowName<T extends NameCandidate>(typed: string, list: T[]): { pick: { status: 'one'; match: T; score: number }; name: string; rest: string } | null {
  const ws = typed.trim().split(/\s+/);
  for (let n = ws.length - 1; n >= 1; n--) {
    const name = ws.slice(0, n).join(' ');
    const pick = pickName(name, list);
    if (pick.status === 'one') return { pick, name, rest: ws.slice(n).join(' ') };
  }
  return null;
}

function normalizeEq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Sales quantity / unit rate from what was typed (and the item's price when not typed). */
function salesQtyRate(l: IntentLine, item: ItemRow | undefined): { quantity: string; rate?: string } {
  if (l.rate) return { quantity: fitDec(Money.of(l.quantity ?? '1')), rate: fitDec(Money.of(l.rate)) };
  if (l.amount && l.quantity) return { quantity: fitDec(Money.of(l.quantity)), rate: perUnit(l.amount, l.quantity) };
  if (l.amount) return { quantity: '1', rate: fitDec(Money.of(l.amount)) };
  const price = item?.salesPrice;
  return { quantity: fitDec(Money.of(l.quantity ?? '1')), ...(price ? { rate: fitDec(Money.of(price)) } : {}) };
}

// ---------------------------------------------------------------------------
// report → filtered report page
// ---------------------------------------------------------------------------

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function reportTotals(r: StdReport): { count: number; total: string } {
  const count = r.rows.filter((row) => row.kind === 'data').length;
  const grand = r.rows.find((row) => row.kind === 'grand');
  const total = grand?.cells.open !== undefined && grand.cells.open !== null ? String(grand.cells.open) : '0.00';
  return { count, total };
}

/**
 * The period an intent names. A period the grammar flagged (not a real date, start after end)
 * or an inverted from/to is reported to the user — never replaced by some other period.
 */
async function resolveRange(
  ctx: ServiceContext,
  i: { from?: string; to?: string; period?: string; dateProblem?: string },
  today: Date,
): Promise<DateRange | null> {
  if (i.dateProblem) throw validation(i.dateProblem);
  let r: DateRange | null = null;
  if (i.from && i.to) r = { from: i.from, to: i.to, label: i.period ?? `${i.from} to ${i.to}` };
  else if (i.period) r = parseDateRange(i.period, today, await dateOptsFor(ctx))?.range ?? null;
  if (r && r.from > r.to) throw validation(`The start date (${r.from}) is after the end date (${r.to}). Swap them and try again.`);
  return r;
}

async function executeReport(ctx: ServiceContext, intent: ReportIntent, hints: ResolveHints, today: Date): Promise<CommandOutcome> {
  const over = intent.overDays !== undefined ? String(intent.overDays) : undefined;
  const overWords = intent.overDays !== undefined ? (intent.overDays === 0 ? ' that are past due' : ` more than ${intent.overDays} days past due`) : '';
  const range = await resolveRange(ctx, intent, today);

  if (intent.report === 'unpaid_bills' || intent.report === 'unpaid_invoices') {
    const bills = intent.report === 'unpaid_bills';
    const area: Area = bills ? 'reports_purchases' : 'reports_sales';
    if (!allowed(ctx, area, 'view')) return denied(area, `see ${bills ? 'unpaid bills' : 'unpaid invoices'}`);
    const notes: string[] = [];
    let partyId: string | undefined;
    let partyName: string | undefined;
    if (hints.partyId || intent.party) {
      const list: NameCandidate[] = bills ? await loadVendors(ctx) : await loadCustomers(ctx);
      if (hints.partyId) {
        const hit = list.find((c) => c.id === hints.partyId);
        if (!hit) throw validation(`That ${bills ? 'vendor' : 'customer'} is not in this company.`);
        partyId = hit.id;
        partyName = hit.name;
      } else {
        const pick = pickName(intent.party!, list);
        if (pick.status === 'one') {
          partyId = pick.match.id;
          partyName = pick.match.name;
        } else if (pick.status === 'many') {
          return {
            type: 'choose',
            question: `Which ${bills ? 'vendor' : 'customer'} did you mean by “${intent.party}”?`,
            options: pick.matches.map((m) => ({ label: m.name, intent, hints: { partyId: m.id } })),
          };
        } else notes.push(`No ${bills ? 'vendor' : 'customer'} matches “${intent.party}”, so all of them are shown.`);
      }
    }
    const params = { overDays: over, [bills ? 'vendorId' : 'customerId']: partyId };
    // Counted as of the command's "today" (the link opens the live report, which defaults to today).
    const runParams = { ...params, asOf: range?.to ?? todayStr(today) };
    const report = bills ? await unpaidBillsDetail(ctx, runParams) : await openInvoicesReport(ctx, runParams);
    const { count, total } = reportTotals(report);
    const noun = bills ? (count === 1 ? 'unpaid bill' : 'unpaid bills') : count === 1 ? 'unpaid invoice' : 'unpaid invoices';
    const who = partyName ? ` ${bills ? 'from' : 'for'} ${partyName}` : '';
    return {
      type: 'navigate',
      href: `/reports/std/${bills ? 'unpaid-bills-detail' : 'open-invoices'}${qs(params)}`,
      title: `${bills ? 'Unpaid bills' : 'Unpaid invoices'}${who}${overWords}`,
      summary: `${count} ${noun}${who}${overWords}, ${formatCurrency(total)} in total.`,
      notes,
    };
  }

  if (intent.report === 'ap_aging' || intent.report === 'ar_aging') {
    const ap = intent.report === 'ap_aging';
    const area: Area = ap ? 'reports_purchases' : 'reports_sales';
    if (!allowed(ctx, area, 'view')) return denied(area, 'see aging reports');
    return {
      type: 'navigate',
      href: `/reports/${ap ? 'ap-aging' : 'ar-aging'}${qs({ asOf: range?.to })}`,
      title: ap ? 'A/P aging — what you owe' : 'A/R aging — who owes you',
    };
  }

  if (!allowed(ctx, 'reports_financial', 'view')) return denied('reports_financial', 'see financial reports');
  if (intent.report === 'balance_sheet') {
    return { type: 'navigate', href: `/reports/balance-sheet${qs({ asOf: range?.to })}`, title: `Balance Sheet${range ? ` as of ${range.to}` : ''}` };
  }
  return {
    type: 'navigate',
    href: `/reports/profit-loss${qs({ from: range?.from, to: range?.to })}`,
    title: `Profit & Loss${range ? `, ${range.label}` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// question → number from the GL
// ---------------------------------------------------------------------------

type Subject =
  | { kind: 'all' }
  | { kind: 'accounts'; ids: string[]; name: string; accountId: string }
  | { kind: 'vendor'; id: string; name: string }
  | { kind: 'customer'; id: string; name: string };

/** An account and all its sub-accounts. */
function withDescendants(rootId: string, all: AccountRow[]): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) for (const a of all) if (a.parentId === out[i] && !out.includes(a.id)) out.push(a.id);
  return out;
}

async function executeQuestion(ctx: ServiceContext, intent: QuestionIntent, hints: ResolveHints, today: Date): Promise<CommandOutcome> {
  if (!allowed(ctx, 'reports_financial', 'view')) return denied('reports_financial', 'see what was spent or earned');
  const spend = intent.measure === 'spend';
  const range: DateRange =
    (await resolveRange(ctx, { ...intent, period: intent.from && intent.to ? (intent.rangeLabel ?? intent.period) : intent.period }, today)) ??
    yearToDate(today, await dateOptsFor(ctx));

  const accts = await loadAccounts(ctx);
  const plAccts = accts.filter((a) => a.type === (spend ? 'expense' : 'revenue'));
  const names: NameCandidate[] = spend ? await loadVendors(ctx) : await loadCustomers(ctx);
  const nameWord = spend ? 'vendor' : 'customer';

  let subject: Subject = { kind: 'all' };
  if (hints.subjectAll || !intent.subject) {
    subject = { kind: 'all' };
  } else if (hints.subjectAccountId) {
    const a = plAccts.find((x) => x.id === hints.subjectAccountId);
    if (!a) throw validation('That account is not in this company.');
    subject = { kind: 'accounts', ids: withDescendants(a.id, accts), name: a.name, accountId: a.id };
  } else if (hints.subjectVendorId || hints.subjectCustomerId) {
    const id = hints.subjectVendorId ?? hints.subjectCustomerId;
    const n = names.find((x) => x.id === id);
    if (!n) throw validation(`That ${nameWord} is not in this company.`);
    subject = spend ? { kind: 'vendor', id: n.id, name: n.name } : { kind: 'customer', id: n.id, name: n.name };
  } else {
    const ap = pickName(intent.subject, plAccts);
    const np = pickName(intent.subject, names);
    const acctOpt = (a: AccountRow): ChooseOption => ({
      label: `${spend ? 'Spending in' : 'Income in'} the account ${a.name}`,
      intent,
      hints: { subjectAccountId: a.id },
    });
    const nameOpt = (n: NameCandidate): ChooseOption => ({
      label: `${spend ? 'Everything paid to' : 'Everything earned from'} ${nameWord} ${n.name}`,
      intent,
      hints: spend ? { subjectVendorId: n.id } : { subjectCustomerId: n.id },
    });
    if (ap.status === 'one' && np.status === 'none') {
      subject = { kind: 'accounts', ids: withDescendants(ap.match.id, accts), name: ap.match.name, accountId: ap.match.id };
    } else if (np.status === 'one' && ap.status === 'none') {
      subject = spend ? { kind: 'vendor', id: np.match.id, name: np.match.name } : { kind: 'customer', id: np.match.id, name: np.match.name };
    } else if (ap.status === 'one' && np.status === 'one' && Math.abs(ap.score - np.score) >= 10) {
      subject =
        ap.score > np.score
          ? { kind: 'accounts', ids: withDescendants(ap.match.id, accts), name: ap.match.name, accountId: ap.match.id }
          : spend
            ? { kind: 'vendor', id: np.match.id, name: np.match.name }
            : { kind: 'customer', id: np.match.id, name: np.match.name };
    } else if (ap.status === 'none' && np.status === 'none') {
      return {
        type: 'choose',
        question: `I couldn't find an ${spend ? 'expense' : 'income'} account or ${nameWord} called “${intent.subject}”. What should I add up?`,
        options: [
          { label: `All ${spend ? 'spending' : 'income'}, ${range.label}`, intent, hints: { subjectAll: true } },
        ],
      };
    } else {
      const accChoices = ap.status === 'one' ? [ap.match] : ap.status === 'many' ? ap.matches : [];
      const nameChoices = np.status === 'one' ? [np.match] : np.status === 'many' ? np.matches : [];
      return {
        type: 'choose',
        question: `“${intent.subject}” could mean more than one thing. Which did you mean?`,
        options: [...accChoices.map(acctOpt), ...nameChoices.map(nameOpt)].slice(0, 8),
      };
    }
  }

  const from = new Date(`${range.from}T00:00:00.000Z`);
  const to = new Date(`${range.to}T23:59:59.999Z`);
  let breakdown: { label: string; amount: string }[] = [];
  let total = Money.zero();

  if (subject.kind === 'all' || subject.kind === 'accounts') {
    // Same numbers as the Profit & Loss report (posted entries, closing entries excluded).
    const pl = await profitAndLoss(ctx, { from, to });
    const lines = spend ? pl.expenses : pl.income;
    const picked = subject.kind === 'all' ? lines : lines.filter((l) => subject.ids.includes(l.accountId));
    for (const l of picked) total = total.plus(Money.of(l.amount));
    breakdown = picked
      .filter((l) => !Money.isZero(l.amount))
      .sort((a, b) => Money.of(b.amount).comparedTo(Money.of(a.amount)))
      .slice(0, 8)
      .map((l) => ({ label: l.name, amount: l.amount }));
  } else {
    const rows = await nameActivity(ctx, subject, spend, from, to);
    for (const r of rows) total = total.plus(Money.of(r.amount));
    breakdown = rows
      .filter((r) => !Money.isZero(r.amount))
      .sort((a, b) => Money.of(b.amount).comparedTo(Money.of(a.amount)))
      .slice(0, 8)
      .map((r) => ({ label: r.name, amount: toAmountString(r.amount) }));
  }

  const amount = toAmountString(total);
  const what =
    subject.kind === 'all'
      ? ''
      : subject.kind === 'accounts'
        ? ` on ${subject.name}`
        : spend
          ? ` with ${subject.name}`
          : ` from ${subject.name}`;
  const answer = `You ${spend ? 'spent' : 'earned'} ${formatCurrency(amount)}${what}, ${range.label} (${range.from} to ${range.to}).`;

  // Link to the report that shows the same figure, if the user may open it.
  let href: string | null = null;
  let linkLabel = '';
  const dates = { from: range.from, to: range.to };
  if (subject.kind === 'accounts' && subject.ids.length === 1) {
    href = `/reports/std/transaction-detail-by-account${qs({ ...dates, accountId: subject.accountId })}`;
    linkLabel = `See the ${subject.name} transactions`;
  } else if (subject.kind === 'vendor' && allowed(ctx, 'reports_purchases', 'view')) {
    href = `/reports/std/expenses-by-vendor-detail${qs({ ...dates, vendorId: subject.id })}`;
    linkLabel = `See what you paid ${subject.name}`;
  } else if (subject.kind === 'customer' && allowed(ctx, 'reports_sales', 'view')) {
    href = `/reports/std/sales-by-customer-detail${qs({ ...dates, customerId: subject.id })}`;
    linkLabel = `See sales to ${subject.name}`;
  } else {
    href = `/reports/profit-loss${qs(dates)}`;
    linkLabel = 'Open the Profit & Loss for this period';
  }
  return {
    type: 'answer',
    title: spend ? 'Spending' : 'Income',
    answer,
    amount,
    range,
    breakdown,
    href,
    linkLabel,
    notes: ['Accrual basis, from posted transactions in your general ledger.'],
  };
}

/**
 * Expense (or income) lines of posted entries that belong to one vendor's (customer's)
 * documents — bills, checks, vendor credits (invoices, sales receipts, credit memos) — or that
 * carry the name directly. Grouped by account.
 */
async function nameActivity(
  ctx: ServiceContext,
  subject: { kind: 'vendor' | 'customer'; id: string },
  spend: boolean,
  from: Date,
  to: Date,
): Promise<{ name: string; amount: Decimal }[]> {
  let docMatch: SQL;
  if (subject.kind === 'vendor') {
    docMatch = or(
      sql`${journalEntries.sourceRef} IN (SELECT 'bill:' || ${bills.id}::text FROM ${bills} WHERE ${bills.companyId} = ${ctx.companyId} AND ${bills.vendorId} = ${subject.id})`,
      sql`${journalEntries.sourceRef} IN (SELECT 'expense:' || ${expenses.id}::text FROM ${expenses} WHERE ${expenses.companyId} = ${ctx.companyId} AND ${expenses.vendorId} = ${subject.id})`,
      sql`${journalEntries.sourceRef} IN (SELECT 'vendor_credit:' || ${vendorCredits.id}::text FROM ${vendorCredits} WHERE ${vendorCredits.companyId} = ${ctx.companyId} AND ${vendorCredits.vendorId} = ${subject.id})`,
      and(eq(journalEntryLines.entityType, 'vendor'), eq(journalEntryLines.entityId, subject.id)),
    )!;
  } else {
    // A customer's jobs / sub-customers count as that customer.
    const all = await loadCustomers(ctx);
    const ids = [subject.id];
    for (let i = 0; i < ids.length; i++) for (const c of all) if (c.parentId === ids[i] && !ids.includes(c.id)) ids.push(c.id);
    docMatch = or(
      sql`${journalEntries.sourceRef} IN (SELECT 'invoice:' || ${invoices.id}::text FROM ${invoices} WHERE ${invoices.companyId} = ${ctx.companyId} AND ${inArray(invoices.customerId, ids)})`,
      sql`${journalEntries.sourceRef} IN (SELECT 'salesreceipt:' || ${salesReceipts.id}::text FROM ${salesReceipts} WHERE ${salesReceipts.companyId} = ${ctx.companyId} AND ${inArray(salesReceipts.customerId, ids)})`,
      sql`${journalEntries.sourceRef} IN (SELECT 'credit_memo:' || ${creditMemos.id}::text FROM ${creditMemos} WHERE ${creditMemos.companyId} = ${ctx.companyId} AND ${inArray(creditMemos.customerId, ids)})`,
      and(eq(journalEntryLines.entityType, 'customer'), inArray(journalEntryLines.entityId, ids)),
    )!;
  }
  const rows = await ctx.db
    .select({
      name: accounts.name,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(accounts.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        notFiscalCloseEntry(),
        gte(journalEntries.date, from),
        lte(journalEntries.date, to),
        eq(accounts.type, spend ? 'expense' : 'revenue'),
        docMatch,
      ),
    )
    .groupBy(accounts.id, accounts.name);
  return rows.map((r) => ({ name: r.name, amount: spend ? Money.sub(r.debit, r.credit) : Money.sub(r.credit, r.debit) }));
}

// ---------------------------------------------------------------------------
// navigate / action
// ---------------------------------------------------------------------------

function executeNavigate(ctx: ServiceContext, intent: NavigateIntent): CommandOutcome {
  const permissions = ctx.access?.permissions ?? null;
  // Only a page that really answers to the words typed — every word in its name, QuickBooks name
  // or keywords, or a whole plain-language phrase. A loose partial hit ("go to nowhere-page" →
  // Home) is not a match: the user is told the page wasn't found instead.
  const [page] = searchPages(intent.target, { permissions, limit: 1, strict: true });
  if (page) return { type: 'navigate', href: page.href, title: page.label, summary: page.description };
  const q = intent.target.toLowerCase();
  const act = COMMAND_ACTIONS.find(
    (a) => (a.label.toLowerCase().includes(q) || a.keywords.includes(q)) && canOpenHref(a.href, permissions) && canDoAction(a.needs, permissions),
  );
  if (act) return { type: 'navigate', href: act.href, title: act.label, summary: act.description };
  return {
    type: 'unknown',
    message: `I couldn't find a page called “${intent.target}” that you can open.`,
    examples: EXAMPLES,
  };
}

async function executeAction(ctx: ServiceContext, intent: ActionIntent, hints: ResolveHints): Promise<CommandOutcome> {
  const needs = ACTION_NEEDS[intent.action];
  if (!allowed(ctx, needs.area, needs.action)) return denied(needs.area, ACTION_TITLES[intent.action].toLowerCase());
  const title = ACTION_TITLES[intent.action];

  if (intent.action === 'reconcile' && (intent.target || hints.bankAccountId)) {
    const rows = await ctx.db
      .select({ id: bankAccounts.id, bankName: bankAccounts.bankName, name: accounts.name, code: accounts.code })
      .from(bankAccounts)
      .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
      .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(accounts.companyId, ctx.companyId)));
    const cands = rows.map((r) => ({ id: r.id, name: r.name, alt: [r.bankName, r.code, `${r.bankName} ${r.name}`] }));
    let chosen: (typeof cands)[number] | undefined;
    if (hints.bankAccountId) {
      chosen = cands.find((c) => c.id === hints.bankAccountId);
      if (!chosen) throw validation('That bank account is not in this company.');
    } else {
      const pick = pickName(intent.target!, cands);
      if (pick.status === 'one') chosen = pick.match;
      else if (pick.status === 'many') {
        return {
          type: 'choose',
          question: `Which account do you want to reconcile (“${intent.target}”)?`,
          options: pick.matches.map((m) => ({ label: m.name, description: m.alt[0] ?? undefined, intent, hints: { bankAccountId: m.id } })),
        };
      } else {
        return {
          type: 'navigate',
          href: '/reconcile',
          title,
          notes: [`No bank account matches “${intent.target}” — pick the account on the Reconcile page.`],
        };
      }
    }
    const prefill = checkedPrefill({ kind: 'reconcile', bankAccountId: chosen.id, lines: [] });
    return {
      type: 'prefill',
      form: 'reconcile',
      href: PREFILL_PATHS.reconcile,
      title: `Reconcile ${chosen.name}`,
      summary: `Start reconciling ${chosen.name}: enter the statement date and ending balance.`,
      notes: [],
      prefill,
    };
  }

  if (intent.action === 'receive_payment' && (intent.target || hints.partyId)) {
    const custs = await loadCustomers(ctx);
    let chosen: CustomerRow | undefined;
    if (hints.partyId) {
      chosen = custs.find((c) => c.id === hints.partyId);
      if (!chosen) throw validation('That customer is not in this company.');
    } else {
      const pick = pickName(intent.target!, custs);
      if (pick.status === 'one') chosen = pick.match;
      else if (pick.status === 'many') {
        return {
          type: 'choose',
          question: `Which customer paid (“${intent.target}”)?`,
          options: pick.matches.map((m) => ({ label: m.name, intent, hints: { partyId: m.id } })),
        };
      }
    }
    if (chosen) {
      const prefill = checkedPrefill({ kind: 'payment', customerId: chosen.id, lines: [] });
      return {
        type: 'prefill',
        form: 'payment',
        href: PREFILL_PATHS.payment,
        title: `Receive a payment from ${chosen.name}`,
        summary: `Record money received from ${chosen.name} and apply it to their open invoices.`,
        notes: [],
        prefill,
      };
    }
    return {
      type: 'navigate',
      href: ACTION_HREFS.receive_payment,
      title,
      notes: [`No customer matches “${intent.target}” — pick the customer on the form.`],
    };
  }

  return { type: 'navigate', href: ACTION_HREFS[intent.action], title };
}

// Exported for tests.
export const __test = { salesQtyRate, decStr };
