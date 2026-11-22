/**
 * The policy engine (lib/agent/policy.ts), plan section 10 "Policy matrix": pure and exhaustive.
 * Most tests walk every combination of the inputs that matter instead of picking examples, so a
 * rule that holds here holds for every class, preset, role, setting, grant and request fact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  AREA_KEYS,
  BUILTIN_ROLES,
  builtinRole,
  can,
  unionRoles,
  type Action,
  type Area,
  type EffectiveAccess,
  type RoleDefinition,
} from '@/lib/permissions/model';
import { API_ROUTE_PERMISSIONS, apiActivityFor, apiRuleFor, matchRoutePattern, type HttpMethod } from '@/lib/permissions/routes';
import { assertRule } from '@/lib/permissions/enforce';
import { isMaskedValue, isSensitiveKey, maskSensitive } from '@/lib/permissions/mask';
import {
  ADMIN_APPROVAL_CLASSES,
  AGENT_PRESETS,
  AGENT_PRESET_LABELS,
  GRANTABLE,
  NEVER_ALLOW_CLASSES,
  POLICY_SETTINGS,
  RISK_CLASSES,
  type AgentGrant,
  type AgentPolicy,
  type AgentPreset,
  type Operation,
  type PolicyDecision,
  type PolicyOverride,
  type PolicySetting,
  type RequestFacts,
  type RiskClass,
} from './operations/types';
import {
  DEFAULT_BULK_CAP,
  FIELD_FLAGS,
  NO_RULE_FOR_AGENT,
  NO_RULE_FOR_APPROVER,
  PRESET_DEFAULTS,
  approvalNeeds,
  baseClass,
  batchPassesTwoPerson,
  classRank,
  decide,
  effectiveClass,
  flagsNeeded,
  grantCovers,
  grantNeedsAdmin,
  isPaused,
  maxGrantMinutes,
  minutesToEndOfDay,
  needsTwoPerson,
  policyProblems,
  presetBulkCap,
  presetForMode,
  requestClasses,
  resolvePolicy,
  roleAllows,
  roleProblem,
  routeWithoutRule,
  settingFor,
} from './policy';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const NOW = '2026-11-20T15:00:00.000Z';
/** Inside every grantable class's window, the 30-minute ones included: the grant builder's default. */
const SOON = '2026-11-20T15:20:00.000Z';
const LATER = '2026-11-20T23:59:00.000Z';
const EARLIER = '2026-11-20T14:59:59.000Z';

function op(over: Partial<Operation> = {}): Operation {
  return {
    id: 'invoices.create',
    kind: 'route',
    route: '/api/invoices',
    method: 'POST',
    params: [],
    rule: { area: 'customers', action: 'create' },
    area: 'customers',
    action: 'create',
    activity: null,
    classified: true,
    class: 'enter',
    describe: 'Enter an invoice',
    availability: 'agent',
    why: null,
    dryRun: 'transaction',
    body: 'json',
    output: 'json',
    confirmFlags: [],
    sensitiveFields: [],
    reveal: null,
    hostOnly: false,
    fileAdmin: false,
    needsSecret: [],
    producesSecret: [],
    effects: [],
    countField: null,
    amountField: null,
    alwaysAsk: false,
    bodySchema: null,
    ...over,
  };
}

function facts(over: Partial<RequestFacts> = {}): RequestFacts {
  return {
    confirm: [],
    reveal: false,
    amount: null,
    count: null,
    entityIds: [],
    accountIds: [],
    date: null,
    closedPeriod: false,
    ...over,
  };
}

function grant(over: Partial<AgentGrant> = {}): AgentGrant {
  return {
    id: 'g1',
    agentId: 'a1',
    operation: 'invoices.create',
    constraints: {},
    givenBy: 'u1',
    expiresAt: SOON,
    revokedAt: null,
    uses: 0,
    ...over,
  };
}

const role = (key: string): EffectiveAccess => unionRoles([builtinRole(key)!]);
const ADMIN = role('admin');
const BOOKKEEPER = role('bookkeeper');
const ACCOUNTANT = role('accountant');
const PAYROLL = role('payroll_processor');
const VIEW_ONLY = role('view_only');

function custom(permissions: RoleDefinition['permissions'], flags: RoleDefinition['flags'] = {}): EffectiveAccess {
  return unionRoles([{ key: 'custom', name: 'Custom', description: '', builtin: false, permissions, flags }]);
}

function run(over: {
  access?: EffectiveAccess;
  policy?: AgentPolicy;
  operation?: Operation;
  facts?: RequestFacts;
  grants?: AgentGrant[];
  now?: string;
}): PolicyDecision {
  return decide({
    access: over.access ?? ADMIN,
    policy: over.policy ?? resolvePolicy('ask_every_change', []),
    operation: over.operation ?? op(),
    facts: over.facts ?? facts(),
    grants: over.grants ?? [],
    now: over.now ?? NOW,
  });
}

/** A policy where every class is set to one value, class-wide and (optionally) in every area. */
function everywhere(setting: PolicySetting, preset: AgentPreset = 'ask_every_change', areas = true): AgentPolicy {
  const rows: PolicyOverride[] = [];
  for (const c of RISK_CLASSES) {
    rows.push({ class: c, area: null, setting });
    if (areas) for (const a of AREA_KEYS) rows.push({ class: c, area: a, setting });
  }
  return resolvePolicy(preset, rows, { bulkCap: 100_000 });
}

/** Request facts that each make a request a different question, alone and together. */
const FACT_VARIANTS: Array<[string, RequestFacts]> = [
  ['plain', facts()],
  ['reveal', facts({ reveal: true })],
  ['closed period', facts({ closedPeriod: true, date: '2025-12-31' })],
  ['duplicate number', facts({ confirm: ['allowDuplicateNumber'] })],
  ['reconciled edit', facts({ confirm: ['allowReconciledEdit'] })],
  ['ledger rewrite', facts({ confirm: ['allowLedgerRewrite'] })],
  ['large amount', facts({ amount: '1000000.00' })],
  ['many records', facts({ count: 5000 })],
  [
    'everything',
    facts({ reveal: true, closedPeriod: true, confirm: ['allowReconciledEdit', 'allowDuplicateNumber'], amount: '5', count: 3 }),
  ],
];

const OUTCOME_STRICTNESS = { run: 0, ask: 1, refuse: 2 } as const;

// ---------------------------------------------------------------------------
// The preset table
// ---------------------------------------------------------------------------

/** Plan section 4.2, "Defaults per preset", copied as written. */
const PLAN_PRESET_TABLE = `
| Class | Read only | Ask for every change (default) | Trusted bookkeeper | Full, with asks |
|---|---|---|---|---|
| read | Allow | Allow | Allow | Allow |
| read_sensitive | Never | Ask | Ask | Ask |
| prepare | Never | Allow | Allow | Allow |
| enter | Never | Ask | Allow | Allow |
| change | Never | Ask | Allow | Allow |
| bulk | Never | Ask | Ask | Allow (cap 200) |
| remove | Never | Ask | Ask | Ask |
| period | Never | Ask | Ask | Ask |
| outside | Never | Ask | Ask | Ask |
| print | Never | Ask | Ask | Ask |
| settings | Never | Ask | Ask | Ask |
| admin | Never | Never | Never | Ask |
| file | Never | Never | Ask | Ask |
| secret | Never | Never | Never | Ask |
`;

function parseTable(md: string) {
  const rows = md
    .trim()
    .split('\n')
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const header = rows[0];
  const presets = header.slice(1).map((label) => {
    const clean = label.replace(/\s*\(default\)$/, '');
    const preset = AGENT_PRESETS.find((p) => AGENT_PRESET_LABELS[p] === clean);
    if (!preset) throw new Error(`Unknown preset column ${label}`);
    return { preset, isDefault: label.endsWith('(default)') };
  });
  const cells: Array<{ preset: AgentPreset; cls: string; setting: string; cap: number | null }> = [];
  for (const r of rows.slice(2)) {
    r.slice(1).forEach((cell, i) => {
      const m = /^(Allow|Ask|Never)(?: \(cap (\d+)\))?$/.exec(cell);
      if (!m) throw new Error(`Unreadable cell ${cell}`);
      cells.push({ preset: presets[i].preset, cls: r[0], setting: m[1].toLowerCase(), cap: m[2] ? Number(m[2]) : null });
    });
  }
  return { presets, cells, classes: rows.slice(2).map((r) => r[0]) };
}

describe('presets', () => {
  it('equal the plan table cell for cell', () => {
    const table = parseTable(PLAN_PRESET_TABLE);
    expect(table.classes).toEqual([...RISK_CLASSES]);
    expect(table.presets.map((p) => p.preset).sort()).toEqual([...AGENT_PRESETS].sort());
    expect(table.cells).toHaveLength(RISK_CLASSES.length * AGENT_PRESETS.length);
    for (const cell of table.cells) {
      expect(PRESET_DEFAULTS[cell.preset][cell.cls as RiskClass], `${cell.preset} ${cell.cls}`).toBe(cell.setting);
    }
    // No extra classes or presets in the code either.
    for (const p of AGENT_PRESETS) expect(Object.keys(PRESET_DEFAULTS[p]).sort()).toEqual([...RISK_CLASSES].sort());
  });

  it('carry the bulk cap the table names, and only that one', () => {
    const table = parseTable(PLAN_PRESET_TABLE);
    for (const p of AGENT_PRESETS) {
      const cap = table.cells.find((c) => c.preset === p && c.cls === 'bulk')!.cap;
      expect(presetBulkCap(p)).toBe(cap);
      expect(resolvePolicy(p, []).bulkCap).toBe(cap);
    }
    expect(presetBulkCap('full_with_asks')).toBe(200);
    expect(DEFAULT_BULK_CAP).toBe(200);
  });

  it('the default preset (D2) is "Ask for every change"', () => {
    const table = parseTable(PLAN_PRESET_TABLE);
    expect(table.presets.find((p) => p.isDefault)?.preset).toBe('ask_every_change');
    expect(resolvePolicy('nonsense' as AgentPreset, []).preset).toBe('ask_every_change');
  });

  it('no preset allows a class that can never be Allow', () => {
    for (const p of AGENT_PRESETS) {
      for (const c of NEVER_ALLOW_CLASSES) expect(PRESET_DEFAULTS[p][c]).not.toBe('allow');
    }
  });

  it('old modes move to the matching preset', () => {
    expect(presetForMode('read_only')).toBe('read_only');
    expect(presetForMode('propose')).toBe('ask_every_change');
    expect(presetForMode('post')).toBe('trusted_bookkeeper');
  });
});

// ---------------------------------------------------------------------------
// resolvePolicy
// ---------------------------------------------------------------------------

describe('resolvePolicy', () => {
  it('a class that can never be Allow resolves to Ask, class-wide and in every area', () => {
    for (const preset of AGENT_PRESETS) {
      for (const cls of RISK_CLASSES) {
        for (const setting of POLICY_SETTINGS) {
          for (const area of [null, ...AREA_KEYS] as Array<Area | null>) {
            const rows: PolicyOverride[] = [{ class: cls, area, setting }];
            const policy = resolvePolicy(preset, rows);
            const got = area ? policy.areas[area]?.[cls] : policy.classes[cls];
            const locked = NEVER_ALLOW_CLASSES.includes(cls) && setting === 'allow';
            expect(got, `${preset} ${cls} ${area} ${setting}`).toBe(locked ? 'ask' : setting);
            expect(settingFor(policy, area, cls)).toBe(locked ? 'ask' : setting);
            const problems = policyProblems(preset, rows);
            if (locked) expect(problems.some((p) => p.includes('can never be set to Allow'))).toBe(true);
          }
        }
      }
    }
  });

  it('nothing in any resolved policy is Allow for a class that can never be Allow', () => {
    for (const preset of AGENT_PRESETS) {
      const policy = everywhere('allow', preset);
      for (const cls of NEVER_ALLOW_CLASSES) {
        expect(policy.classes[cls]).toBe('ask');
        for (const a of AREA_KEYS) expect(policy.areas[a]?.[cls]).toBe('ask');
      }
    }
  });

  it('an area override comes before the class-wide setting', () => {
    const policy = resolvePolicy('ask_every_change', [{ class: 'enter', area: 'banking', setting: 'allow' }]);
    expect(settingFor(policy, 'banking', 'enter')).toBe('allow');
    expect(settingFor(policy, 'payroll', 'enter')).toBe('ask');
    expect(settingFor(policy, null, 'enter')).toBe('ask');
  });

  it('two saved rows for the same cell: the stricter wins, whatever their order', () => {
    for (const [a, b] of [
      ['allow', 'never'],
      ['never', 'allow'],
      ['ask', 'allow'],
      ['allow', 'ask'],
    ] as Array<[PolicySetting, PolicySetting]>) {
      const rows: PolicyOverride[] = [
        { class: 'enter', area: 'banking', setting: a },
        { class: 'enter', area: 'banking', setting: b },
      ];
      const want = a === 'never' || b === 'never' ? 'never' : 'ask';
      expect(resolvePolicy('trusted_bookkeeper', rows).areas.banking?.enter).toBe(want);
      expect(policyProblems('trusted_bookkeeper', rows).join(' ')).toContain('saved twice');
    }
  });

  it('rows it cannot read are ignored and reported', () => {
    const rows = [
      { class: 'nope', area: null, setting: 'allow' },
      { class: 'enter', area: 'nowhere', setting: 'allow' },
      { class: 'enter', area: null, setting: 'sometimes' },
    ] as unknown as PolicyOverride[];
    const policy = resolvePolicy('ask_every_change', rows);
    expect(policy.classes).toEqual(PRESET_DEFAULTS.ask_every_change);
    expect(policy.areas).toEqual({});
    expect(policyProblems('ask_every_change', rows)).toHaveLength(3);
  });

  it('allowing bulk work always comes with a count cap', () => {
    const rows: PolicyOverride[] = [{ class: 'bulk', area: 'banking', setting: 'allow' }];
    expect(resolvePolicy('ask_every_change', rows).bulkCap).toBe(DEFAULT_BULK_CAP);
    expect(resolvePolicy('ask_every_change', rows, { bulkCap: null }).bulkCap).toBe(DEFAULT_BULK_CAP);
    expect(resolvePolicy('ask_every_change', rows, { bulkCap: 50 }).bulkCap).toBe(50);
    expect(resolvePolicy('ask_every_change', [], { bulkCap: null }).bulkCap).toBeNull();
    expect(resolvePolicy('full_with_asks', [], { bulkCap: null }).bulkCap).toBe(DEFAULT_BULK_CAP);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(resolvePolicy('ask_every_change', [], { bulkCap: bad }).bulkCap).toBe(DEFAULT_BULK_CAP);
      expect(policyProblems('ask_every_change', [], { bulkCap: bad })).toHaveLength(1);
    }
  });

  it('limits: defaults, and a two-person amount it cannot read fails closed', () => {
    const p = resolvePolicy('ask_every_change', []);
    expect(p).toMatchObject({ twoPersonOver: null, requestExpiryDays: 7, folders: [], notifyEmail: false, pausedAt: null });
    expect(resolvePolicy('ask_every_change', [], { twoPersonOver: '2500.00' }).twoPersonOver).toBe('2500.00');
    expect(resolvePolicy('ask_every_change', [], { twoPersonOver: 'lots' }).twoPersonOver).toBe('0');
    expect(resolvePolicy('ask_every_change', [], { twoPersonOver: '-5' }).twoPersonOver).toBe('0');
    expect(resolvePolicy('ask_every_change', [], { requestExpiryDays: 0 }).requestExpiryDays).toBe(7);
    expect(resolvePolicy('ask_every_change', [], { requestExpiryDays: 3 }).requestExpiryDays).toBe(3);
    expect(resolvePolicy('ask_every_change', [], { folders: ['C:\\Books', '', 4 as unknown as string] }).folders).toEqual(['C:\\Books']);
    expect(resolvePolicy('ask_every_change', [], { pausedAt: NOW }).pausedAt).toBe(NOW);
    expect(policyProblems('ask_every_change', [])).toEqual([]);
    expect(policyProblems('full_with_asks', [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The matrix: role x class x setting x grant (plan 4.1)
// ---------------------------------------------------------------------------

describe('decision matrix', () => {
  const ROLES: Array<[string, EffectiveAccess]> = [
    ['admin', ADMIN],
    ['bookkeeper', BOOKKEEPER],
    ['view_only', VIEW_ONLY],
    ['reports_only', role('reports_only')],
    ['ar_clerk', role('ar_clerk')],
    ['invoices only', custom({ 'customers.invoices': ['view', 'create'] })],
  ];
  type GrantKind = 'none' | 'live' | 'expired' | 'revoked' | 'other operation' | 'used up';
  const GRANTS: GrantKind[] = ['none', 'live', 'expired', 'revoked', 'other operation', 'used up'];
  function grantOf(kind: GrantKind): AgentGrant[] {
    const live = grant({ id: `g-${kind}`, operation: 'm.op', constraints: { maxCount: 10, maxUses: 5 }, uses: 1 });
    switch (kind) {
      case 'none':
        return [];
      case 'live':
        return [live];
      case 'expired':
        return [{ ...live, expiresAt: EARLIER }];
      case 'revoked':
        return [{ ...live, revokedAt: EARLIER }];
      case 'other operation':
        return [{ ...live, operation: 'm.other' }];
      case 'used up':
        return [{ ...live, uses: 5 }];
    }
  }
  const F = facts({ count: 5 });

  it('gives refuse / run / ask exactly as section 4.1', () => {
    let cases = 0;
    for (const [roleName, access] of ROLES) {
      for (const action of ACTIONS) {
        for (const cls of RISK_CLASSES) {
          for (const setting of POLICY_SETTINGS) {
            for (const kind of GRANTS) {
              const operation = op({ id: 'm.op', class: cls, rule: { area: 'customers', action }, action, activity: null });
              const policy = resolvePolicy('ask_every_change', [{ class: cls, area: null, setting }]);
              const d = run({ access, policy, operation, facts: F, grants: grantOf(kind) });
              const label = `${roleName} ${action} ${cls} ${setting} ${kind}`;
              cases++;

              // Independent expectation, straight from the plan's table.
              const roleOk = can(access, 'customers', action);
              const coerced: PolicySetting = setting === 'allow' && NEVER_ALLOW_CLASSES.includes(cls) ? 'ask' : setting;
              expect(d.effectiveClass, label).toBe(cls);
              if (!roleOk) {
                expect(d, label).toMatchObject({ outcome: 'refuse', code: 'role' });
                continue;
              }
              if (coerced === 'never') {
                expect(d, label).toMatchObject({ outcome: 'refuse', code: 'never' });
                continue;
              }
              if (coerced === 'allow') {
                expect(d, label).toEqual({ outcome: 'run', effectiveClass: cls, grantId: null });
                continue;
              }
              if (kind === 'live' && GRANTABLE[cls] !== 'no') {
                expect(d, label).toEqual({ outcome: 'run', effectiveClass: cls, grantId: 'g-live' });
                continue;
              }
              expect(d.outcome, label).toBe('ask');
              if (d.outcome !== 'ask') continue;
              expect(d.needs.grantable, label).toBe(GRANTABLE[cls]);
              // A protected read that names no kind of data (no reveal, no sensitive field, not in
              // payroll) cannot be told apart, so an Admin approves it.
              expect(d.needs.admin, label).toBe(ADMIN_APPROVAL_CLASSES.includes(cls) || cls === 'read_sensitive');
              expect(d.needs.twoPerson, label).toBe(false);
            }
          }
        }
      }
    }
    expect(cases).toBe(ROLES.length * ACTIONS.length * RISK_CLASSES.length * POLICY_SETTINGS.length * GRANTS.length);
  });

  // Every preset, every class, every setting (and the preset's own), with and without a live grant,
  // for an operation open to agents, a person-only one and one on the hard floor.
  const AVAILABILITIES = ['agent', 'person_only', 'hard_floor'] as const;
  const SETTINGS_OR_PRESET = ['preset', ...POLICY_SETTINGS] as const;

  it('class x setting x preset x grant: refuse / run / ask exactly as section 4.1', () => {
    let cases = 0;
    for (const preset of AGENT_PRESETS) {
      for (const cls of RISK_CLASSES) {
        for (const setting of SETTINGS_OR_PRESET) {
          for (const withGrant of [false, true]) {
            for (const availability of AVAILABILITIES) {
              // A protected read names what it shows, so its approver needs only the View flag.
              const operation = op({ id: 'px.op', class: cls, availability, reveal: cls === 'read_sensitive' ? 'ssn' : null });
              const rows: PolicyOverride[] = setting === 'preset' ? [] : [{ class: cls, area: null, setting }];
              const policy = resolvePolicy(preset, rows);
              const grants = withGrant ? [grant({ id: 'g-px', operation: 'px.op', constraints: { maxCount: 10 } })] : [];
              const d = run({ access: ADMIN, policy, operation, facts: F, grants });
              const label = `${preset} ${cls} ${setting} grant=${withGrant} ${availability}`;
              cases++;

              expect(d.effectiveClass, label).toBe(cls);
              if (availability !== 'agent') {
                expect(d, label).toMatchObject({ outcome: 'refuse', code: availability });
                continue;
              }
              const stored: PolicySetting = setting === 'preset' ? PRESET_DEFAULTS[preset][cls] : setting;
              const coerced: PolicySetting = stored === 'allow' && NEVER_ALLOW_CLASSES.includes(cls) ? 'ask' : stored;
              if (coerced === 'never') {
                expect(d, label).toMatchObject({ outcome: 'refuse', code: 'never' });
                continue;
              }
              if (coerced === 'allow') {
                expect(d, label).toEqual({ outcome: 'run', effectiveClass: cls, grantId: null });
                continue;
              }
              if (withGrant && GRANTABLE[cls] !== 'no') {
                expect(d, label).toEqual({ outcome: 'run', effectiveClass: cls, grantId: 'g-px' });
                continue;
              }
              expect(d.outcome, label).toBe('ask');
              if (d.outcome !== 'ask') continue;
              expect(d.needs, label).toMatchObject({
                grantable: GRANTABLE[cls],
                admin: ADMIN_APPROVAL_CLASSES.includes(cls),
                twoPerson: false,
                flag: cls === 'period' ? 'closedPeriod' : cls === 'read_sensitive' ? 'sensitivePayroll' : null,
              });
            }
          }
        }
      }
    }
    expect(cases).toBe(AGENT_PRESETS.length * RISK_CLASSES.length * SETTINGS_OR_PRESET.length * 2 * AVAILABILITIES.length);
  });

  it('no combination runs a person-only or hard-floor operation, or a never-Allow class without a person', () => {
    const accesses = [ADMIN, ACCOUNTANT, custom({}, { closedPeriod: true, sensitivePayroll: true, fullAccountNumbers: true })];
    let ran = 0;
    let checked = 0;
    for (const preset of AGENT_PRESETS) {
      for (const setting of SETTINGS_OR_PRESET) {
        const policy = setting === 'preset' ? resolvePolicy(preset, [], { twoPersonOver: '1000' }) : everywhere(setting, preset);
        for (const cls of RISK_CLASSES) {
          for (const availability of AVAILABILITIES) {
            for (const reveal of [null, 'ssn', 'account_numbers'] as const) {
              const operation = op({ id: 'inv.op', class: cls, availability, reveal, amountField: 'total' });
              for (const withGrant of [false, true]) {
                const grants = withGrant
                  ? [grant({ id: 'g-inv', operation: 'inv.op', constraints: {} }), grant({ id: 'g-inv-cap', operation: 'inv.op', constraints: { maxCount: 100_000 } })]
                  : [];
                for (const access of accesses) {
                  for (const [fname, f] of FACT_VARIANTS) {
                    const d = run({ access, policy, operation, facts: f, grants });
                    const label = `${preset} ${setting} ${cls} ${availability} ${reveal} grant=${withGrant} ${fname}`;
                    checked++;
                    if (availability !== 'agent') {
                      expect(d, label).toMatchObject({ outcome: 'refuse', code: availability });
                      continue;
                    }
                    if (d.outcome !== 'run') continue;
                    ran++;
                    // Whatever ran either needed no person (every class it falls under may be Allow),
                    // or ran under a grant for its own class, which a person gave.
                    if (NEVER_ALLOW_CLASSES.includes(d.effectiveClass)) {
                      expect(d.grantId, label).not.toBeNull();
                      expect(GRANTABLE[d.effectiveClass], label).not.toBe('no');
                    }
                    if (d.grantId === null) {
                      expect(NEVER_ALLOW_CLASSES.includes(d.effectiveClass), label).toBe(false);
                      // A reveal, or a dated write in a closed period, always has a person in it.
                      expect(f.reveal, label).toBe(false);
                      if (!['read', 'read_sensitive', 'prepare'].includes(cls)) expect(f.closedPeriod, label).toBe(false);
                    } else {
                      expect(d.effectiveClass, label).toBe(cls);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50_000);
    expect(ran).toBeGreaterThan(1000);
  });

  it('area overrides are matched to the operation area', () => {
    const policy = resolvePolicy('ask_every_change', [
      { class: 'enter', area: 'banking', setting: 'allow' },
      { class: 'enter', area: 'payroll', setting: 'never' },
    ]);
    const banking = op({ area: 'banking', rule: { area: 'banking', action: 'create' } });
    const payroll = op({ area: 'payroll', rule: { area: 'payroll', action: 'create' } });
    const customers = op();
    expect(run({ policy, operation: banking }).outcome).toBe('run');
    const refused = run({ policy, operation: payroll });
    expect(refused).toMatchObject({ outcome: 'refuse', code: 'never' });
    if (refused.outcome === 'refuse') {
      expect(refused.message).toBe(
        'An Admin has not allowed agents to enter new records in Employees & Payroll. Ask a person to do it instead, ' +
          "or ask an Admin to change this agent's settings in Users & Roles > Agents.",
      );
    }
    expect(run({ policy, operation: customers }).outcome).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// What no combination can do
// ---------------------------------------------------------------------------

describe('the hard floor and person-only operations', () => {
  it('no preset, override, grant, fact or Admin role makes them anything but refuse', () => {
    const policies: AgentPolicy[] = [];
    for (const preset of AGENT_PRESETS) {
      policies.push(resolvePolicy(preset, []));
      for (const s of POLICY_SETTINGS) policies.push(everywhere(s, preset));
    }
    const accesses = [ADMIN, BOOKKEEPER, custom({}, { closedPeriod: true, sensitivePayroll: true, fullAccountNumbers: true })];
    let cases = 0;
    for (const availability of ['person_only', 'hard_floor'] as const) {
      for (const cls of RISK_CLASSES) {
        for (const classified of [true, false]) {
          for (const alwaysAsk of [false, true]) {
            for (const rule of [{ area: 'customers' as Area, action: 'create' as Action }, 'self' as const, 'public' as const, null]) {
              const operation = op({ id: 'floor.op', class: cls, availability, classified, alwaysAsk, rule, reveal: 'ssn' });
              const grants = [
                grant({ id: 'wide', operation: 'floor.op', constraints: {} }),
                grant({ id: 'capped', operation: 'floor.op', constraints: { maxCount: 100_000 } }),
              ];
              for (const policy of policies) {
                for (const access of accesses) {
                  for (const [, f] of FACT_VARIANTS) {
                    const d = run({ access, policy, operation, facts: f, grants });
                    cases++;
                    expect(d.outcome).toBe('refuse');
                    if (d.outcome === 'refuse') expect(d.code).toBe(availability);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(50_000);
  });

  it('an availability the engine does not know is refused too', () => {
    const d = run({ operation: op({ availability: 'maybe' as Operation['availability'] }), policy: everywhere('allow') });
    expect(d).toMatchObject({ outcome: 'refuse', code: 'hard_floor' });
  });

  it('messages are plain words', () => {
    const person = run({ operation: op({ availability: 'person_only' }) });
    const floor = run({ operation: op({ availability: 'hard_floor' }) });
    expect(person.outcome === 'refuse' && person.message).toBe(
      'Only a person can do this, signed in as themselves, so it is not something an agent can ask for. Ask a person to do it in Ironbooks.',
    );
    expect(floor.outcome === 'refuse' && floor.message).toBe(
      "Agents can never do this, even with a person's approval. Ask a person to do it in Ironbooks.",
    );
  });
});

describe('classes that can never be Allow', () => {
  const policies: Array<[string, AgentPolicy]> = [];
  for (const preset of AGENT_PRESETS) {
    policies.push([`${preset}`, resolvePolicy(preset, [])]);
    policies.push([`${preset} all allow`, everywhere('allow', preset)]);
    policies.push([`${preset} all allow, no areas`, everywhere('allow', preset, false)]);
  }

  it('never run without a grant, and a class asked one by one never runs without a person', () => {
    let checked = 0;
    for (const cls of RISK_CLASSES) {
      for (const classified of [true, false]) {
        for (const alwaysAsk of [false, true]) {
          for (const reveal of [null, 'ssn', 'account_numbers'] as const) {
            const operation = op({ id: 'n.op', class: cls, classified, alwaysAsk, reveal });
            const wide = [
              grant({ id: 'wide', operation: 'n.op', constraints: {} }),
              grant({ id: 'capped', operation: 'n.op', constraints: { maxCount: 100_000 } }),
            ];
            for (const [name, policy] of policies) {
              for (const [fname, f] of FACT_VARIANTS) {
                const label = `${cls} classified=${classified} alwaysAsk=${alwaysAsk} ${reveal} ${name} ${fname}`;
                const without = run({ policy, operation, facts: f, grants: [] });
                if (NEVER_ALLOW_CLASSES.includes(without.effectiveClass)) {
                  expect(without.outcome, label).not.toBe('run');
                  checked++;
                }
                const withGrants = run({ policy, operation, facts: f, grants: wide });
                if (withGrants.outcome === 'run') {
                  // Whatever ran with a grant at hand either needed none, or ran under one for its own class.
                  if (withGrants.grantId) expect(withGrants.effectiveClass, label).toBe(baseClass(operation));
                  if (NEVER_ALLOW_CLASSES.includes(withGrants.effectiveClass)) {
                    expect(withGrants.grantId, label).not.toBeNull();
                    expect(GRANTABLE[withGrants.effectiveClass], label).not.toBe('no');
                  }
                }
                if (NEVER_ALLOW_CLASSES.includes(withGrants.effectiveClass) && GRANTABLE[withGrants.effectiveClass] === 'no') {
                  expect(withGrants.outcome, label).not.toBe('run');
                }
                if (alwaysAsk || !classified) expect(withGrants.outcome, label).not.toBe('run');
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('the Admin role is a ceiling only: Admin-only classes still ask an Admin (D1)', () => {
    const policy = everywhere('allow', 'full_with_asks');
    for (const cls of ADMIN_APPROVAL_CLASSES) {
      const d = run({ access: ADMIN, policy, operation: op({ class: cls }) });
      expect(d.outcome).toBe('ask');
      if (d.outcome === 'ask') {
        expect(d.needs.admin).toBe(true);
        expect(d.needs.grantable).toBe('no');
      }
    }
  });

  it('an unclassified operation is Ask an Admin at most, whatever its stored class', () => {
    for (const cls of RISK_CLASSES) {
      const operation = op({ classified: false, class: cls });
      expect(effectiveClass(operation, facts())).toBe('admin');
      const asked = run({ policy: everywhere('allow', 'full_with_asks'), operation, grants: [grant({ constraints: {} })] });
      expect(asked).toMatchObject({ outcome: 'ask', effectiveClass: 'admin' });
      if (asked.outcome === 'ask') expect(asked.needs).toMatchObject({ admin: true, grantable: 'no' });
      expect(run({ policy: resolvePolicy('ask_every_change', []), operation })).toMatchObject({ outcome: 'refuse', code: 'never' });
    }
  });
});

// ---------------------------------------------------------------------------
// Paused, alwaysAsk, the role
// ---------------------------------------------------------------------------

describe('a paused agent', () => {
  it('is refused everything, before anything else is looked at', () => {
    const policy = { ...everywhere('allow', 'full_with_asks'), pausedAt: EARLIER };
    for (const cls of RISK_CLASSES) {
      for (const availability of ['agent', 'person_only', 'hard_floor'] as const) {
        const d = run({ policy, operation: op({ class: cls, availability }), grants: [grant()] });
        expect(d).toMatchObject({ outcome: 'refuse', code: 'paused' });
      }
    }
  });

  it('stays paused whatever shape the stored time comes in (the kill switch never fails open)', () => {
    // A row read straight from the database holds a Date.
    const fromRow = resolvePolicy('full_with_asks', [], { pausedAt: new Date(EARLIER) });
    expect(fromRow.pausedAt).toBe(new Date(EARLIER).toISOString());
    expect(policyProblems('full_with_asks', [], { pausedAt: new Date(EARLIER) })).toEqual([]);
    expect(run({ policy: fromRow })).toMatchObject({ outcome: 'refuse', code: 'paused' });

    // Values it cannot read keep the agent paused, and say so.
    for (const v of [new Date('not a date'), 0, 1, true, false, {}]) {
      const limits = { pausedAt: v as unknown as string };
      const policy = resolvePolicy('full_with_asks', [], limits);
      expect(policy.pausedAt, String(v)).not.toBeNull();
      expect(run({ policy }), String(v)).toMatchObject({ outcome: 'refuse', code: 'paused' });
      expect(policyProblems('full_with_asks', [], limits).join(' '), String(v)).toContain('stays paused');
    }

    // A policy built by hand with a Date in it is paused too.
    const handBuilt = { ...resolvePolicy('full_with_asks', []), pausedAt: new Date(EARLIER) as unknown as string };
    expect(run({ policy: handBuilt })).toMatchObject({ outcome: 'refuse', code: 'paused' });

    // Only "nothing there" means running.
    for (const v of [null, undefined, '']) {
      expect(isPaused(v)).toBe(false);
      expect(resolvePolicy('full_with_asks', [], { pausedAt: v as string | null }).pausedAt).toBeNull();
      expect(run({ policy: { ...resolvePolicy('full_with_asks', []), pausedAt: v as string | null } }).outcome).toBe('run');
    }
  });
});

describe('alwaysAsk', () => {
  it('asks where the policy says Allow, a grant never covers it, and no standing permission is offered', () => {
    for (const cls of RISK_CLASSES) {
      const operation = op({ class: cls, alwaysAsk: true });
      const policy = everywhere('allow', 'full_with_asks');
      const d = run({ policy, operation, grants: [grant({ constraints: { maxCount: 10 } })], facts: facts({ count: 1 }) });
      expect(d.outcome, cls).toBe('ask');
      if (d.outcome === 'ask') expect(d.needs.grantable).toBe('no');
      expect(grantCovers(grant({ constraints: {} }), operation, facts(), NOW)).toBe(false);
    }
  });
});

describe('the role (the ceiling)', () => {
  it('a refusal names what is missing and who can change it', () => {
    const d = run({ access: VIEW_ONLY, policy: everywhere('allow') });
    expect(d).toMatchObject({ outcome: 'refuse', code: 'role' });
    if (d.outcome === 'refuse') {
      expect(d.message).toBe(
        "Your role does not allow this: it needs the right to create Customers & Receivables. Ask an Admin to change this agent's role.",
      );
    }
    const act = run({
      access: custom({ 'customers.estimates': ['view', 'create'] }),
      operation: op({ activity: 'customers.invoices' }),
    });
    expect(act.outcome === 'refuse' && act.message).toContain('the right to create Invoices (Customers & Receivables)');
  });

  it('checks the route activity when there is one, the whole area otherwise', () => {
    const invoicesOnly = custom({ 'customers.invoices': ['view', 'create'] });
    expect(roleAllows(invoicesOnly, op({ activity: 'customers.invoices' }))).toBe(true);
    expect(roleAllows(invoicesOnly, op({ activity: null }))).toBe(false);
    expect(roleAllows(invoicesOnly, op({ activity: 'customers.estimates' }))).toBe(false);
  });

  it('a route with no rule is refused for everyone; a desktop action without one only passes an Admin', () => {
    expect(roleProblem(ADMIN, op({ rule: null, kind: 'route' }))).not.toBeNull();
    expect(roleAllows(ADMIN, op({ rule: null, kind: 'shell', area: null, action: null }))).toBe(true);
    expect(roleAllows(BOOKKEEPER, op({ rule: null, kind: 'shell', area: null, action: null }))).toBe(false);
    expect(roleAllows(BOOKKEEPER, op({ rule: null, kind: 'shell', area: 'banking', action: 'print' }))).toBe(true);
    expect(roleAllows(VIEW_ONLY, op({ rule: null, kind: 'shell', area: 'banking', action: 'print' }))).toBe(false);
    expect(roleAllows(VIEW_ONLY, op({ rule: 'member' }))).toBe(true);
  });

  it('routeWithoutRule names exactly the routes no role can allow, and the approver is told to deny them', () => {
    expect(routeWithoutRule(op({ rule: null, kind: 'route' }))).toBe(true);
    for (const rule of ['public', 'self', 'member'] as const) expect(routeWithoutRule(op({ rule, kind: 'route' })), rule).toBe(false);
    expect(routeWithoutRule(op({ rule: { area: 'customers', action: 'view' }, kind: 'route' }))).toBe(false);
    // A desktop action has no route rule at all: a role question, not a missing rule.
    expect(routeWithoutRule(op({ rule: null, kind: 'shell' }))).toBe(false);
    // It agrees with roleProblem: refused for every role, an Admin too.
    for (const access of [ADMIN, BOOKKEEPER, VIEW_ONLY]) expect(roleProblem(access, op({ rule: null, kind: 'route' }))).not.toBeNull();
    expect(NO_RULE_FOR_APPROVER).toMatch(/^No role can allow this request, not even Admin.*Deny it;/);
    expect(NO_RULE_FOR_APPROVER).not.toBe(NO_RULE_FOR_AGENT);
  });

  it('a route with no rule tells the agent to ask a person, not to ask for a role change that cannot help', () => {
    const NO_RULE =
      'No role can allow this request, not even Admin, because Ironbooks has no permission rule for it. Ask a person to do it in Ironbooks.';
    for (const access of [ADMIN, BOOKKEEPER, ACCOUNTANT, PAYROLL, VIEW_ONLY]) {
      for (const preset of AGENT_PRESETS) {
        for (const cls of RISK_CLASSES) {
          const d = run({ access, policy: resolvePolicy(preset, []), operation: op({ class: cls, rule: null, kind: 'route' }) });
          expect(d, `${cls} ${preset}`).toMatchObject({ outcome: 'refuse', code: 'role', message: NO_RULE });
        }
      }
    }
    // The words are exported, for the approval center to say the same (lib/services/agentRequests.ts).
    expect(NO_RULE_FOR_AGENT).toBe(NO_RULE);
    // A desktop action with no rule is a role question: an Admin role would pass it.
    const shell = run({ access: BOOKKEEPER, operation: op({ rule: null, kind: 'shell', area: null, action: null }) });
    expect(shell).toMatchObject({ outcome: 'refuse', code: 'role' });
    expect(shell.outcome === 'refuse' && shell.message).toBe(
      "Your role does not allow this: it needs the Admin role. Ask an Admin to change this agent's role.",
    );
  });

  it('is the same check a person meets for every mapped route and method', () => {
    const accesses: EffectiveAccess[] = [
      ...BUILTIN_ROLES.map((r) => unionRoles([r])),
      custom({ 'customers.invoices': ['view', 'create'], 'banking.deposits': ['full'] }),
      custom({}),
    ];
    let compared = 0;
    for (const pattern of Object.keys(API_ROUTE_PERMISSIONS)) {
      const path = pattern.replace(/\[\[?\.\.\.[^\]]+\]?\]/g, 'x').replace(/\[[^\]]+\]/g, 'x');
      if (matchRoutePattern(path) !== pattern) continue;
      for (const method of Object.keys(API_ROUTE_PERMISSIONS[pattern]) as HttpMethod[]) {
        const rule = apiRuleFor(path, method);
        const activity = apiActivityFor(path, method);
        const operation = op({
          route: pattern,
          method,
          rule,
          activity,
          area: rule && typeof rule === 'object' ? rule.area : null,
          action: rule && typeof rule === 'object' ? rule.action : null,
        });
        for (const access of accesses) {
          let person = true;
          try {
            assertRule(rule, access, path, activity);
          } catch {
            person = false;
          }
          expect(roleAllows(access, operation), `${method} ${pattern} ${access.roleKeys.join(',')}`).toBe(person);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(5000);
  });

  it('role flags: closed-period work and reveals need the flag a person would need', () => {
    const allowAll = everywhere('allow', 'full_with_asks');
    // Bookkeeper has no closed-period right: refused, not asked.
    const closed = facts({ closedPeriod: true, date: '2025-12-31' });
    const noFlag = run({ access: BOOKKEEPER, policy: allowAll, facts: closed });
    expect(noFlag).toMatchObject({ outcome: 'refuse', code: 'role' });
    expect(noFlag.outcome === 'refuse' && noFlag.message).toContain('Modify transactions on or before the closing date');
    const withFlag = run({ access: ACCOUNTANT, policy: allowAll, facts: closed });
    expect(withFlag).toMatchObject({ outcome: 'ask', effectiveClass: 'period' });
    if (withFlag.outcome === 'ask') {
      expect(withFlag.needs.flag).toBe('closedPeriod');
      expect(withFlag.needs.secrets).toContain('closing_password');
      expect(withFlag.needs.grantable).toBe('no');
    }

    const payrollRead = op({
      id: 'employees.get',
      class: 'read',
      reveal: 'ssn',
      rule: { area: 'payroll', action: 'view' },
      area: 'payroll',
      action: 'view',
    });
    const reveal = facts({ reveal: true });
    expect(run({ access: ACCOUNTANT, policy: allowAll, operation: payrollRead, facts: reveal })).toMatchObject({
      outcome: 'refuse',
      code: 'role',
    });
    const asked = run({ access: PAYROLL, policy: allowAll, operation: payrollRead, facts: reveal });
    expect(asked).toMatchObject({ outcome: 'ask', effectiveClass: 'read_sensitive' });
    if (asked.outcome === 'ask') expect(asked.needs.flag).toBe('sensitivePayroll');
    // Without a reveal the same read just runs (masked, as today).
    expect(run({ access: ACCOUNTANT, policy: allowAll, operation: payrollRead })).toMatchObject({ outcome: 'run' });

    // Moving the closing date needs only the route's right, as for a person; the approver needs more.
    const moveDate = op({ id: 'company.closingDate.update', class: 'period', rule: { area: 'closing', action: 'modify' }, area: 'closing' });
    const closer = custom({ closing: ['view', 'modify'] });
    const move = run({ access: closer, policy: allowAll, operation: moveDate });
    expect(move).toMatchObject({ outcome: 'ask', effectiveClass: 'period' });
    if (move.outcome === 'ask') expect(move.needs).toMatchObject({ flag: 'closedPeriod', secrets: ['closing_password'] });

    const acct = op({ class: 'read', reveal: 'account_numbers', rule: { area: 'banking', action: 'view' }, area: 'banking' });
    const acctAsk = run({ access: ADMIN, policy: allowAll, operation: acct, facts: reveal });
    expect(acctAsk.outcome === 'ask' && acctAsk.needs.flag).toBe('fullAccountNumbers');
  });
});

// ---------------------------------------------------------------------------
// Escalation: confirm flags, closed period, reveal
// ---------------------------------------------------------------------------

describe('effectiveClass', () => {
  it('never lowers a class, for every class and every fact', () => {
    for (const cls of RISK_CLASSES) {
      for (const [, f] of FACT_VARIANTS) {
        expect(classRank(effectiveClass(op({ class: cls }), f))).toBeGreaterThanOrEqual(classRank(cls));
      }
    }
  });

  it('raises exactly as plan 5.6 and 5.9 say', () => {
    const e = (cls: RiskClass, f: Partial<RequestFacts>) => effectiveClass(op({ class: cls }), facts(f));
    expect(e('read', { reveal: true })).toBe('read_sensitive');
    expect(e('enter', { confirm: ['allowDuplicateNumber'] })).toBe('change');
    expect(e('prepare', { confirm: ['allowDuplicate'] })).toBe('enter');
    expect(e('change', { confirm: ['allowDuplicateNumber'] })).toBe('change');
    expect(e('change', { confirm: ['allowReconciledEdit'] })).toBe('period');
    expect(e('change', { confirm: ['allowLedgerRewrite'] })).toBe('period');
    expect(e('enter', { confirm: ['allowReconciledEdit'] })).toBe('period');
    expect(e('remove', { confirm: ['allowReconciledEdit'] })).toBe('period');
    // Any class that can write to the books, the ones filed by their riskiest effect included
    // (Income Tracker convert is outside, a print-queue confirm is print): judged as period, or
    // under its own class where that is stricter still.
    for (const w of ['enter', 'change', 'bulk', 'remove', 'outside', 'print'] as RiskClass[]) {
      expect(e(w, { closedPeriod: true })).toBe('period');
    }
    for (const w of ['settings', 'admin', 'file', 'secret'] as RiskClass[]) {
      expect(e(w, { closedPeriod: true })).toBe(w);
      expect(requestClasses(op({ class: w }), facts({ closedPeriod: true }))).toEqual([w, 'period']);
    }
    // Not book-writing: the closing date does not apply. Prepare work never reaches the books.
    expect(e('prepare', { closedPeriod: true })).toBe('prepare');
    expect(e('prepare', { confirm: ['allowReconciledEdit'] })).toBe('period');
    expect(e('read', { closedPeriod: true })).toBe('read');
    expect(e('read_sensitive', { closedPeriod: true })).toBe('read_sensitive');
    // A reconciled-edit flag only raises the everyday writing classes (a grant never covers a flagged request anyway).
    expect(e('print', { confirm: ['allowReconciledEdit'] })).toBe('print');
    // Already stricter: unchanged.
    expect(e('secret', { reveal: true, closedPeriod: true })).toBe('secret');
    expect(e('admin', { reveal: true })).toBe('admin');
  });

  it('adding a fact never makes the outcome looser, under any preset, setting or grant', () => {
    const policies: AgentPolicy[] = [];
    for (const preset of AGENT_PRESETS) {
      policies.push(resolvePolicy(preset, [], { twoPersonOver: '1000' }));
      for (const s of POLICY_SETTINGS) policies.push(everywhere(s, preset));
    }
    for (const cls of RISK_CLASSES) {
      const operation = op({ id: 'mono.op', class: cls, reveal: 'ssn' });
      const grants = [grant({ id: 'g', operation: 'mono.op', constraints: { maxCount: 100_000 } })];
      for (const policy of policies) {
        // Every request here states its count, so the grant's count cap can be checked for all of them.
        const plain = run({ access: ADMIN, policy, operation, grants, facts: facts({ count: 1 }) });
        for (const [name, f] of FACT_VARIANTS) {
          const d = run({ access: ADMIN, policy, operation, facts: { ...f, count: f.count ?? 1 }, grants });
          expect(OUTCOME_STRICTNESS[d.outcome], `${cls} ${name}`).toBeGreaterThanOrEqual(OUTCOME_STRICTNESS[plain.outcome]);
        }
      }
    }
  });

  it('the strictest setting applies: a reveal or a closed date cannot route around a Never', () => {
    const policy = resolvePolicy('ask_every_change', [{ class: 'enter', area: null, setting: 'never' }]);
    for (const f of [facts({ reveal: true }), facts({ closedPeriod: true }), facts({ confirm: ['allowReconciledEdit'] })]) {
      expect(run({ policy, facts: f })).toMatchObject({ outcome: 'refuse', code: 'never' });
    }
    // And Allow on the raised class does not let the request through either.
    const p2 = resolvePolicy('trusted_bookkeeper', [{ class: 'change', area: null, setting: 'ask' }]);
    expect(run({ policy: p2, facts: facts({ confirm: ['allowDuplicateNumber'] }) })).toMatchObject({
      outcome: 'ask',
      effectiveClass: 'change',
    });
    expect(run({ policy: p2 })).toMatchObject({ outcome: 'run', effectiveClass: 'enter' });
  });

  it('a raised request is a new question: the grant for the plain one does not cover it', () => {
    const policy = resolvePolicy('ask_every_change', []);
    const g = [grant({ constraints: {} })];
    expect(run({ policy, grants: g })).toEqual({ outcome: 'run', effectiveClass: 'enter', grantId: 'g1' });
    for (const [name, f] of FACT_VARIANTS) {
      if (name === 'plain' || name === 'large amount' || name === 'many records') continue;
      const d = run({ access: ADMIN, policy, grants: g, facts: f });
      expect(d.outcome, name).toBe('ask');
    }
  });

  it('a reconciled edit asks without needing the closing-date password or right', () => {
    const d = run({ access: BOOKKEEPER, operation: op({ class: 'change' }), facts: facts({ confirm: ['allowReconciledEdit'] }) });
    expect(d).toMatchObject({ outcome: 'ask', effectiveClass: 'period' });
    if (d.outcome === 'ask') {
      expect(d.needs.flag).toBeNull();
      expect(d.needs.secrets).toEqual([]);
      expect(d.needs.grantable).toBe('no');
    }
  });
});

// ---------------------------------------------------------------------------
// Bulk cap and two-person approval
// ---------------------------------------------------------------------------

describe('bulk cap', () => {
  const bulk = op({ id: 'bills.batch', class: 'bulk' });

  it('refuses a request above the cap, names the cap, and allows up to it', () => {
    const policy = resolvePolicy('full_with_asks', []);
    expect(run({ policy, operation: bulk, facts: facts({ count: 200 }) })).toMatchObject({ outcome: 'run' });
    const d = run({ policy, operation: bulk, facts: facts({ count: 201 }) });
    expect(d).toMatchObject({ outcome: 'refuse', code: 'bulk_cap' });
    if (d.outcome === 'refuse') {
      expect(d.message).toBe(
        'This would change 201 records, more than this agent may change in one request (200). Split it into smaller requests, or ask an Admin to raise the limit.',
      );
    }
  });

  it('holds under a grant and when asking', () => {
    const policy = resolvePolicy('ask_every_change', [], { bulkCap: 50 });
    const g = [grant({ operation: 'bills.batch', constraints: { maxCount: 1000 } })];
    expect(run({ policy, operation: bulk, grants: g, facts: facts({ count: 50 }) })).toMatchObject({ outcome: 'run', grantId: 'g1' });
    expect(run({ policy, operation: bulk, grants: g, facts: facts({ count: 51 }) })).toMatchObject({
      outcome: 'refuse',
      code: 'bulk_cap',
    });
    expect(run({ policy, operation: bulk, facts: facts({ count: 51 }) })).toMatchObject({ outcome: 'refuse', code: 'bulk_cap' });
  });

  it('a count it cannot read is above any cap; with no cap a person sees the count', () => {
    const policy = resolvePolicy('full_with_asks', []);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const d = run({ policy, operation: bulk, facts: facts({ count: bad }) });
      expect(d, String(bad)).toMatchObject({ outcome: 'refuse', code: 'bulk_cap' });
      expect(d.outcome === 'refuse' && d.message, String(bad)).toContain('an unknown number of records');
    }
    const uncapped = resolvePolicy('ask_every_change', [], { bulkCap: null });
    expect(run({ policy: uncapped, operation: bulk, facts: facts({ count: 1_000_000 }) }).outcome).toBe('ask');
  });

  it('Allow runs bulk work only when the count is known and within a cap (fails closed)', () => {
    // "Full, with asks" allows bulk with a cap of 200, but a request whose size is unknown asks.
    const full = resolvePolicy('full_with_asks', []);
    const unknown = run({ policy: full, operation: bulk, facts: facts({ count: null }) });
    expect(unknown).toMatchObject({ outcome: 'ask', effectiveClass: 'bulk' });
    if (unknown.outcome === 'ask') expect(unknown.needs.grantable).toBe('capped');
    expect(run({ policy: full, operation: bulk, facts: facts({ count: 0 }) })).toMatchObject({ outcome: 'run' });

    // A policy built by hand with bulk Allow and no cap never runs bulk work unasked.
    const noCap: AgentPolicy = { ...full, bulkCap: null };
    for (const count of [null, 1, 1_000_000]) {
      expect(run({ policy: noCap, operation: bulk, facts: facts({ count }) }).outcome, String(count)).toBe('ask');
    }

    // Allow in one area only: the same rules.
    const area = resolvePolicy('ask_every_change', [{ class: 'bulk', area: 'banking', setting: 'allow' }]);
    const bankBulk = op({ id: 'banking.rules.run', class: 'bulk', area: 'banking', rule: { area: 'banking', action: 'modify' } });
    expect(run({ policy: area, operation: bankBulk, facts: facts({ count: null }) }).outcome).toBe('ask');
    expect(run({ policy: area, operation: bankBulk, facts: facts({ count: 5 }) })).toMatchObject({ outcome: 'run', grantId: null });
    expect(run({ policy: { ...area, bulkCap: null }, operation: bankBulk, facts: facts({ count: 5 }) }).outcome).toBe('ask');

    // And a capped grant does not cover an unknown count either.
    const g = [grant({ operation: 'bills.batch', constraints: { maxCount: 1000 } })];
    const asked = resolvePolicy('ask_every_change', []);
    expect(run({ policy: asked, operation: bulk, grants: g, facts: facts({ count: null }) }).outcome).toBe('ask');
  });

  it('no cap, count, setting or area makes bulk work run unasked above a cap or without one', () => {
    const counts = [null, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 0, 1, 200, 201, 1_000_000];
    const caps = [null, 0, -1, 1.5, Number.NaN, 1, 200];
    let checked = 0;
    for (const setting of POLICY_SETTINGS) {
      for (const area of [null, 'banking'] as Array<Area | null>) {
        const base = resolvePolicy('full_with_asks', [{ class: 'bulk', area, setting }]);
        for (const cap of caps) {
          const policy: AgentPolicy = { ...base, bulkCap: cap };
          for (const count of counts) {
            const operation = op({ id: 'b.op', class: 'bulk', area: 'banking', rule: { area: 'banking', action: 'modify' } });
            const d = run({ policy, operation, facts: facts({ count }) });
            checked++;
            if (d.outcome === 'run' && d.grantId === null) {
              const label = `${setting} ${area} cap=${cap} count=${count}`;
              expect(Number.isInteger(cap) && (cap as number) > 0, label).toBe(true);
              expect(Number.isInteger(count) && (count as number) >= 0 && (count as number) <= (cap as number), label).toBe(true);
            }
          }
        }
      }
    }
    expect(checked).toBe(POLICY_SETTINGS.length * 2 * caps.length * counts.length);
  });

  it('a bulk grant without its count cap covers nothing', () => {
    expect(grantCovers(grant({ operation: 'bills.batch', constraints: {} }), bulk, facts({ count: 1 }), NOW)).toBe(false);
    expect(grantCovers(grant({ operation: 'bills.batch', constraints: { maxCount: 5 } }), bulk, facts({ count: 5 }), NOW)).toBe(true);
    expect(grantCovers(grant({ operation: 'bills.batch', constraints: { maxCount: 5 } }), bulk, facts({ count: 6 }), NOW)).toBe(false);
    expect(grantCovers(grant({ operation: 'bills.batch', constraints: { maxCount: 5 } }), bulk, facts(), NOW)).toBe(false);
  });
});

describe('two-person approval (D8)', () => {
  const policy = resolvePolicy('trusted_bookkeeper', [], { twoPersonOver: '1000.00' });

  it('applies strictly above the amount, compared as decimals', () => {
    const at = (amount: string | null) => approvalNeeds(op(), 'enter', facts({ amount }), policy).twoPerson;
    // Entering changes the books: with no amount nobody can show it is below the threshold.
    expect(at(null)).toBe(true);
    expect(at('999.99')).toBe(false);
    expect(at('1000')).toBe(false);
    expect(at('1000.00')).toBe(false);
    expect(at('1000.000000000000000001')).toBe(true);
    expect(at('1000.01')).toBe(true);
    expect(at('-1000.01')).toBe(true);
    expect(at('not a number')).toBe(true);
    // Floating point would call these equal.
    const tight = resolvePolicy('trusted_bookkeeper', [], { twoPersonOver: '0.3' });
    expect(approvalNeeds(op(), 'enter', facts({ amount: '0.30000000000000001' }), tight).twoPerson).toBe(true);
    expect(approvalNeeds(op(), 'enter', facts({ amount: '0.3' }), tight).twoPerson).toBe(false);
    expect(approvalNeeds(op(), 'enter', facts({ amount: '5000' }), resolvePolicy('trusted_bookkeeper', [])).twoPerson).toBe(false);
  });

  it('turns an Allow into an Ask, and a grant does not answer it', () => {
    expect(run({ policy, facts: facts({ amount: '900' }) })).toMatchObject({ outcome: 'run', grantId: null });
    const big = run({ policy, facts: facts({ amount: '1500' }) });
    expect(big).toMatchObject({ outcome: 'ask' });
    if (big.outcome === 'ask') expect(big.needs.twoPerson).toBe(true);
    const askPolicy = resolvePolicy('ask_every_change', [], { twoPersonOver: '1000.00' });
    const g = [grant({ constraints: {} })];
    expect(run({ policy: askPolicy, grants: g, facts: facts({ amount: '900' }) })).toMatchObject({ outcome: 'run', grantId: 'g1' });
    expect(run({ policy: askPolicy, grants: g, facts: facts({ amount: '1500' }) })).toMatchObject({ outcome: 'ask' });
  });

  it('a missing amount on an operation that has one counts as above the threshold', () => {
    const withAmount = op({ amountField: 'total' });
    expect(approvalNeeds(withAmount, 'enter', facts({ amount: null }), policy).twoPerson).toBe(true);
    expect(approvalNeeds(withAmount, 'enter', facts({ amount: '10' }), policy).twoPerson).toBe(false);
    // No threshold set: nothing to compare against.
    expect(approvalNeeds(withAmount, 'enter', facts({ amount: null }), resolvePolicy('trusted_bookkeeper', [])).twoPerson).toBe(false);
    const d = run({ policy, operation: withAmount, facts: facts({ amount: null }) });
    expect(d).toMatchObject({ outcome: 'ask' });
    if (d.outcome === 'ask') expect(d.needs.twoPerson).toBe(true);
    // With the dry run's amount (the caller decides again), a small one runs under Allow.
    expect(run({ policy, operation: withAmount, facts: facts({ amount: '10' }) })).toMatchObject({ outcome: 'run' });
  });

  it('a missing amount counts as above the threshold for every class that changes the books (D8)', () => {
    // Per class: [no amountField, with amountField] when the amount is not known.
    const WANT: Record<RiskClass, [boolean, boolean]> = {
      read: [false, false],
      read_sensitive: [false, false],
      prepare: [false, true],
      enter: [true, true],
      change: [true, true],
      bulk: [true, true],
      remove: [true, true],
      period: [true, true],
      outside: [false, true],
      print: [false, true],
      settings: [false, true],
      admin: [false, true],
      file: [false, true],
      secret: [false, true],
    };
    for (const cls of RISK_CLASSES) {
      for (const [i, amountField] of [null, 'total'].entries()) {
        const o = op({ class: cls, amountField });
        const label = `${cls} amountField=${amountField}`;
        expect(needsTwoPerson(policy, facts({ amount: null }), o), label).toBe(WANT[cls][i]);
        expect(approvalNeeds(o, effectiveClass(o, facts()), facts(), policy).twoPerson, label).toBe(WANT[cls][i]);
        // A known amount at or below the threshold never needs two people; above it, all but reads do.
        expect(needsTwoPerson(policy, facts({ amount: '1000' }), o), label).toBe(false);
        expect(needsTwoPerson(policy, facts({ amount: '1000.01' }), o), label).toBe(cls !== 'read' && cls !== 'read_sensitive');
        // No threshold: never.
        expect(needsTwoPerson(resolvePolicy('trusted_bookkeeper', []), facts({ amount: null }), o), label).toBe(false);
      }
    }
    // A closed-period date makes an outside or print request one that changes the books.
    for (const cls of ['outside', 'print'] as RiskClass[]) {
      expect(needsTwoPerson(policy, facts({ amount: null, closedPeriod: true }), op({ class: cls }))).toBe(true);
    }
    // A reveal on a read is still a read.
    expect(needsTwoPerson(policy, facts({ amount: '5000', reveal: true }), op({ class: 'read' }))).toBe(false);
    // Nobody classified it, or the caller did not say what it is: it cannot be shown to be a read.
    expect(needsTwoPerson(policy, facts({ amount: null }), op({ class: 'read', classified: false }))).toBe(true);
    expect(needsTwoPerson(policy, facts({ amount: null }), { amountField: null })).toBe(true);
    expect(needsTwoPerson(policy, facts({ amount: null }))).toBe(true);
    expect(needsTwoPerson(policy, facts({ amount: null }), null)).toBe(true);
  });

  it('under Allow, an unknown amount asks two people; reads still run; a grant does not answer it', () => {
    const trusted = resolvePolicy('trusted_bookkeeper', [], { twoPersonOver: '1000' });
    const enterAsk = run({ policy: trusted, operation: op(), facts: facts({ amount: null }) });
    expect(enterAsk).toMatchObject({ outcome: 'ask', effectiveClass: 'enter' });
    if (enterAsk.outcome === 'ask') expect(enterAsk.needs.twoPerson).toBe(true);
    const read = op({ id: 'invoices.list', class: 'read', rule: { area: 'customers', action: 'view' }, action: 'view' });
    expect(run({ policy: trusted, operation: read, facts: facts({ amount: null }) })).toMatchObject({ outcome: 'run' });
    expect(run({ policy: trusted, operation: read, facts: facts({ amount: '999999' }) })).toMatchObject({ outcome: 'run' });
    const asking = resolvePolicy('ask_every_change', [], { twoPersonOver: '1000' });
    const d = run({ policy: asking, operation: op(), facts: facts({ amount: null }), grants: [grant({ constraints: {} })] });
    expect(d).toMatchObject({ outcome: 'ask' });
    if (d.outcome === 'ask') expect(d.needs.twoPerson).toBe(true);
  });

  it('the second decision clears it only when the dry run reports an amount: "0.00" for work that moves no money', () => {
    // A new customer has no amount field. With no amount it needs two people; once the dry run
    // reports that nothing was posted ("0.00"), it runs under Allow, even with a threshold of zero.
    for (const over of ['1000', '0']) {
      const trusted = resolvePolicy('trusted_bookkeeper', [], { twoPersonOver: over });
      const newCustomer = op({ id: 'customers.create', class: 'enter', amountField: null });
      const before = run({ policy: trusted, operation: newCustomer, facts: facts({ amount: null }) });
      expect(before, over).toMatchObject({ outcome: 'ask' });
      if (before.outcome === 'ask') expect(before.needs.twoPerson, over).toBe(true);
      expect(run({ policy: trusted, operation: newCustomer, facts: facts({ amount: '0.00' }) }), over).toMatchObject({ outcome: 'run' });
    }
  });
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

describe('requests approved together (batch approval) and the two-person amount (D8)', () => {
  const limit = { twoPersonOver: '5000.00' };
  it('adds the amounts up by size and holds the total to the amount', () => {
    expect(batchPassesTwoPerson(limit, ['4999.00', '4999.00', '4999.00'])).toEqual({ total: '14997.00', unknown: 0, over: true });
    expect(batchPassesTwoPerson(limit, ['2500.00', '-2500.00'])).toEqual({ total: '5000.00', unknown: 0, over: false });
    expect(batchPassesTwoPerson(limit, ['2500.00', '-2500.01'])).toEqual({ total: '5000.01', unknown: 0, over: true });
    expect(batchPassesTwoPerson(limit, [4999, '1'])).toEqual({ total: '5000.00', unknown: 0, over: false });
  });
  it('an amount that is not known counts as above it', () => {
    for (const unknown of [null, undefined, '', 'lots', 'NaN', {}]) {
      expect(batchPassesTwoPerson(limit, ['1.00', unknown]), String(unknown)).toEqual({ total: '1.00', unknown: 1, over: true });
    }
  });
  it('with no two-person amount set, nothing is over', () => {
    for (const twoPersonOver of [null, undefined]) {
      expect(batchPassesTwoPerson({ twoPersonOver } as Pick<AgentPolicy, 'twoPersonOver'>, ['9999999.00', null]).over).toBe(false);
    }
  });
  it('an amount setting it cannot read is read as 0 (as needsTwoPerson reads it)', () => {
    expect(batchPassesTwoPerson({ twoPersonOver: 'lots' }, ['0.01']).over).toBe(true);
    expect(needsTwoPerson({ twoPersonOver: 'lots' }, { amount: '0.01' })).toBe(true);
  });
});

describe('grantCovers', () => {
  const operation = op({ id: 'bills.create', class: 'enter' });
  const base = facts({ amount: '120.00', entityIds: ['v1'], accountIds: ['a1', 'a2'], date: '2026-11-15', count: 1 });
  const g = (constraints: AgentGrant['constraints'], over: Partial<AgentGrant> = {}) =>
    grant({ operation: 'bills.create', constraints, ...over });

  const CASES: Array<[string, AgentGrant, RequestFacts, boolean]> = [
    ['no constraints', g({}), base, true],
    ['other operation', g({}, { operation: 'bills.update' }), base, false],
    ['revoked', g({}, { revokedAt: EARLIER }), base, false],
    ['expired', g({}, { expiresAt: EARLIER }), base, false],
    ['expires exactly now', g({}, { expiresAt: NOW }), base, false],
    ['expiry unreadable', g({}, { expiresAt: 'soon' }), base, false],
    ['uses below max', g({ maxUses: 3 }, { uses: 2 }), base, true],
    ['uses at max', g({ maxUses: 3 }, { uses: 3 }), base, false],
    ['entity within', g({ entityIds: ['v1', 'v2'] }), base, true],
    ['entity outside', g({ entityIds: ['v2'] }), base, false],
    ['entity missing from request', g({ entityIds: ['v1'] }), { ...base, entityIds: [] }, false],
    ['some entity outside', g({ entityIds: ['v1'] }), { ...base, entityIds: ['v1', 'v9'] }, false],
    ['accounts within', g({ accountIds: ['a1', 'a2', 'a3'] }), base, true],
    ['one account outside', g({ accountIds: ['a1'] }), base, false],
    ['amount at max', g({ maxAmount: '120' }), base, true],
    ['amount below max', g({ maxAmount: '500.00' }), base, true],
    ['amount above max', g({ maxAmount: '119.99' }), base, false],
    ['amount a hair above max', g({ maxAmount: '120' }), { ...base, amount: '120.0000000000000001' }, false],
    ['negative amount counted by size', g({ maxAmount: '100' }), { ...base, amount: '-120.00' }, false],
    ['amount missing', g({ maxAmount: '500' }), { ...base, amount: null }, false],
    ['max amount unreadable', g({ maxAmount: 'lots' }), base, false],
    ['date within', g({ dateFrom: '2026-11-01', dateTo: '2026-11-30' }), base, true],
    ['date on the first day', g({ dateFrom: '2026-11-15' }), base, true],
    ['date on the last day', g({ dateTo: '2026-11-15' }), base, true],
    ['date as date-time', g({ dateTo: '2026-11-15' }), { ...base, date: '2026-11-15T22:00:00Z' }, true],
    ['date before', g({ dateFrom: '2026-11-16' }), base, false],
    ['date after', g({ dateTo: '2026-11-14' }), base, false],
    ['date missing', g({ dateFrom: '2026-11-01' }), { ...base, date: null }, false],
    ['count within', g({ maxCount: 1 }), base, true],
    ['count above', g({ maxCount: 1 }), { ...base, count: 2 }, false],
    ['all constraints met', g({ entityIds: ['v1'], accountIds: ['a1', 'a2'], maxAmount: '120', dateFrom: '2026-11-15', dateTo: '2026-11-15', maxUses: 1, maxCount: 1 }), base, true],
    ['reveal', g({}), { ...base, reveal: true }, false],
    ['closed period', g({}), { ...base, closedPeriod: true }, false],
    ['confirm flag', g({}), { ...base, confirm: ['allowDuplicateNumber'] }, false],
  ];

  it.each(CASES)('%s', (_name, gr, f, want) => {
    expect(grantCovers(gr, operation, f, NOW)).toBe(want);
  });

  it('never covers a class whose grants are "no"', () => {
    for (const cls of RISK_CLASSES) {
      const o = op({ id: 'x.op', class: cls });
      const covered = grantCovers(grant({ operation: 'x.op', constraints: { maxCount: 10 } }), o, facts({ count: 1 }), NOW);
      expect(covered, cls).toBe(GRANTABLE[cls] !== 'no');
    }
  });

  it('never covers work a person must be there for: a secret typed, the host computer, the file Admin, closing-date work (D3)', () => {
    for (const cls of RISK_CLASSES.filter((c) => GRANTABLE[c] !== 'no')) {
      const at = (over: Partial<Operation>, f: RequestFacts = facts({ count: 1, amount: '1.00' })) =>
        grantCovers(grant({ operation: 'p.op', constraints: { maxCount: 10 } }), op({ id: 'p.op', class: cls, ...over }), f, NOW);
      expect(at({}), cls).toBe(true);
      expect(at({ needsSecret: ['mail_password'] }), cls).toBe(false);
      expect(at({ needsSecret: ['closing_password'] }), cls).toBe(false);
      expect(at({ hostOnly: true }), cls).toBe(false);
      expect(at({ fileAdmin: true }), cls).toBe(false);
      expect(at({}, facts({ count: 1, amount: '1.00', closedPeriod: true })), cls).toBe(false);
    }
    // An operation that is itself closing-date work (moving the closing date) is never grantable.
    expect(grantCovers(grant({ operation: 'p.period', constraints: {} }), op({ id: 'p.period', class: 'period' }), facts(), NOW)).toBe(false);
  });

  it('an amount limit never covers a request whose amount is unknown, whatever else it meets', () => {
    for (const amount of [null, '', '  ', 'lots', 'NaN', 'Infinity']) {
      expect(grantCovers(g({ maxAmount: '1000000' }), operation, { ...base, amount } as RequestFacts, NOW), String(amount)).toBe(false);
    }
    // Without an amount limit, a request of unknown amount is covered as before.
    expect(grantCovers(g({}), operation, { ...base, amount: null }, NOW)).toBe(true);
  });

  it('a "now" it cannot read covers nothing', () => {
    expect(grantCovers(g({}), operation, base, 'whenever')).toBe(false);
  });

  it('a grant with more time left than its class may have covers nothing', () => {
    const at = (cls: RiskClass, expiresAt: string) =>
      grantCovers(grant({ operation: 'w.op', expiresAt, constraints: { maxCount: 10 } }), op({ id: 'w.op', class: cls }), facts({ count: 1 }), NOW);
    // Short classes: 30 minutes at most.
    for (const cls of RISK_CLASSES.filter((c) => GRANTABLE[c] === 'short')) {
      expect(at(cls, '2026-11-20T15:30:00.000Z'), cls).toBe(true);
      expect(at(cls, '2026-11-20T15:30:01.000Z'), cls).toBe(false);
      expect(at(cls, LATER), cls).toBe(false);
    }
    // Until end of day: never more than a day.
    for (const cls of RISK_CLASSES.filter((c) => GRANTABLE[c] === 'yes' || GRANTABLE[c] === 'capped')) {
      expect(at(cls, LATER), cls).toBe(true);
      expect(at(cls, '2026-11-21T15:00:00.000Z'), cls).toBe(true);
      expect(at(cls, '2026-11-21T15:00:01.000Z'), cls).toBe(false);
    }
  });

  it('request facts of the wrong shape are read the strict way', () => {
    const bad = (f: Record<string, unknown>) => ({ ...base, ...f }) as unknown as RequestFacts;
    for (const confirm of ['allowDuplicateNumber', 'allowReconciledEdit', {}, [42], true]) {
      expect(grantCovers(g({}), operation, bad({ confirm }), NOW), JSON.stringify(confirm)).toBe(false);
    }
    expect(grantCovers(g({}), operation, bad({ closedPeriod: 1 }), NOW)).toBe(false);
    expect(grantCovers(g({}), operation, bad({ reveal: 'yes' }), NOW)).toBe(false);
    expect(grantCovers(g({}), operation, bad({ confirm: [] }), NOW)).toBe(true);
    expect(grantCovers(g({}), operation, bad({ confirm: null }), NOW)).toBe(true);
  });

  it('decide uses the first grant that covers the request', () => {
    const policy = resolvePolicy('ask_every_change', []);
    const grants = [
      g({ entityIds: ['v9'] }, { id: 'no' }),
      g({}, { id: 'yes', expiresAt: EARLIER }),
      g({ maxAmount: '500' }, { id: 'first' }),
      g({}, { id: 'second' }),
    ];
    expect(run({ policy, operation, facts: base, grants })).toEqual({ outcome: 'run', effectiveClass: 'enter', grantId: 'first' });
  });

  it('Allow runs without spending a grant', () => {
    const policy = resolvePolicy('trusted_bookkeeper', []);
    expect(run({ policy, operation, facts: base, grants: [g({})] })).toEqual({ outcome: 'run', effectiveClass: 'enter', grantId: null });
  });
});

describe('maxGrantMinutes', () => {
  it('follows GRANTABLE: none, 30 minutes, or until the end of the day', () => {
    for (const cls of RISK_CLASSES) {
      const g = GRANTABLE[cls];
      const want = g === 'no' ? 0 : g === 'short' ? 30 : 24 * 60;
      expect(maxGrantMinutes(cls, 24 * 60), cls).toBe(want);
      // An hour before midnight, "until end of day" is an hour, not a day.
      expect(maxGrantMinutes(cls, 60), cls).toBe(g === 'no' ? 0 : g === 'short' ? 30 : 60);
    }
    expect(maxGrantMinutes('enter', 95.5)).toBe(95);
    expect(maxGrantMinutes('enter', 5000)).toBe(24 * 60);
    expect(maxGrantMinutes('outside', 10)).toBe(10);
    expect(maxGrantMinutes('outside', 600)).toBe(30);
    expect(maxGrantMinutes('bulk', -5)).toBe(0);
    expect(maxGrantMinutes('enter', Number.NaN)).toBe(0);
    expect(maxGrantMinutes('remove', 600)).toBe(0);
    expect(maxGrantMinutes('nonsense' as RiskClass, 600)).toBe(0);
  });

  it('minutesToEndOfDay counts to the next local midnight', () => {
    expect(minutesToEndOfDay('2026-11-20T23:00:00.000Z', 0)).toBe(60);
    expect(minutesToEndOfDay('2026-11-20T00:00:00.000Z', 0)).toBe(24 * 60);
    // New York in winter (UTC-5): 23:00Z is 18:00 there.
    expect(minutesToEndOfDay('2026-11-20T23:00:00.000Z', -300)).toBe(360);
    // UTC+1: 23:30Z is already 00:30 the next day there.
    expect(minutesToEndOfDay('2026-11-20T23:30:00.000Z', 60)).toBe(24 * 60 - 30);
    expect(minutesToEndOfDay('2026-11-20T23:59:30.000Z', 0)).toBe(0);
    expect(minutesToEndOfDay('whenever', 0)).toBe(0);
    expect(minutesToEndOfDay(NOW, Number.NaN)).toBe(0);
    expect(maxGrantMinutes('enter', minutesToEndOfDay('2026-11-20T23:00:00.000Z', 0))).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// approvalNeeds
// ---------------------------------------------------------------------------

describe('approvalNeeds', () => {
  const policy = resolvePolicy('ask_every_change', []);

  it('Admin for the Admin-only classes and for unclassified operations; file Admin and host-only from the operation', () => {
    for (const cls of RISK_CLASSES) {
      const n = approvalNeeds(op({ class: cls }), cls, facts(), policy);
      // A protected read that names no kind of data (op() is in Customers, with no sensitive field) asks an Admin.
      expect(n.admin, cls).toBe(ADMIN_APPROVAL_CLASSES.includes(cls) || cls === 'read_sensitive');
      expect(n.grantable, cls).toBe(GRANTABLE[cls]);
      // Only the closed-period class needs a flag and a password by itself (moving the closing date).
      const period = cls === 'period';
      expect(n).toMatchObject({
        fileAdmin: false,
        hostOnly: false,
        flag: period ? 'closedPeriod' : null,
        flags: period ? ['closedPeriod'] : [],
        secrets: period ? ['closing_password'] : [],
        twoPerson: false,
      });
    }
    expect(approvalNeeds(op({ classified: false, class: 'read' }), 'admin', facts(), policy)).toMatchObject({
      admin: true,
      grantable: 'no',
    });
    expect(approvalNeeds(op({ class: 'file', fileAdmin: true, hostOnly: true }), 'file', facts(), policy)).toMatchObject({
      admin: true,
      fileAdmin: true,
      hostOnly: true,
    });
  });

  it('secrets from the operation, plus the closing-date password for closed-period work', () => {
    const backup = op({ class: 'file', needsSecret: ['backup_password'] });
    expect(approvalNeeds(backup, 'file', facts(), policy).secrets).toEqual(['backup_password']);
    const closing = op({ class: 'period', needsSecret: ['closing_password'] });
    expect(approvalNeeds(closing, 'period', facts(), policy).secrets).toEqual(['closing_password']);
    const moveDate = op({ class: 'period' });
    expect(approvalNeeds(moveDate, 'period', facts(), policy)).toMatchObject({ flag: 'closedPeriod', secrets: ['closing_password'] });
    const late = facts({ closedPeriod: true });
    expect(approvalNeeds(op(), effectiveClass(op(), late), late, policy)).toMatchObject({
      flag: 'closedPeriod',
      secrets: ['closing_password'],
      grantable: 'no',
    });
  });

  it('the reveal flag comes from what the operation reveals', () => {
    const r = facts({ reveal: true });
    const need = (reveal: Operation['reveal']) => approvalNeeds(op({ class: 'read', reveal }), 'read_sensitive', r, policy).flag;
    expect(need('ssn')).toBe('sensitivePayroll');
    expect(need('payroll')).toBe('sensitivePayroll');
    expect(need('account_numbers')).toBe('fullAccountNumbers');
    expect(need(null)).toBeNull();
    expect(approvalNeeds(op({ class: 'read', reveal: 'ssn' }), 'read', facts(), policy).flag).toBeNull();
  });

  it('standing permission is never offered for alwaysAsk, and never looser than the operation\'s own class', () => {
    expect(approvalNeeds(op({ class: 'enter', alwaysAsk: true }), 'enter', facts(), policy).grantable).toBe('no');
    // enter raised to change: both "yes".
    expect(approvalNeeds(op({ class: 'enter' }), 'change', facts({ confirm: ['allowDuplicateNumber'] }), policy).grantable).toBe('yes');
    // bulk raised to period: "no".
    expect(approvalNeeds(op({ class: 'bulk' }), 'period', facts({ closedPeriod: true }), policy).grantable).toBe('no');
  });

  it('a reveal is one at a time on every class, even when it is judged under a stricter one (D6)', () => {
    for (const cls of RISK_CLASSES) {
      for (const reveal of [null, 'ssn', 'account_numbers', 'payroll'] as const) {
        const o = op({ class: cls, reveal });
        const f = facts({ reveal: true });
        expect(approvalNeeds(o, effectiveClass(o, f), f, policy).grantable, `${cls} ${reveal}`).toBe('no');
        const d = run({ policy: everywhere('ask', 'full_with_asks'), operation: o, facts: f });
        if (d.outcome === 'ask') expect(d.needs.grantable, `${cls} ${reveal}`).toBe('no');
      }
    }
    // The case that slipped before: an outside send with a reveal is judged as outside.
    const send = op({ class: 'outside', reveal: 'ssn' });
    const f = facts({ reveal: true });
    expect(effectiveClass(send, f)).toBe('outside');
    expect(approvalNeeds(send, 'outside', f, policy)).toMatchObject({ flag: 'sensitivePayroll', grantable: 'no' });
  });

  it('a request that needs two approver flags is asked with both, never refused for it', () => {
    const payrollChange = op({
      id: 'payroll.adjust',
      class: 'change',
      reveal: 'ssn',
      rule: { area: 'payroll', action: 'modify' },
      area: 'payroll',
      action: 'modify',
    });
    const both = facts({ reveal: true, closedPeriod: true, date: '2025-12-31' });
    for (const preset of AGENT_PRESETS) {
      for (const s of POLICY_SETTINGS) {
        const d = run({ access: ADMIN, policy: everywhere(s, preset), operation: payrollChange, facts: both, grants: [grant({ operation: 'payroll.adjust' })] });
        const label = `${preset} ${s}`;
        if (s === 'never') {
          expect(d, label).toMatchObject({ outcome: 'refuse', code: 'never' });
          continue;
        }
        // Allow or Ask: a reveal and a closed date are never Allow, and no grant covers either.
        expect(d, label).toMatchObject({ outcome: 'ask', effectiveClass: 'period' });
        if (d.outcome === 'ask') {
          expect(d.needs.flags, label).toEqual(['closedPeriod', 'sensitivePayroll']);
          expect(d.needs.flag, label).toBe('closedPeriod');
          expect(d.needs.secrets, label).toEqual(['closing_password']);
          expect(d.needs.grantable, label).toBe('no');
        }
      }
    }
    // The role needs both rights too: missing either one is refused, and the refusal says what to do instead.
    const allowAll = everywhere('allow', 'full_with_asks');
    const noView = run({ access: ACCOUNTANT, policy: allowAll, operation: payrollChange, facts: both });
    expect(noView).toMatchObject({ outcome: 'refuse', code: 'role' });
    expect(noView.outcome === 'refuse' && noView.message).toBe(
      'Your role does not allow this: it needs "View sensitive payroll data (full SSNs)". Send the request again ' +
        "without asking to see the full values, or ask an Admin to change this agent's role.",
    );
    const noClosed = run({ access: PAYROLL, policy: allowAll, operation: payrollChange, facts: both });
    expect(noClosed).toMatchObject({ outcome: 'refuse', code: 'role' });
    expect(noClosed.outcome === 'refuse' && noClosed.message).toBe(
      'Your role does not allow this: it needs "Modify transactions on or before the closing date". Ask a person who may ' +
        "change entries on or before the closing date to do it, or ask an Admin to change this agent's role.",
    );
    // Each half on its own is asked, with its own flag.
    const closedOnly = run({ access: ADMIN, policy: allowAll, operation: payrollChange, facts: facts({ closedPeriod: true }) });
    expect(closedOnly.outcome === 'ask' && closedOnly.needs.flags).toEqual(['closedPeriod']);
    const revealOnly = run({ access: ADMIN, policy: allowAll, operation: payrollChange, facts: facts({ reveal: true }) });
    expect(revealOnly.outcome === 'ask' && revealOnly.needs.flags).toEqual(['sensitivePayroll']);
    // A reconciled edit with a reveal needs only the View flag: the closing-date right is not involved.
    const reconciled = run({
      access: ADMIN,
      policy: allowAll,
      operation: payrollChange,
      facts: facts({ reveal: true, confirm: ['allowReconciledEdit'] }),
    });
    expect(reconciled).toMatchObject({ outcome: 'ask', effectiveClass: 'period' });
    if (reconciled.outcome === 'ask') expect(reconciled.needs).toMatchObject({ flag: 'sensitivePayroll', flags: ['sensitivePayroll'] });
  });

  it('flag is always the first of flags, for every class and request fact', () => {
    for (const cls of RISK_CLASSES) {
      for (const reveal of [null, 'ssn', 'account_numbers', 'payroll'] as const) {
        for (const [name, f] of FACT_VARIANTS) {
          const o = op({ class: cls, reveal, sensitiveFields: ['accountNumber'] });
          const n = approvalNeeds(o, effectiveClass(o, f), f, policy);
          const label = `${cls} ${reveal} ${name}`;
          expect(Array.isArray(n.flags), label).toBe(true);
          expect(n.flag, label).toBe(n.flags?.[0] ?? null);
          expect(new Set(n.flags).size, label).toBe(n.flags?.length);
          // The closing-date password goes with the closed-period right, and only with it (no operation secrets here).
          expect(n.secrets.includes('closing_password'), label).toBe(n.flags?.includes('closedPeriod'));
        }
      }
    }
  });

  it('grantAdminOnly is grantNeedsAdmin, for every class and request fact (D5)', () => {
    for (const cls of RISK_CLASSES) {
      for (const classified of [true, false]) {
        for (const [name, f] of FACT_VARIANTS) {
          const o = op({ class: cls, classified, reveal: 'ssn' });
          expect(approvalNeeds(o, effectiveClass(o, f), f, policy).grantAdminOnly, `${cls} ${classified} ${name}`).toBe(
            grantNeedsAdmin(o, f),
          );
        }
      }
    }
    const send = run({ access: ADMIN, policy, operation: op({ id: 'invoices.email', class: 'outside' }) });
    expect(send.outcome === 'ask' && send.needs).toMatchObject({ grantable: 'short', grantAdminOnly: true, admin: false });
    const enter = run({ access: ADMIN, policy, operation: op() });
    expect(enter.outcome === 'ask' && enter.needs).toMatchObject({ grantable: 'yes', grantAdminOnly: false });
  });

  it('only an Admin may give the short window for outside sends (D5)', () => {
    expect(grantNeedsAdmin(op({ class: 'outside' }), facts())).toBe(true);
    expect(grantNeedsAdmin(op({ class: 'print' }), facts())).toBe(false);
    expect(grantNeedsAdmin(op({ class: 'enter' }), facts())).toBe(false);
    expect(grantNeedsAdmin(op({ class: 'bulk' }), facts())).toBe(false);
    expect(grantNeedsAdmin(op({ classified: false, class: 'enter' }), facts())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Closed periods, protected reads, the count cap, refusal wording
// ---------------------------------------------------------------------------

/** Classes that can write to the books, so the closing date applies (everything but reads and prepare). */
const BOOK_CLASSES: readonly RiskClass[] = RISK_CLASSES.filter((c) => c !== 'read' && c !== 'read_sensitive' && c !== 'prepare');

describe('closed periods: any class that can write to the books', () => {
  const closed = facts({ closedPeriod: true, date: '2025-12-31' });
  const allowAll = everywhere('allow', 'full_with_asks');

  it('needs the closed-period right of the role and of the approver, and the closing-date password', () => {
    for (const cls of RISK_CLASSES) {
      const o = op({ id: 'cp.op', class: cls });
      const writes = BOOK_CLASSES.includes(cls);
      expect(flagsNeeded(o, closed).includes('closedPeriod'), cls).toBe(writes);

      // A Bookkeeper may create in Customers & Receivables but not work in a closed period.
      const bk = run({ access: BOOKKEEPER, policy: allowAll, operation: o, facts: closed });
      if (writes) {
        expect(bk, cls).toMatchObject({ outcome: 'refuse', code: 'role' });
        expect(bk.outcome === 'refuse' && bk.message, cls).toContain('Modify transactions on or before the closing date');
      } else {
        expect(bk.outcome === 'refuse' ? bk.code : null, cls).toBeNull();
      }

      // An Accountant has the right: asked, with the right and the password on the card, one at a time.
      const acc = run({ access: ACCOUNTANT, policy: allowAll, operation: o, facts: closed });
      if (!writes) continue;
      expect(acc, cls).toMatchObject({ outcome: 'ask', effectiveClass: classRank(cls) > classRank('period') ? cls : 'period' });
      if (acc.outcome === 'ask') {
        expect(acc.needs.flags, cls).toEqual(['closedPeriod']);
        expect(acc.needs.secrets, cls).toEqual(['closing_password']);
        expect(acc.needs.grantable, cls).toBe('no');
        expect(acc.needs.admin, cls).toBe(ADMIN_APPROVAL_CLASSES.includes(cls));
      }
    }
  });

  it('an outside or print request in a closed period is held by the closed-period setting too', () => {
    const policy = resolvePolicy('full_with_asks', [{ class: 'period', area: null, setting: 'never' }]);
    for (const cls of ['outside', 'print', 'settings', 'file'] as RiskClass[]) {
      const o = op({ id: 'cp.op', class: cls });
      expect(run({ access: ADMIN, policy, operation: o }).outcome, cls).toBe('ask');
      const d = run({ access: ADMIN, policy, operation: o, facts: closed });
      expect(d, cls).toMatchObject({ outcome: 'refuse', code: 'never' });
      expect(d.outcome === 'refuse' && d.message, cls).toContain('work on or before the closing date');
    }
  });

  it('a short window given for outside sends does not cover one dated in a closed period', () => {
    const send = op({ id: 'income.convert', class: 'outside' });
    const g = [grant({ operation: 'income.convert', constraints: {} })];
    const policy = resolvePolicy('full_with_asks', []);
    expect(run({ access: ADMIN, policy, operation: send, grants: g })).toMatchObject({ outcome: 'run', grantId: 'g1' });
    expect(run({ access: ADMIN, policy, operation: send, grants: g, facts: closed })).toMatchObject({
      outcome: 'ask',
      effectiveClass: 'period',
    });
  });
});

describe('protected reads (read_sensitive) without a reveal', () => {
  const policy = resolvePolicy('ask_every_change', []);
  const sensitive = (over: Partial<Operation>) =>
    op({ id: 'rs.op', class: 'read_sensitive', rule: { area: 'payroll', action: 'view' }, area: 'customers', action: 'view', ...over });
  const needs = (o: Operation, f: RequestFacts = facts()) => approvalNeeds(o, effectiveClass(o, f), f, policy);

  const CASES: Array<[string, Partial<Operation>, string[], boolean]> = [
    // [name, operation, flags the approver needs, Admin needed]
    ['state wage worksheet (account number field, in payroll)', { area: 'payroll', sensitiveFields: ['accountNumber'] }, ['fullAccountNumbers'], false],
    ['1099 e-file (reveals SSNs)', { area: 'reports_purchases', reveal: 'ssn' }, ['sensitivePayroll'], false],
    ['reveals payroll', { reveal: 'payroll' }, ['sensitivePayroll'], false],
    ['reveals account numbers', { reveal: 'account_numbers' }, ['fullAccountNumbers'], false],
    ['SSN and tax ID fields in lists', { sensitiveFields: ['employees.*.ssn', 'vendors.*.taxId'] }, ['sensitivePayroll'], false],
    ['an SSN and a bank account field', { sensitiveFields: ['ssn', 'bankAccountNumber'] }, ['sensitivePayroll', 'fullAccountNumbers'], false],
    ['reveals SSNs, also shows account numbers', { reveal: 'ssn', sensitiveFields: ['routingNumber'] }, ['sensitivePayroll', 'fullAccountNumbers'], false],
    ['field names in another case', { sensitiveFields: ['ROUTINGNUMBER', 'EmployeeSsn'] }, ['fullAccountNumbers', 'sensitivePayroll'], false],
    ['payroll area, nothing named', { area: 'payroll' }, ['sensitivePayroll'], false],
    ['payroll reports, nothing named', { area: 'reports_payroll' }, ['sensitivePayroll'], false],
    ['a desktop action with no area, nothing named', { area: null }, [], true],
    ['nothing named, not payroll', {}, [], true],
    ['a field that is not one the app masks', { sensitiveFields: ['checks.*.memo'] }, [], true],
    ['one field told, one not', { sensitiveFields: ['accountNumber', 'notes'] }, ['fullAccountNumbers'], true],
    ['a field ending in a wildcard', { area: 'payroll', sensitiveFields: ['employees.*'] }, ['sensitivePayroll'], true],
    ['a reveal kind the engine does not know', { reveal: 'tax_ids' as Operation['reveal'] }, ['sensitivePayroll'], true],
  ];

  it.each(CASES)('%s', (_name, over, flags, admin) => {
    const o = sensitive(over);
    const n = needs(o);
    expect(n.flags).toEqual(flags);
    expect(n.flag).toBe(flags[0] ?? null);
    expect(n.admin).toBe(admin);
    expect(n.grantable).toBe('no');
    // decide asks with the same needs: under every preset that does not refuse it, never runs.
    for (const preset of AGENT_PRESETS) {
      const d = run({ access: ADMIN, policy: resolvePolicy(preset, []), operation: o, grants: [grant({ operation: 'rs.op' })] });
      if (preset === 'read_only') expect(d).toMatchObject({ outcome: 'refuse', code: 'never' });
      else expect(d.outcome === 'ask' && d.needs).toMatchObject({ flags, admin });
    }
  });

  it('every field name the engine knows is masked by lib/permissions/mask.ts, and its flag is the one that unmasks it', () => {
    const OTHER = { sensitivePayroll: 'fullAccountNumbers', fullAccountNumbers: 'sensitivePayroll' } as const;
    const withOnly = (flag: string) =>
      ({ flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false, [flag]: true } }) as Pick<EffectiveAccess, 'flags'>;
    const entries = Object.entries(FIELD_FLAGS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, flag] of entries) {
      expect(['sensitivePayroll', 'fullAccountNumbers'], name).toContain(flag);
      expect(isSensitiveKey(name), name).toBe(true);
      const row = { [name]: '123456789' };
      // With only its own flag the field is shown in full; with only the other flag it stays masked.
      expect(maskSensitive(row, withOnly(flag))[name], `${name} with ${flag}`).toBe('123456789');
      const other = OTHER[flag as keyof typeof OTHER];
      const hidden = maskSensitive(row, withOnly(other))[name];
      expect(isMaskedValue(hidden), `${name} with only ${other}`).toBe(true);
      expect(isMaskedValue(maskSensitive(row, withOnly('closedPeriod'))[name]), `${name} with neither`).toBe(true);
    }
    expect(isSensitiveKey('memo')).toBe(false);
    // The table is frozen: nothing at run time can file a field under another flag.
    expect(Object.isFrozen(FIELD_FLAGS)).toBe(true);
  });

  it('every key mask.ts masks is one the engine knows, under the same flag', () => {
    // mask.ts does not export its key sets, so they are read from its source.
    const src = fs.readFileSync(path.join(__dirname, '..', 'permissions', 'mask.ts'), 'utf8');
    const keysOf = (set: string): string[] => {
      const m = new RegExp(`const ${set} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(src);
      expect(m, `${set} in mask.ts`).not.toBeNull();
      return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    const ssnKeys = keysOf('SSN_KEYS');
    const accountKeys = keysOf('ACCOUNT_KEYS');
    expect(ssnKeys.length).toBeGreaterThan(0);
    expect(accountKeys.length).toBeGreaterThan(0);
    for (const k of ssnKeys) expect(FIELD_FLAGS[k], k).toBe('sensitivePayroll');
    for (const k of accountKeys) expect(FIELD_FLAGS[k], k).toBe('fullAccountNumbers');
    expect(Object.keys(FIELD_FLAGS).sort()).toEqual([...ssnKeys, ...accountKeys].sort());
  });

  it('a listed field is matched on the last part of its path, ignoring case', () => {
    for (const [name, flag] of Object.entries(FIELD_FLAGS)) {
      for (const field of [name, name.toUpperCase(), name.toLowerCase(), `rows.*.${name}`, ` ${name} `]) {
        expect(needs(sensitive({ area: 'customers', sensitiveFields: [field] })), field).toMatchObject({ flags: [flag], admin: false });
      }
    }
    // A name that only contains a known one is not it.
    expect(needs(sensitive({ area: 'customers', sensitiveFields: ['ssnLast4'] }))).toMatchObject({ flags: [], admin: true });
  });

  it('a read that is not protected needs no View flag, whatever fields it masks', () => {
    const o = op({ class: 'read', area: 'payroll', sensitiveFields: ['ssn', 'accountNumber'] });
    expect(needs(o)).toMatchObject({ flags: [], flag: null, admin: false });
  });

  it('a reveal on an operation that names its kind needs only that kind; one that names nothing goes by its fields', () => {
    const r = facts({ reveal: true });
    expect(needs(op({ class: 'read', reveal: 'ssn', sensitiveFields: ['accountNumber'] }), r)).toMatchObject({
      flags: ['sensitivePayroll'],
      admin: false,
    });
    expect(needs(op({ class: 'read', reveal: null, sensitiveFields: ['accountNumber'] }), r)).toMatchObject({
      flags: ['fullAccountNumbers'],
      admin: false,
    });
    expect(needs(op({ class: 'read', reveal: null }), r)).toMatchObject({ flags: [], admin: true });
    expect(needs(op({ class: 'read', reveal: null, area: 'payroll' }), r)).toMatchObject({ flags: ['sensitivePayroll'], admin: false });
    // A protected read with a reveal still needs everything it shows.
    expect(needs(sensitive({ reveal: 'ssn', sensitiveFields: ['accountNumber'] }), r)).toMatchObject({
      flags: ['sensitivePayroll', 'fullAccountNumbers'],
      admin: false,
    });
  });

  it('in a closed period the closed-period right comes first (a protected read never writes, so it is not added)', () => {
    const o = sensitive({ area: 'payroll', sensitiveFields: ['accountNumber'] });
    expect(needs(o, facts({ closedPeriod: true }))).toMatchObject({ flags: ['fullAccountNumbers'], secrets: [] });
    const write = op({ class: 'change', reveal: 'account_numbers' });
    expect(needs(write, facts({ closedPeriod: true, reveal: true }))).toMatchObject({
      flag: 'closedPeriod',
      flags: ['closedPeriod', 'fullAccountNumbers'],
    });
  });
});

describe('the count cap holds for every operation that reports a count', () => {
  it('not only bulk work: every class, under Allow, Ask and a grant', () => {
    const policy: AgentPolicy = { ...everywhere('allow', 'full_with_asks'), bulkCap: 10 };
    for (const cls of RISK_CLASSES) {
      const o = op({ id: 'cap.op', class: cls });
      const g = [grant({ operation: 'cap.op', constraints: { maxCount: 1000 } })];
      const over = run({ access: ADMIN, policy, operation: o, facts: facts({ count: 11 }), grants: g });
      expect(over, cls).toMatchObject({ outcome: 'refuse', code: 'bulk_cap' });
      expect(over.outcome === 'refuse' && over.message, cls).toBe(
        'This would change 11 records, more than this agent may change in one request (10). Split it into smaller requests, or ask an Admin to raise the limit.',
      );
      const within = run({ access: ADMIN, policy, operation: o, facts: facts({ count: 10 }), grants: g });
      expect(within.outcome === 'refuse' ? within.code : null, cls).toBeNull();
    }
  });
});

describe('every refusal says what the agent can do instead', () => {
  const NEXT_STEP = /(Ask a person|ask a person|Ask an Admin|ask an Admin|Split it into smaller requests|Send the request again)/;

  it('for every code, role, preset, setting, class and request fact', () => {
    const accesses = [ADMIN, BOOKKEEPER, VIEW_ONLY, ACCOUNTANT, PAYROLL];
    const policies: AgentPolicy[] = [{ ...resolvePolicy('full_with_asks', []), pausedAt: EARLIER }];
    for (const preset of AGENT_PRESETS) {
      policies.push(resolvePolicy(preset, [], { bulkCap: 10 }));
      for (const s of POLICY_SETTINGS) policies.push(everywhere(s, preset));
      policies.push(resolvePolicy(preset, [{ class: 'enter', area: 'customers', setting: 'never' }]));
    }
    const messages = new Map<string, string>();
    const codes = new Set<string>();
    for (const cls of RISK_CLASSES) {
      for (const availability of ['agent', 'person_only', 'hard_floor'] as const) {
        for (const rule of [{ area: 'customers' as Area, action: 'create' as Action }, null]) {
          const operation = op({ id: 'msg.op', class: cls, availability, rule, reveal: 'account_numbers' });
          for (const policy of policies) {
            for (const access of accesses) {
              for (const [, f] of FACT_VARIANTS) {
                const d = run({ access, policy, operation, facts: f });
                if (d.outcome !== 'refuse') continue;
                codes.add(d.code);
                messages.set(d.message, d.code);
              }
            }
          }
        }
      }
    }
    expect([...codes].sort()).toEqual(['bulk_cap', 'hard_floor', 'never', 'paused', 'person_only', 'role']);
    for (const [message, code] of messages) {
      expect(message, code).toMatch(NEXT_STEP);
      // Plain words: no class ids, no empty values.
      expect(message, code).not.toMatch(/_|undefined|null|NaN|\[object/);
    }
  });
});

// ---------------------------------------------------------------------------
// Inputs of the wrong shape (the engine is the last gate)
// ---------------------------------------------------------------------------

describe('inputs of the wrong shape fail closed', () => {
  const bad = (f: Record<string, unknown>) => ({ ...facts(), ...f }) as unknown as RequestFacts;

  it('a confirm flag that is not a list still raises the class', () => {
    const change = op({ class: 'change' });
    expect(effectiveClass(change, bad({ confirm: 'allowReconciledEdit' }))).toBe('period');
    expect(effectiveClass(change, bad({ confirm: { allowReconciledEdit: true } }))).toBe('period');
    expect(effectiveClass(change, bad({ confirm: [7] }))).toBe('period');
    expect(effectiveClass(op({ class: 'enter' }), bad({ confirm: 'allowDuplicateNumber' }))).toBe('change');
    expect(effectiveClass(change, bad({ confirm: 'allowDuplicateNumber' }))).toBe('change');
    for (const none of [null, undefined, '', []]) expect(effectiveClass(change, bad({ confirm: none }))).toBe('change');
  });

  it('a closed-period value that is set but not true is read as true for every rule', () => {
    const closed = bad({ closedPeriod: 1, date: '2025-12-31' });
    expect(effectiveClass(op(), closed)).toBe('period');
    const refused = run({ access: BOOKKEEPER, policy: everywhere('allow', 'full_with_asks'), facts: closed });
    expect(refused).toMatchObject({ outcome: 'refuse', code: 'role' });
    const asked = run({ access: ACCOUNTANT, policy: everywhere('allow', 'full_with_asks'), facts: closed });
    expect(asked).toMatchObject({ outcome: 'ask', effectiveClass: 'period' });
    if (asked.outcome === 'ask') expect(asked.needs).toMatchObject({ flag: 'closedPeriod', secrets: ['closing_password'] });
  });

  it('prepare work dated on or before the closing date is not closed-period work', () => {
    const stage = op({ id: 'banking.feed.import', class: 'prepare' });
    const closed = facts({ closedPeriod: true, date: '2025-12-31' });
    // A bookkeeper may stage old statement lines in the window, so the agent with that role may too.
    expect(run({ access: BOOKKEEPER, operation: stage, facts: closed })).toMatchObject({ outcome: 'run', effectiveClass: 'prepare' });
    expect(approvalNeeds(stage, 'prepare', closed, resolvePolicy('ask_every_change', []))).toMatchObject({ flag: null, secrets: [] });
    // Under Ask it is a person's question with no closing-date password; a grant given for
    // undated work does not stretch to it (the stricter reading, in grantCovers).
    const askPrepare = resolvePolicy('ask_every_change', [{ class: 'prepare', area: null, setting: 'ask' }]);
    const d = run({ access: BOOKKEEPER, policy: askPrepare, operation: stage, facts: closed, grants: [grant({ operation: 'banking.feed.import' })] });
    expect(d).toMatchObject({ outcome: 'ask', effectiveClass: 'prepare' });
  });
});
