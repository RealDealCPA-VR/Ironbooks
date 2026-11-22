/**
 * Agent full access: the policy engine (AGENT_ACCESS.md, "Full access"; plan sections 4 and 5.3).
 *
 * Pure module: no database, no Node, no Next. Everything it needs comes in as input, the time
 * included (`input.now`), so the bridge, the approval center, the Agents tab and the tests all get
 * the same answer for the same request.
 *
 * One request is decided in three layers, the strictest first:
 *
 *  1. The ceiling: the agent's role. The same check a person's request meets for the same route
 *     and method. Outside the role the request is REFUSED, never turned into a question: asking for
 *     something the Admin deliberately left out of the role would invite approving it anyway.
 *  2. The policy: per risk class (and optionally per area) Allow, Ask or Never.
 *  3. The grants: standing permission a person gave while approving ("this and similar ones until
 *     the end of the day"). A grant only ever turns an Ask into a run, never a Never into anything.
 *
 * Before any of that, two things refuse whatever the policy or the grants say: a paused agent, and
 * an operation that is not open to agents at all (a person acting as themselves, or the hard floor:
 * agents managing agents, approving requests, the kill switch, audit history).
 *
 * A request can be judged under a stricter class than its operation's own: asking to reveal masked
 * values, working on or before the closing date, or resending with a "yes, I am sure" flag after a
 * warning each make it a different question (`effectiveClass`). That never makes a request less
 * strict: the setting used is the strictest of every class the request falls under.
 */
import Decimal from 'decimal.js';
import {
  AREA_KEYS,
  FLAGS,
  areaLabel,
  canActivity,
  canWholeArea,
  type Action,
  type Area,
  type EffectiveAccess,
  type Flag,
} from '@/lib/permissions/model';
import { activityLabel, activityDef } from '@/lib/permissions/activities';
import type { AgentMode } from '@/lib/permissions/agentAccess';
import {
  ADMIN_APPROVAL_CLASSES,
  AGENT_PRESETS,
  GRANTABLE,
  NEVER_ALLOW_CLASSES,
  POLICY_SETTINGS,
  RISK_CLASSES,
  RISK_CLASS_LABELS,
  isRiskClass,
  type AgentGrant,
  type AgentPolicy,
  type AgentPreset,
  type ApprovalNeeds,
  type Operation,
  type PolicyDecision,
  type PolicyInput,
  type PolicyOverride,
  type PolicySetting,
  type RefusalCode,
  type RequestFacts,
  type RiskClass,
  type SecretKind,
} from './operations/types';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Plan section 4.2, "Defaults per preset", cell for cell. policy.test.ts compares it to the plan's table. */
export const PRESET_DEFAULTS: Record<AgentPreset, Record<RiskClass, PolicySetting>> = {
  read_only: {
    read: 'allow',
    read_sensitive: 'never',
    prepare: 'never',
    enter: 'never',
    change: 'never',
    bulk: 'never',
    remove: 'never',
    period: 'never',
    outside: 'never',
    print: 'never',
    settings: 'never',
    admin: 'never',
    file: 'never',
    secret: 'never',
  },
  ask_every_change: {
    read: 'allow',
    read_sensitive: 'ask',
    prepare: 'allow',
    enter: 'ask',
    change: 'ask',
    bulk: 'ask',
    remove: 'ask',
    period: 'ask',
    outside: 'ask',
    print: 'ask',
    settings: 'ask',
    admin: 'never',
    file: 'never',
    secret: 'never',
  },
  trusted_bookkeeper: {
    read: 'allow',
    read_sensitive: 'ask',
    prepare: 'allow',
    enter: 'allow',
    change: 'allow',
    bulk: 'ask',
    remove: 'ask',
    period: 'ask',
    outside: 'ask',
    print: 'ask',
    settings: 'ask',
    admin: 'never',
    file: 'ask',
    secret: 'never',
  },
  full_with_asks: {
    read: 'allow',
    read_sensitive: 'ask',
    prepare: 'allow',
    enter: 'allow',
    change: 'allow',
    bulk: 'allow',
    remove: 'ask',
    period: 'ask',
    outside: 'ask',
    print: 'ask',
    settings: 'ask',
    admin: 'ask',
    file: 'ask',
    secret: 'ask',
  },
};

/** D2: a new agent starts at "Ask for every change". Also what an unknown stored preset falls back to. */
export const DEFAULT_PRESET: AgentPreset = 'ask_every_change';

/** The count cap "Full, with asks" comes with, and the cap any policy gets once it allows `bulk`. */
export const DEFAULT_BULK_CAP = 200;

/** Days a pending request waits before it expires when nothing else is set (plan 4.3). */
export const DEFAULT_REQUEST_EXPIRY_DAYS = 7;

/** Longest standing window for the classes whose grants are "short" (plan 4.2, D5). */
export const SHORT_GRANT_MINUTES = 30;

/** Longest standing window for every other grantable class: "until end of day" can never exceed a day. */
const FULL_DAY_MINUTES = 24 * 60;

export function isAgentPreset(v: unknown): v is AgentPreset {
  return typeof v === 'string' && (AGENT_PRESETS as readonly string[]).includes(v);
}

export function isPolicySetting(v: unknown): v is PolicySetting {
  return typeof v === 'string' && (POLICY_SETTINGS as readonly string[]).includes(v);
}

/** The bulk cap a preset comes with: only "Full, with asks" allows bulk work, so only it has one. */
export function presetBulkCap(preset: AgentPreset): number | null {
  return preset === 'full_with_asks' ? DEFAULT_BULK_CAP : null;
}

/** The preset an agent made under the old three modes is moved to (plan 4.2 and 12). */
export function presetForMode(mode: AgentMode): AgentPreset {
  if (mode === 'post') return 'trusted_bookkeeper';
  if (mode === 'propose') return 'ask_every_change';
  return 'read_only';
}

/** Whether a class may be set to Allow at all (plan 4.2, "Can be Allow?"). */
export function canBeAllowed(cls: RiskClass): boolean {
  return !NEVER_ALLOW_CLASSES.includes(cls);
}

// ---------------------------------------------------------------------------
// Resolving a stored policy
// ---------------------------------------------------------------------------

/**
 * The parts of a policy that are not a class setting, as stored per agent. Anything left out takes
 * the preset's value. (Kept here because the shared types only have the resolved AgentPolicy.)
 */
export interface PolicyLimits {
  /**
   * Most records one request may change. It holds for every request that reports a count, bulk or
   * not (see decide). null: not capped (only while bulk is not allowed; see resolvePolicy).
   */
  bulkCap?: number | null;
  /** Decimal text, or null for off. */
  twoPersonOver?: string | null;
  requestExpiryDays?: number;
  folders?: string[];
  notifyEmail?: boolean;
  /**
   * When the agent was paused. The column is a timestamp, so a row read straight from the
   * database holds a Date; both are taken. Any other value that is set still means paused.
   */
  pausedAt?: string | Date | null;
}

/**
 * Whether a stored pause value means the agent is paused. Only "nothing there" means running:
 * a value of the wrong shape keeps the agent paused, because the kill switch must never fail open.
 */
export function isPaused(v: unknown): boolean {
  return !(v === null || v === undefined || v === '');
}

function readPausedAt(v: unknown): { pausedAt: string | null; problem: string | null } {
  if (!isPaused(v)) return { pausedAt: null, problem: null };
  if (typeof v === 'string') return { pausedAt: v, problem: null };
  const isDate = Object.prototype.toString.call(v) === '[object Date]';
  if (isDate && Number.isFinite((v as Date).getTime())) return { pausedAt: (v as Date).toISOString(), problem: null };
  const text = String(v).trim() || 'unknown';
  return {
    pausedAt: text,
    problem: `The time this agent was paused ("${text}") could not be read, so it stays paused until a person turns it back on.`,
  };
}

const STRICTNESS: Record<PolicySetting, number> = { allow: 0, ask: 1, never: 2 };

function stricter(a: PolicySetting, b: PolicySetting): PolicySetting {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

function settingLabel(s: PolicySetting): string {
  return s === 'allow' ? 'Allow' : s === 'ask' ? 'Ask' : 'Never';
}

const isArea = (v: unknown): v is Area => typeof v === 'string' && (AREA_KEYS as string[]).includes(v);

function where(cls: RiskClass, area: Area | null): string {
  return area ? `"${RISK_CLASS_LABELS[cls]}" in ${areaLabel(area)}` : `"${RISK_CLASS_LABELS[cls]}"`;
}

function resolveWithProblems(
  presetIn: AgentPreset,
  overrides: readonly PolicyOverride[],
  limits: PolicyLimits,
): { policy: AgentPolicy; problems: string[] } {
  const problems: string[] = [];
  let preset = presetIn;
  if (!isAgentPreset(preset)) {
    problems.push(
      `The saved starting point ("${String(presetIn)}") is not one Ironbooks knows, so "Ask for every change" is used.`,
    );
    preset = DEFAULT_PRESET;
  }

  const classes = { ...PRESET_DEFAULTS[preset] };
  const areas: AgentPolicy['areas'] = {};

  // Saved rows are applied over the preset. Two rows for the same cell (which the Agents tab never
  // writes, but a stored list can hold) are settled by the stricter one, so the order rows come
  // back in can never loosen anything.
  const seen = new Map<string, PolicySetting>();
  for (const row of overrides ?? []) {
    if (!row || !isRiskClass(row.class)) {
      problems.push(`A saved setting for an unknown kind of work ("${String(row?.class)}") was ignored.`);
      continue;
    }
    if (row.area !== null && row.area !== undefined && !isArea(row.area)) {
      problems.push(`A saved setting for an unknown area ("${String(row.area)}") was ignored.`);
      continue;
    }
    if (!isPolicySetting(row.setting)) {
      problems.push(
        `A saved setting for ${where(row.class, row.area ?? null)} ("${String(row.setting)}") was not understood and was ignored.`,
      );
      continue;
    }
    const area = row.area ?? null;
    const key = `${area ?? ''}|${row.class}`;
    let setting: PolicySetting = row.setting;
    const before = seen.get(key);
    if (before !== undefined && before !== setting) {
      setting = stricter(before, setting);
      problems.push(
        `${where(row.class, area)} was saved twice with different settings; the stricter one (${settingLabel(setting)}) is used.`,
      );
    }
    seen.set(key, setting);
    if (area) areas[area] = { ...(areas[area] ?? {}), [row.class]: setting };
    else classes[row.class] = setting;
  }

  // A class that can never be Allow is held at Ask, in the class map and in every area.
  for (const cls of RISK_CLASSES) {
    if (classes[cls] === 'allow' && !canBeAllowed(cls)) {
      classes[cls] = 'ask';
      problems.push(`${where(cls, null)} can never be set to Allow for an agent, so it is set to Ask.`);
    }
  }
  for (const area of AREA_KEYS) {
    const row = areas[area];
    if (!row) continue;
    for (const cls of RISK_CLASSES) {
      if (row[cls] === 'allow' && !canBeAllowed(cls)) {
        row[cls] = 'ask';
        problems.push(`${where(cls, area)} can never be set to Allow for an agent, so it is set to Ask.`);
      }
    }
  }

  // Bulk work may be Allow only with a count cap (plan 4.2): a policy that allows it anywhere and
  // has no valid cap gets the default one rather than none.
  const allowsBulk = classes.bulk === 'allow' || AREA_KEYS.some((a) => areas[a]?.bulk === 'allow');
  let bulkCap: number | null = limits.bulkCap === undefined ? presetBulkCap(preset) : limits.bulkCap;
  if (bulkCap !== null && !(Number.isInteger(bulkCap) && bulkCap > 0)) {
    problems.push(
      `The most records per request ("${String(bulkCap)}") must be a whole number above zero, so ${DEFAULT_BULK_CAP} is used.`,
    );
    bulkCap = DEFAULT_BULK_CAP;
  }
  if (bulkCap === null && allowsBulk) {
    problems.push(
      `"${RISK_CLASS_LABELS.bulk}" is set to Allow, so at most ${DEFAULT_BULK_CAP} records may be changed in one request.`,
    );
    bulkCap = DEFAULT_BULK_CAP;
  }

  // Two-person approval: a threshold that cannot be read as an amount is not silently dropped
  // (that would turn the safeguard off); every amount above zero then needs two people.
  let twoPersonOver: string | null = limits.twoPersonOver ?? null;
  if (twoPersonOver !== null) {
    const d = parseDecimal(twoPersonOver);
    if (!d || d.isNegative()) {
      problems.push(
        `The amount for two-person approval ("${twoPersonOver}") could not be used, so every amount above zero ` +
          'needs two people until it is fixed.',
      );
      twoPersonOver = '0';
    }
  }

  let requestExpiryDays = limits.requestExpiryDays ?? DEFAULT_REQUEST_EXPIRY_DAYS;
  if (!(Number.isInteger(requestExpiryDays) && requestExpiryDays > 0)) {
    problems.push(
      `Days a request waits ("${String(requestExpiryDays)}") must be a whole number above zero, ` +
        `so ${DEFAULT_REQUEST_EXPIRY_DAYS} is used.`,
    );
    requestExpiryDays = DEFAULT_REQUEST_EXPIRY_DAYS;
  }

  const folders = Array.isArray(limits.folders)
    ? limits.folders.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    : [];

  const paused = readPausedAt(limits.pausedAt);
  if (paused.problem) problems.push(paused.problem);

  return {
    policy: {
      preset,
      classes,
      areas,
      bulkCap,
      twoPersonOver,
      requestExpiryDays,
      folders,
      notifyEmail: limits.notifyEmail === true,
      pausedAt: paused.pausedAt,
    },
    problems,
  };
}

/** An agent's policy: the preset's defaults, the saved overrides on top, and the limits. */
export function resolvePolicy(preset: AgentPreset, overrides: readonly PolicyOverride[], limits: PolicyLimits = {}): AgentPolicy {
  return resolveWithProblems(preset, overrides, limits).policy;
}

/**
 * Why the resolved policy differs from what was saved, in plain words, for the Agents tab to show
 * next to a locked or adjusted cell. Empty when everything was taken as saved.
 */
export function policyProblems(preset: AgentPreset, overrides: readonly PolicyOverride[], limits: PolicyLimits = {}): string[] {
  return resolveWithProblems(preset, overrides, limits).problems;
}

/**
 * The setting for one class, the area override first. A value that is missing or not understood
 * counts as Never, and a class that can never be Allow is Ask even in a policy built by hand.
 */
export function settingFor(policy: AgentPolicy, area: Area | null, cls: RiskClass): PolicySetting {
  const fromArea = area ? policy.areas?.[area]?.[cls] : undefined;
  const raw = fromArea !== undefined ? fromArea : policy.classes?.[cls];
  const s: PolicySetting = isPolicySetting(raw) ? raw : 'never';
  return s === 'allow' && !canBeAllowed(cls) ? 'ask' : s;
}

// ---------------------------------------------------------------------------
// The class a request is judged under
// ---------------------------------------------------------------------------

/**
 * How strict a class is, for "never lowers". Classes that can be Allow come first; every class
 * that can never be Allow ranks above all of them, and the Admin-only classes rank highest.
 */
const CLASS_RANK: Record<RiskClass, number> = {
  read: 0,
  prepare: 1,
  enter: 2,
  change: 3,
  bulk: 4,
  read_sensitive: 5,
  print: 6,
  outside: 7,
  remove: 8,
  period: 9,
  settings: 10,
  admin: 11,
  file: 12,
  secret: 13,
};

export function classRank(cls: RiskClass): number {
  return CLASS_RANK[cls];
}

/**
 * Classes whose requests can land in the books, so the closing date applies to them. Not only the
 * everyday writing classes: an operation is classed by its riskiest effect, so some that write are
 * filed elsewhere. Income Tracker's convert enters invoices but is `outside`, confirming printed
 * checks writes check numbers but is `print`, and a settings or company-file change can carry a
 * date too. `admin` and `secret` stay in because an operation nobody classified is judged as
 * `admin`, and it may write anything (fail closed).
 *
 * Left out: the two read classes, and `prepare`, which never reaches the books (plan 4.2). A person
 * may stage old statement lines or tick an old reconciliation without the closed-period right, so
 * an agent with the same role may too.
 */
const CLOSING_DATE_CLASSES: readonly RiskClass[] = RISK_CLASSES.filter(
  (c) => c !== 'read' && c !== 'read_sensitive' && c !== 'prepare',
);

/**
 * Classes where a reconciled-edit or ledger-rewrite flag makes the request closed-period work. Only
 * the everyday writing classes: on the others the flag already keeps a grant from covering the
 * request (grantCovers), and their setting can never be Allow.
 */
const HISTORY_FLAG_CLASSES: readonly RiskClass[] = ['prepare', 'enter', 'change', 'bulk', 'remove'];

/** Warning flags that rewrite reconciled or posted history: always a person's question (plan 5.6). */
export const PERIOD_CONFIRM_FLAGS: readonly string[] = ['allowReconciledEdit', 'allowLedgerRewrite'];

// The engine is the last gate, so request facts of the wrong shape are read the strict way, and
// every rule reads them through these, so no two rules can disagree about the same request.

/** The request is dated on or before the closing date. Any value that is set counts. */
function closedPeriodAsked(facts: RequestFacts): boolean {
  return Boolean(facts.closedPeriod);
}

/** The agent asked for unmasked values. Any value that is set counts. */
function revealAsked(facts: RequestFacts): boolean {
  return Boolean(facts.reveal);
}

/**
 * The "yes, I am sure" flags the agent sent. A single flag sent as text counts as that flag; any
 * other value, or a list entry that is not text, is read as a history-rewriting flag (the strictest).
 */
function readConfirm(v: unknown): { any: boolean; period: boolean } {
  if (v === null || v === undefined || v === '') return { any: false, period: false };
  const list: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [null];
  if (list.length === 0) return { any: false, period: false };
  return { any: true, period: list.some((f) => typeof f !== 'string' || PERIOD_CONFIRM_FLAGS.includes(f)) };
}

/** The operation's own class. An operation nobody classified is treated as `admin`: Ask an Admin at most. */
export function baseClass(operation: Pick<Operation, 'classified' | 'class'>): RiskClass {
  return operation.classified && isRiskClass(operation.class) ? operation.class : 'admin';
}

/**
 * Every class a request falls under: the operation's own first, then each one a fact of the
 * request adds. The policy setting used is the strictest of all of them, so adding a fact can
 * never loosen what the Admin set (a reveal on an operation set to Never is still Never).
 */
export function requestClasses(operation: Pick<Operation, 'classified' | 'class'>, facts: RequestFacts): RiskClass[] {
  const base = baseClass(operation);
  const out: RiskClass[] = [base];
  const add = (c: RiskClass) => {
    if (!out.includes(c)) out.push(c);
  };
  const confirm = readConfirm(facts.confirm);
  if (revealAsked(facts)) add('read_sensitive');
  if (CLOSING_DATE_CLASSES.includes(base) && closedPeriodAsked(facts)) add('period');
  if (HISTORY_FLAG_CLASSES.includes(base) && confirm.period) add('period');
  // Any other "yes, I am sure" flag makes the request one class higher (plan 5.6).
  if (confirm.any) {
    if (base === 'prepare') add('enter');
    if (base === 'enter') add('change');
  }
  return out;
}

/** The class a request is judged under: the strictest of `requestClasses`. Never below the operation's own. */
export function effectiveClass(operation: Pick<Operation, 'classified' | 'class'>, facts: RequestFacts): RiskClass {
  let best = baseClass(operation);
  for (const c of requestClasses(operation, facts)) if (CLASS_RANK[c] > CLASS_RANK[best]) best = c;
  return best;
}

/**
 * Whether the request is closed-period work in the sense of the closing date (and so needs the
 * closed-period right and the closing-date password): an operation that is itself `period` (moving
 * the closing date), or a book-writing request dated on or before it. A reconciled edit raised to
 * `period` is not: a person editing a reconciled entry needs neither.
 */
function closingDateWork(operation: Pick<Operation, 'classified' | 'class'>, facts: RequestFacts): boolean {
  return baseClass(operation) === 'period' || closedPeriodWrite(operation, facts);
}

/** A request that can write to the books, dated on or before the closing date (any class in CLOSING_DATE_CLASSES). */
function closedPeriodWrite(operation: Pick<Operation, 'classified' | 'class'>, facts: RequestFacts): boolean {
  return CLOSING_DATE_CLASSES.includes(baseClass(operation)) && closedPeriodAsked(facts);
}

// ---------------------------------------------------------------------------
// The role (the ceiling)
// ---------------------------------------------------------------------------

function verbFor(action: Action): string {
  return action === 'view' ? 'view' : action === 'print' ? 'print or export' : action;
}

function rightInWords(area: Area, action: Action, activity: string | null): string {
  const what = activity && activityDef(activity) ? `${activityLabel(activity)} (${areaLabel(area)})` : areaLabel(area);
  return `the right to ${verbFor(action)} ${what}`;
}

function checkRight(access: EffectiveAccess, area: Area, action: Action, activity: string | null): string | null {
  // The same two checks lib/permissions/enforce.ts assertRule makes for a person: the route's
  // activity when it has one, otherwise every activity of the area (fail closed).
  const ok = activity ? canActivity(access, activity, action) : canWholeArea(access, area, action);
  return ok ? null : rightInWords(area, action, activity);
}

/**
 * What the agent's role is missing for this operation, in words ("the right to create Invoices
 * (Customers & Receivables)"), or null when the role allows it. The same check a person's request
 * meets for the route and method. An Admin role passes as a ceiling (D1); the policy still decides
 * what it may do without asking.
 */
export function roleProblem(access: EffectiveAccess, operation: Operation): string | null {
  const rule = operation.rule;
  if (rule === 'public' || rule === 'self' || rule === 'member') return null;
  if (rule && typeof rule === 'object') return checkRight(access, rule.area, rule.action, operation.activity);
  if (routeWithoutRule(operation)) {
    // A route with no entry in the permission map is denied to everyone, an Admin too.
    return 'a permission rule, and Ironbooks has none for this request';
  }
  // A desktop action has no route rule. When the registry names its area and action, the role
  // needs that right; otherwise only an Admin passes (as for a request nothing could authorize).
  if (operation.area && operation.action) return checkRight(access, operation.area, operation.action, operation.activity);
  return access.isAdmin ? null : 'the Admin role';
}

/**
 * A route the permission map has no rule for. roleProblem refuses it for every role, an Admin too,
 * so decide tells the agent to ask a person rather than to ask for a role change that cannot help
 * (NO_RULE_FOR_AGENT), and no person can approve it either (NO_RULE_FOR_APPROVER, for the approval
 * center: lib/services/agentRequests.ts).
 */
export function routeWithoutRule(operation: Pick<Operation, 'rule' | 'kind'>): boolean {
  const rule = operation.rule;
  if (rule === 'public' || rule === 'self' || rule === 'member') return false;
  if (rule && typeof rule === 'object') return false;
  return operation.kind === 'route';
}

/** Whether the agent's role allows the operation at all (see roleProblem). */
export function roleAllows(access: EffectiveAccess, operation: Operation): boolean {
  return roleProblem(access, operation) === null;
}

/**
 * The role flags a request needs on top of the route's right, as a person would: anything that can
 * write to the books dated on or before the closing date needs "Modify transactions on or before
 * the closing date" (without it a person cannot use the closing-date password either), whatever
 * class the operation is filed under, and unmasking needs the matching View flag. Moving the
 * closing date itself needs only the route's right, as for a person, unless the request is itself
 * dated on or before the closing date. The plan moves these flags from the agent clamp into the
 * classes; the role is still the ceiling, so an agent whose role lacks the flag is refused instead
 * of asking for something its role could never run.
 */
export function flagsNeeded(operation: Pick<Operation, 'classified' | 'class' | 'reveal'>, facts: RequestFacts): Flag[] {
  const out: Flag[] = [];
  if (closedPeriodWrite(operation, facts)) out.push('closedPeriod');
  const revealFlag = revealFlagFor(operation, facts);
  if (revealFlag) out.push(revealFlag);
  return out;
}

/** The View flag a reveal needs, from what the operation reveals; null when nothing is revealed. */
function revealFlagFor(operation: Pick<Operation, 'reveal'>, facts: RequestFacts): 'sensitivePayroll' | 'fullAccountNumbers' | null {
  if (!revealAsked(facts) || !operation.reveal) return null;
  return operation.reveal === 'account_numbers' ? 'fullAccountNumbers' : 'sensitivePayroll';
}

function flagLabel(flag: Flag): string {
  return FLAGS.find((f) => f.key === flag)?.label ?? flag;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

function parseDecimal(v: unknown): Decimal | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function parseTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** "2026-11-20" from an ISO date or date-time, or null. */
function dayOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : null;
}

function idsWithin(asked: unknown, allowed: unknown): boolean {
  // A request that names nothing cannot be shown to stay within the ticked names (fail closed).
  if (!Array.isArray(allowed) || !Array.isArray(asked) || asked.length === 0) return false;
  return asked.every((id) => typeof id === 'string' && allowed.includes(id));
}

/**
 * Whether a live grant covers this request. A grant is standing permission for one operation, so
 * anything that makes the request a different question than the one the person answered is never
 * covered: a class that is not grantable, an operation that always asks, a request raised to a
 * stricter class, a reveal, or a "yes, I am sure" flag after a warning.
 */
export function grantCovers(grant: AgentGrant, operation: Operation, facts: RequestFacts, now: string): boolean {
  if (!grant || grant.operation !== operation.id) return false;
  if (grant.revokedAt) return false;
  const at = parseTime(now);
  const until = parseTime(grant.expiresAt);
  if (at === null || until === null || at >= until) return false;

  const own = baseClass(operation);
  const grantable = GRANTABLE[own];
  if (grantable === 'no' || operation.alwaysAsk) return false;
  // A grant whose time left is longer than anyone may give for this class covers nothing: a bad
  // stored expiry, or an operation reclassified since (enter to outside), must not leave a
  // day-long window open on a class that allows half an hour at most.
  const longest = (grantable === 'short' ? SHORT_GRANT_MINUTES : FULL_DAY_MINUTES) * 60_000;
  if (until - at > longest) return false;
  if (effectiveClass(operation, facts) !== own) return false;
  if (revealAsked(facts) || closedPeriodAsked(facts) || readConfirm(facts.confirm).any) return false;

  const c = grant.constraints ?? {};
  if (c.maxUses !== undefined) {
    if (!(Number.isInteger(grant.uses) && grant.uses >= 0 && grant.uses < c.maxUses)) return false;
  }
  if (c.entityIds !== undefined && !idsWithin(facts.entityIds, c.entityIds)) return false;
  if (c.accountIds !== undefined && !idsWithin(facts.accountIds, c.accountIds)) return false;
  if (c.maxAmount !== undefined) {
    // Compared as decimals, by size: a large refund is as large as a large charge.
    const max = parseDecimal(c.maxAmount);
    const amount = parseDecimal(facts.amount);
    if (!max || !amount || amount.abs().greaterThan(max)) return false;
  }
  if (c.dateFrom !== undefined || c.dateTo !== undefined) {
    const day = dayOf(facts.date);
    if (!day) return false;
    if (c.dateFrom !== undefined) {
      const from = dayOf(c.dateFrom);
      if (!from || day < from) return false;
    }
    if (c.dateTo !== undefined) {
      const to = dayOf(c.dateTo);
      if (!to || day > to) return false;
    }
  }
  // A "capped" grant (bulk) always carries its count cap; one without it covers nothing.
  if (grantable === 'capped' && c.maxCount === undefined) return false;
  if (c.maxCount !== undefined) {
    const n = facts.count;
    if (typeof c.maxCount !== 'number' || !Number.isFinite(c.maxCount)) return false;
    if (typeof n !== 'number' || !Number.isFinite(n) || n > c.maxCount) return false;
  }
  return true;
}

/**
 * The longest standing window (in minutes) a person may give while approving a request of this
 * class: none for classes asked one by one, 30 minutes for the short ones, and until the end of the
 * day for the rest. `minutesLeftToday` is the time to the end of the company's day
 * (`minutesToEndOfDay`). It is required: the engine does not know the time zone, and a default of
 * a full day would let a grant given at 11 pm run until 11 pm the next day.
 */
export function maxGrantMinutes(cls: RiskClass, minutesLeftToday: number): number {
  const g = isRiskClass(cls) ? GRANTABLE[cls] : 'no';
  if (g === 'no') return 0;
  const left = Number.isFinite(minutesLeftToday) ? Math.max(0, Math.floor(minutesLeftToday)) : 0;
  if (g === 'short') return Math.min(SHORT_GRANT_MINUTES, left);
  return Math.min(FULL_DAY_MINUTES, left);
}

/**
 * Whole minutes from `now` to the next local midnight, for `maxGrantMinutes`. `utcOffsetMinutes` is
 * the company's offset from UTC in force at `now` (east positive: -300 for New York in winter, which
 * is `-new Date(now).getTimezoneOffset()` on the host). A time or offset it cannot read gives 0, so
 * no standing window is offered rather than a wrong one.
 */
export function minutesToEndOfDay(now: string, utcOffsetMinutes: number): number {
  const t = parseTime(now);
  if (t === null || !Number.isFinite(utcOffsetMinutes)) return 0;
  const day = FULL_DAY_MINUTES * 60_000;
  const local = t + Math.trunc(utcOffsetMinutes) * 60_000;
  const intoDay = ((local % day) + day) % day;
  return Math.floor((day - intoDay) / 60_000);
}

/**
 * Classes whose standing window only an Admin may give: D5 lets an Admin give a short window for
 * a batch of outside sends (month-end statements). approvalNeeds reports it as `grantAdminOnly`,
 * and the approval center can also ask `grantNeedsAdmin` directly.
 */
export const ADMIN_GRANT_CLASSES: readonly RiskClass[] = ['outside'];

/** Whether only an Admin may give standing permission while approving this request (D5). */
export function grantNeedsAdmin(operation: Pick<Operation, 'classified' | 'class'>, facts: RequestFacts): boolean {
  return requestClasses(operation, facts).some((c) => ADMIN_GRANT_CLASSES.includes(c) || ADMIN_APPROVAL_CLASSES.includes(c));
}

// ---------------------------------------------------------------------------
// What an approval needs
// ---------------------------------------------------------------------------

const GRANTABLE_STRICTNESS = { yes: 0, capped: 1, short: 2, no: 3 } as const;
type Grantable = keyof typeof GRANTABLE_STRICTNESS;

/** The two classes that only read. A read never needs two people, whatever amount it names. */
const READ_CLASSES: readonly RiskClass[] = ['read', 'read_sensitive'];

/**
 * Classes that change the books whether or not the operation names its amount: with a two-person
 * threshold set, a request of one of these whose amount is not known counts as above it (D8).
 */
const TWO_PERSON_BOOK_CLASSES: readonly RiskClass[] = ['enter', 'change', 'bulk', 'remove', 'period'];

/**
 * Whether the request needs two different people (D8): a threshold is set and the amount is above
 * it, compared as decimals by size. Reads never do. When nobody can show the amount is below the
 * threshold, it counts as above it:
 *  - an amount that cannot be read;
 *  - no amount, on a request that changes the books (enter, change, bulk, remove, period, a
 *    request raised to period by its closing date), or on any other operation that has an amount
 *    (`amountField`: an outside send or a print run that pays or posts money);
 *  - no amount, and the caller did not say what the operation is, or nobody classified it.
 * The caller (lib/agent/operate.ts) decides a second time with the facts of the dry run. That
 * second decision clears this rule only when the dry run reports an amount. For an operation with
 * no `amountField` the door reports "0.00" when the run only made new records and moved no money
 * (a new customer), and keeps the amount unknown when it voided, deleted or changed a record that
 * was there before without touching the ledger (a customer's details, a list entry deleted, a
 * payroll adjustment voided): such a run may move money outside the ledger, so it still needs two
 * people (fail closed). This rule only reads the amount it is given.
 */
export function needsTwoPerson(
  policy: Pick<AgentPolicy, 'twoPersonOver'>,
  facts: Pick<RequestFacts, 'amount'> & Partial<RequestFacts>,
  operation?: (Pick<Operation, 'amountField'> & Partial<Pick<Operation, 'classified' | 'class'>>) | null,
): boolean {
  if (policy.twoPersonOver === null || policy.twoPersonOver === undefined) return false;
  // Every class the request falls under, or null when that cannot be told.
  const classes =
    operation && operation.classified === true && isRiskClass(operation.class)
      ? requestClasses({ classified: true, class: operation.class }, facts as RequestFacts)
      : null;
  if (classes && classes.every((c) => READ_CLASSES.includes(c))) return false;
  if (facts.amount === null || facts.amount === undefined) {
    if (!classes) return true;
    return classes.some((c) => TWO_PERSON_BOOK_CLASSES.includes(c)) || Boolean(operation?.amountField);
  }
  const limit = parseDecimal(policy.twoPersonOver) ?? new Decimal(0);
  const amount = parseDecimal(facts.amount);
  if (!amount) return true;
  return amount.abs().greaterThan(limit);
}

type ApproverFlag = NonNullable<ApprovalNeeds['flag']>;

/** The reveal kinds the engine knows; any other value still asks, but only an Admin may approve it. */
const KNOWN_REVEALS: readonly string[] = ['ssn', 'account_numbers', 'payroll'];

/**
 * Field names that lib/permissions/mask.ts masks, spelled as it spells them, by the View flag that
 * shows them in full (its SSN_KEYS and ACCOUNT_KEYS, which it does not export). A listed field is
 * compared on the last part of its dotted path, ignoring case. policy.test.ts masks each name with
 * only its flag and with only the other one, so a name mask.ts stops masking, or one filed under
 * the wrong flag, fails there instead of asking the wrong person to approve a protected read.
 */
export const FIELD_FLAGS: Readonly<Record<string, ApproverFlag>> = Object.freeze({
  ssn: 'sensitivePayroll',
  employeeSsn: 'sensitivePayroll',
  taxId: 'sensitivePayroll',
  accountNumber: 'fullAccountNumbers',
  routingNumber: 'fullAccountNumbers',
  bankAccountNumber: 'fullAccountNumbers',
});

const FIELD_FLAGS_BY_LOWER_NAME: ReadonlyMap<string, ApproverFlag> = new Map(
  Object.entries(FIELD_FLAGS).map(([name, flag]) => [name.toLowerCase(), flag]),
);

function fieldFlag(path: unknown): ApproverFlag | null {
  if (typeof path !== 'string') return null;
  const last = (path.split('.').pop() ?? '').trim().toLowerCase();
  return FIELD_FLAGS_BY_LOWER_NAME.get(last) ?? null;
}

/** Areas whose protected data is payroll data when nothing else names what it is. */
const PAYROLL_AREAS: readonly Area[] = ['payroll', 'reports_payroll'];

/** The View flag for a reveal kind (as revealFlagFor reads it: anything but account numbers is payroll). */
function revealKindFlag(kind: NonNullable<Operation['reveal']>): ApproverFlag {
  return kind === 'account_numbers' ? 'fullAccountNumbers' : 'sensitivePayroll';
}

/**
 * The View flags whoever approves must hold for the protected data a request would show, and
 * whether the kind of data cannot be told (then only an Admin may approve). Null when the request
 * shows no protected data.
 *
 *  - A reveal on an operation that names what it reveals unmasks only that kind: its flag.
 *  - A `read_sensitive` operation shows its protected data with or without a reveal, so the
 *    approver needs the flag of everything it shows: the kind it names, and every sensitive field
 *    it lists (SSNs and tax IDs: "View sensitive payroll data"; account and routing numbers: "View
 *    full bank / account numbers"). The same goes for a reveal on an operation that names nothing.
 *  - When neither names a kind, a protected read in payroll (or the payroll reports) is payroll
 *    data. Otherwise, or when a listed field is not one of those, the kind cannot be told, and an
 *    Admin approves.
 */
function protectedDataRights(
  operation: Pick<Operation, 'classified' | 'class' | 'reveal' | 'sensitiveFields' | 'area'>,
  facts: RequestFacts,
): { flags: ApproverFlag[]; unknown: boolean } | null {
  const own = baseClass(operation);
  const revealing = revealAsked(facts);
  if (!revealing && own !== 'read_sensitive') return null;

  const kind = operation.reveal ?? null;
  const knownKind = kind !== null && KNOWN_REVEALS.includes(kind);
  if (own !== 'read_sensitive' && kind) return { flags: [revealKindFlag(kind)], unknown: !knownKind };

  const flags: ApproverFlag[] = [];
  const add = (f: ApproverFlag) => {
    if (!flags.includes(f)) flags.push(f);
  };
  let unknown = kind !== null && !knownKind;
  if (kind) add(revealKindFlag(kind));
  const fields: unknown[] = Array.isArray(operation.sensitiveFields) ? operation.sensitiveFields : [];
  for (const path of fields) {
    const f = fieldFlag(path);
    if (f) add(f);
    else unknown = true;
  }
  if (flags.length === 0 && operation.area !== null && PAYROLL_AREAS.includes(operation.area)) add('sensitivePayroll');
  if (flags.length === 0) unknown = true;
  return { flags, unknown };
}

/**
 * Every flag the approver needs themselves, in the order the card shows them: the closed-period
 * right for closing-date work, then the View flags for protected data. `admin` is set when the
 * kind of protected data cannot be told.
 */
function approverRights(operation: Operation, facts: RequestFacts): { flags: ApproverFlag[]; admin: boolean } {
  const flags: ApproverFlag[] = [];
  if (closingDateWork(operation, facts)) flags.push('closedPeriod');
  const data = protectedDataRights(operation, facts);
  for (const f of data?.flags ?? []) if (!flags.includes(f)) flags.push(f);
  return { flags, admin: data?.unknown === true };
}

/**
 * Who must approve a request, what they type, and whether they may give standing permission.
 * `flags` holds every flag the approver needs themselves (a request dated in a closed period that
 * also reveals SSNs needs both); `flag` is the first of them, for callers that read only one.
 */
export function approvalNeeds(
  operation: Operation,
  cls: RiskClass,
  facts: RequestFacts,
  policy: Pick<AgentPolicy, 'twoPersonOver'>,
): ApprovalNeeds {
  const own = baseClass(operation);
  const closing = closingDateWork(operation, facts);
  const rights = approverRights(operation, facts);

  const secrets: SecretKind[] = [...(operation.needsSecret ?? [])];
  if (closing && !secrets.includes('closing_password')) secrets.push('closing_password');

  // The strictest over every class the request falls under, not only the class it is judged
  // under: a reveal on an outside send is still judged as outside, but a reveal is one at a time (D6).
  let grantable: Grantable = isRiskClass(cls) ? GRANTABLE[cls] : 'no';
  for (const c of requestClasses(operation, facts)) {
    if (GRANTABLE_STRICTNESS[GRANTABLE[c]] > GRANTABLE_STRICTNESS[grantable]) grantable = GRANTABLE[c];
  }
  if (revealAsked(facts) || operation.alwaysAsk || !operation.classified) grantable = 'no';

  return {
    admin:
      ADMIN_APPROVAL_CLASSES.includes(cls) || ADMIN_APPROVAL_CLASSES.includes(own) || !operation.classified || rights.admin,
    fileAdmin: operation.fileAdmin === true,
    hostOnly: operation.hostOnly === true,
    flag: rights.flags[0] ?? null,
    flags: rights.flags,
    grantAdminOnly: grantNeedsAdmin(operation, facts),
    secrets,
    twoPerson: needsTwoPerson(policy, facts, operation),
    grantable,
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** What each class lets an agent do, for "An Admin has not allowed agents to ...". */
const CLASS_DOING: Record<RiskClass, string> = {
  read: 'read the books',
  read_sensitive: 'see protected data such as full SSNs or account numbers',
  prepare: 'prepare work for a person to finish',
  enter: 'enter new records',
  change: 'change or void records',
  bulk: 'change many records in one request',
  remove: 'delete records for good',
  period: 'work on or before the closing date',
  outside: 'send anything outside this computer',
  print: 'print',
  settings: 'change company settings',
  admin: 'manage users and security',
  file: 'work with the company file',
  secret: 'handle passwords and keys',
};

// Every refusal says what the agent can do instead: ask a person to do it, ask an Admin to change
// the role or the agent's settings, split the work, or send the request without the part refused.
const ROLE_HINT = "Ask an Admin to change this agent's role.";
/**
 * A route with no permission rule (routeWithoutRule) is refused to every role, an Admin too: a role
 * change cannot help. The agent's words (decide's refusal), and the approving person's.
 */
export const NO_RULE_FOR_AGENT =
  'No role can allow this request, not even Admin, because Ironbooks has no permission rule for it. Ask a person to do it in Ironbooks.';
export const NO_RULE_FOR_APPROVER =
  'No role can allow this request, not even Admin, because Ironbooks has no permission rule for it. Deny it; a person can do the work in Ironbooks if it is still needed.';
const NEVER_HINT = "Ask a person to do it instead, or ask an Admin to change this agent's settings in Users & Roles > Agents.";
const PAUSED =
  'This agent is paused, so it cannot do anything right now. Ask a person to turn it back on in Users & Roles > Agents, then try again.';
const PERSON_ONLY =
  'Only a person can do this, signed in as themselves, so it is not something an agent can ask for. Ask a person to do it in Ironbooks.';
const HARD_FLOOR = "Agents can never do this, even with a person's approval. Ask a person to do it in Ironbooks.";

/** What the agent can do when its role lacks a flag the request needs. */
const FLAG_HINT: Record<Flag, string> = {
  closedPeriod:
    "Ask a person who may change entries on or before the closing date to do it, or ask an Admin to change this agent's role.",
  sensitivePayroll: "Send the request again without asking to see the full values, or ask an Admin to change this agent's role.",
  fullAccountNumbers: "Send the request again without asking to see the full values, or ask an Admin to change this agent's role.",
};

/** A count that can be checked against a cap: a whole number, zero or more. */
function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** A cap that can be checked against: a whole number above zero. */
function isCap(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

function bulkCapMessage(count: unknown, cap: number): string {
  const many = isCount(count) ? String(count) : 'an unknown number of';
  return (
    `This would change ${many} records, more than this agent may change in one request (${cap}). ` +
    'Split it into smaller requests, or ask an Admin to raise the limit.'
  );
}

function refuse(code: RefusalCode, message: string, cls: RiskClass): PolicyDecision {
  return { outcome: 'refuse', code, message, effectiveClass: cls };
}

/**
 * Decide one request: refuse, run (now, or under a grant) or ask a person. In order:
 * paused agent; not open to agents (person only, hard floor); the role, with the flags the request
 * needs; the policy for every class the request falls under (the area's setting first); the count
 * cap; then Allow runs (bulk work only when its count is known and within the cap, and nothing
 * that needs two people), and Ask runs under a live grant that covers it or becomes a permission
 * request. A request that needs more than one approver flag is asked with all of them
 * (`needs.flags`), never refused for it.
 */
export function decide(input: PolicyInput): PolicyDecision {
  const { access, policy, operation, facts, grants, now } = input;
  const cls = effectiveClass(operation, facts);

  if (isPaused(policy.pausedAt)) return refuse('paused', PAUSED, cls);
  if (operation.availability === 'person_only') return refuse('person_only', PERSON_ONLY, cls);
  // Anything the registry did not mark as open to agents is treated as the hard floor (fail closed).
  if (operation.availability !== 'agent') return refuse('hard_floor', HARD_FLOOR, cls);

  const missing = roleProblem(access, operation);
  if (missing) {
    if (routeWithoutRule(operation)) return refuse('role', NO_RULE_FOR_AGENT, cls);
    return refuse('role', `Your role does not allow this: it needs ${missing}. ${ROLE_HINT}`, cls);
  }
  for (const flag of flagsNeeded(operation, facts)) {
    if (!access.flags?.[flag]) {
      return refuse('role', `Your role does not allow this: it needs "${flagLabel(flag)}". ${FLAG_HINT[flag] ?? ROLE_HINT}`, cls);
    }
  }

  // The policy: the strictest setting over every class the request falls under.
  const involved = requestClasses(operation, facts);
  let setting: PolicySetting = 'allow';
  let neverClass: RiskClass | null = null;
  for (const c of involved) {
    const s = settingFor(policy, operation.area, c);
    if (s === 'never' && neverClass === null) neverClass = c;
    setting = stricter(setting, s);
  }
  if (setting === 'never') {
    const c = neverClass ?? cls;
    const inArea = operation.area && policy.areas?.[operation.area]?.[c] !== undefined ? ` in ${areaLabel(operation.area)}` : '';
    return refuse('never', `An Admin has not allowed agents to ${CLASS_DOING[c]}${inArea}. ${NEVER_HINT}`, cls);
  }

  // The count cap. It holds for EVERY operation whose request reports a count, not only class
  // `bulk` (the stricter reading of "most records one request may change"): a batch void filed
  // under `remove`, a queue of sends under `outside` or a print-queue confirm under `print` changes
  // as many records as a bulk request does. It holds whatever the setting, under a grant too: the
  // agent splits the work. A count that was given but is not a whole number of records is above any
  // cap. A request with no count is not refused here; bulk work then asks (below).
  const cap = policy.bulkCap;
  const count: unknown = facts.count;
  const countGiven = count !== null && count !== undefined;
  if (typeof cap === 'number' && countGiven && !(isCount(count) && count <= cap)) {
    return refuse('bulk_cap', bulkCapMessage(count, cap), cls);
  }

  // Bulk work runs without a person only when its size is known to be within a cap (plan 4.2:
  // "Yes, with a per-agent count cap"). An unknown count (a request over every waiting line, a
  // list the agent left out) or a policy with no cap asks instead: the preview shows the real count.
  const bulkWithinCap = !involved.includes('bulk') || (isCap(cap) && isCount(count) && count <= cap);

  const needs = approvalNeeds(operation, cls, facts, policy);
  const mayRunUnasked =
    setting === 'allow' &&
    operation.classified &&
    !operation.alwaysAsk &&
    !needs.twoPerson &&
    bulkWithinCap &&
    involved.every(canBeAllowed);
  if (mayRunUnasked) return { outcome: 'run', effectiveClass: cls, grantId: null };

  // Ask. A grant answers it only when the person could have given one for this very question.
  if (!needs.twoPerson && needs.grantable !== 'no') {
    const grant = (grants ?? []).find((g) => grantCovers(g, operation, facts, now));
    if (grant) return { outcome: 'run', effectiveClass: cls, grantId: grant.id };
  }
  return { outcome: 'ask', effectiveClass: cls, needs };
}
