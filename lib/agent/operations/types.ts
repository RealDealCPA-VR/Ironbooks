/**
 * Agent full access: the shared types of the operation registry, the policy and permission
 * requests (AGENT_ACCESS.md, "Full access").
 *
 * Pure module: types and small constants only. No Node, database or Next imports, so the policy
 * engine, the registry, the bridge, the MCP generator and the pages can all import it.
 *
 * One OPERATION is one API route + method (or one desktop-shell action). Every operation has
 * exactly one RISK CLASS. Per agent, each class is set to Allow, Ask or Never (the POLICY). An
 * operation the policy says "Ask" for becomes a PERMISSION REQUEST a person approves or denies.
 */
import type { Action, Area, EffectiveAccess } from '@/lib/permissions/model';
import type { ActivityKey } from '@/lib/permissions/activities';
import type { HttpMethod, RouteRule } from '@/lib/permissions/routes';

// ---------------------------------------------------------------------------
// Risk classes
// ---------------------------------------------------------------------------

export const RISK_CLASSES = [
  'read',
  'read_sensitive',
  'prepare',
  'enter',
  'change',
  'bulk',
  'remove',
  'period',
  'outside',
  'print',
  'settings',
  'admin',
  'file',
  'secret',
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export function isRiskClass(v: unknown): v is RiskClass {
  return typeof v === 'string' && (RISK_CLASSES as readonly string[]).includes(v);
}

export const RISK_CLASS_LABELS: Record<RiskClass, string> = {
  read: 'Read',
  read_sensitive: 'Read protected data',
  prepare: 'Prepare work',
  enter: 'Enter new',
  change: 'Change or void',
  bulk: 'Change many at once',
  remove: 'Delete for good',
  period: 'Closed-period work',
  outside: 'Send outside this computer',
  print: 'Print',
  settings: 'Company settings',
  admin: 'Users and security',
  file: 'Company file',
  secret: 'Passwords and keys',
};

export const POLICY_SETTINGS = ['allow', 'ask', 'never'] as const;
export type PolicySetting = (typeof POLICY_SETTINGS)[number];

/** Classes that can never be set to Allow: the most they can be is Ask. */
export const NEVER_ALLOW_CLASSES: readonly RiskClass[] = [
  'read_sensitive',
  'remove',
  'period',
  'outside',
  'print',
  'settings',
  'admin',
  'file',
  'secret',
];

/** Classes only an Admin may approve. */
export const ADMIN_APPROVAL_CLASSES: readonly RiskClass[] = ['admin', 'file', 'secret'];

/**
 * Whether a person may give standing permission (a grant) while approving.
 * 'yes' up to end of day; 'capped' the same with a count cap; 'short' a window of at most
 * 30 minutes; 'no' every request is asked one by one.
 */
export const GRANTABLE: Record<RiskClass, 'yes' | 'capped' | 'short' | 'no'> = {
  read: 'no',
  read_sensitive: 'no',
  prepare: 'yes',
  enter: 'yes',
  change: 'yes',
  bulk: 'capped',
  remove: 'no',
  period: 'no',
  outside: 'short',
  print: 'short',
  settings: 'no',
  admin: 'no',
  file: 'no',
  secret: 'no',
};

// ---------------------------------------------------------------------------
// Classification (hand-written, one entry per route + method)
// ---------------------------------------------------------------------------

/** A secret an operation needs from, or shows to, the approving person. Never the agent. */
export type SecretKind =
  | 'closing_password'
  | 'file_password'
  | 'backup_password'
  | 'archive_credentials'
  | 'new_user_password'
  | 'mail_password'
  | 'portal_password'
  | 'recovery_key'
  | 'file_key'
  | 'capability_link';

export type EffectKind = 'email' | 'file' | 'print' | 'network';
export type BodyKind = 'none' | 'json' | 'bytes' | 'multipart' | 'text';
export type OutputKind = 'json' | 'pdf' | 'file' | 'stream';
export type DryRunKind = 'transaction' | 'preview' | 'none';

/**
 * 'agent'       reachable by an agent, subject to role, policy and approval (the default).
 * 'person_only' the route IS a person acting as themselves (sign-in, 2FA, portal, their own
 *               preferences, the ChatGPT sign-in). Not an operation an agent can ask for.
 * 'hard_floor'  refused for agents with or without approval (agents managing agents, approving
 *               requests, the kill switch, audit history).
 */
export type Availability = 'agent' | 'person_only' | 'hard_floor';

/** The key of a classification entry: "POST /api/invoices/[id]/email". */
export type OperationKey = `${HttpMethod} ${string}`;

export function operationKey(method: HttpMethod, pattern: string): OperationKey {
  return `${method} ${pattern}`;
}

export interface OperationClassification {
  class: RiskClass;
  /**
   * One line in plain words saying what a request does, for the approval card and the answer.
   * `{name}` placeholders are filled from route params, then query, then body, then the route's
   * own answer: "Email invoice {number} to {to}".
   */
  describe: string;
  /** Overrides the generated operation id ("invoices.email"). Rarely needed. */
  id?: string;
  /** Default 'agent'. */
  availability?: Availability;
  /** Why the class differs from the method's default, or why it is not available to agents. */
  why?: string;
  /**
   * How a request is previewed. 'transaction': really run, in a transaction that is rolled back.
   * 'preview': the route has its own preview mode. 'none': described only (services that open
   * their own database handle, shell actions, outside-only work).
   * Default: 'transaction' for every class that writes; ignored for 'read'.
   */
  dryRun?: DryRunKind;
  /** Default: 'json' for POST/PUT/PATCH, 'none' for GET/DELETE. */
  body?: BodyKind;
  /** Default 'json'. */
  output?: OutputKind;
  /** Flags the route accepts after a 409 warning (allowDuplicateNumber, allowReconciledEdit …). */
  confirmFlags?: string[];
  /** Body or answer fields masked in previews, stored requests and logs (dotted paths, * for any). */
  sensitiveFields?: string[];
  /**
   * The answer is masked by default and a request with `reveal: true` asks for the full values.
   * Names what is revealed. A revealed call is class 'read_sensitive'.
   */
  reveal?: 'ssn' | 'account_numbers' | 'payroll';
  /** The route is host-only (lib/net/hostOnly.ts): approvable only at the host's own window. */
  hostOnly?: boolean;
  /** The route needs the FILE Admin (requireFileAdmin). */
  fileAdmin?: boolean;
  /** Secrets the approver types on the card; the bridge passes them to the route, never the agent. */
  needsSecret?: SecretKind[];
  /** The answer holds a secret: shown once to the approver, redacted for the agent. */
  producesSecret?: SecretKind[];
  /** What leaves the database when it runs (the effects outbox captures these in a preview). */
  effects?: EffectKind[];
  /** Dotted path in the body of the array whose length is the number of records changed (bulk). */
  countField?: string;
  /** Dotted path in the body (or the answer) of the money amount, for limits and grants. */
  amountField?: string;
  /** Ask even where the policy says Allow (a recurring definition, a pay run). */
  alwaysAsk?: boolean;
  /** The zod schema of the body when the generator cannot find it: "@/lib/validation/x#name". */
  bodySchema?: string;
}

export type ClassificationMap = Record<string, OperationClassification>;

/** The class a method gets when nothing says otherwise. An unclassified route is 'admin' at runtime. */
export const DEFAULT_CLASS_BY_METHOD: Record<HttpMethod, RiskClass> = {
  GET: 'read',
  POST: 'enter',
  PUT: 'change',
  PATCH: 'change',
  DELETE: 'remove',
};

// ---------------------------------------------------------------------------
// The registry entry (generated parts + routes.ts + classification, defaults applied)
// ---------------------------------------------------------------------------

export interface Operation {
  /** "invoices.create", "invoices.email", "shell.company.switch". Unique and stable. */
  id: string;
  kind: 'route' | 'shell';
  /** Route pattern ("/api/invoices/[id]/email"); for shell operations the IPC flow name. */
  route: string;
  method: HttpMethod;
  /** Names of the route's path parameters, in order. */
  params: string[];
  /** The rule a person's request meets (lib/permissions/routes.ts). Shell: null. */
  rule: RouteRule | null;
  area: Area | null;
  action: Action | null;
  activity: ActivityKey | null;
  /** False when no hand-written classification exists: treated as class 'admin', always Ask. */
  classified: boolean;
  class: RiskClass;
  describe: string;
  availability: Availability;
  why: string | null;
  dryRun: DryRunKind;
  body: BodyKind;
  output: OutputKind;
  confirmFlags: string[];
  sensitiveFields: string[];
  reveal: OperationClassification['reveal'] | null;
  hostOnly: boolean;
  fileAdmin: boolean;
  needsSecret: SecretKind[];
  producesSecret: SecretKind[];
  effects: EffectKind[];
  countField: string | null;
  amountField: string | null;
  alwaysAsk: boolean;
  /** "@/lib/validation/x#name" of the body schema, or null when the route parses by hand. */
  bodySchema: string | null;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const AGENT_PRESETS = ['read_only', 'ask_every_change', 'trusted_bookkeeper', 'full_with_asks'] as const;
export type AgentPreset = (typeof AGENT_PRESETS)[number];

export const AGENT_PRESET_LABELS: Record<AgentPreset, string> = {
  read_only: 'Read only',
  ask_every_change: 'Ask for every change',
  trusted_bookkeeper: 'Trusted bookkeeper',
  full_with_asks: 'Full, with asks',
};

/** One stored override row (agent_policies): a class, optionally within one area. */
export interface PolicyOverride {
  class: RiskClass;
  area: Area | null;
  setting: PolicySetting;
}

/** An agent's policy with the preset's defaults and the overrides applied. */
export interface AgentPolicy {
  preset: AgentPreset;
  classes: Record<RiskClass, PolicySetting>;
  areas: Partial<Record<Area, Partial<Record<RiskClass, PolicySetting>>>>;
  /** Most records one 'bulk' request may change; null = bulk requests are not capped. */
  bulkCap: number | null;
  /** Amount (decimal text) above which two different people must approve; null = off. */
  twoPersonOver: string | null;
  /** Days a pending request waits before it expires. */
  requestExpiryDays: number;
  /** Folders the agent may read files from or save files to. */
  folders: string[];
  /** Email the Admin when an unattended agent asks. Off by default (it is an outside send). */
  notifyEmail: boolean;
  /** ISO time the agent was paused, or null. A paused agent is refused everything. */
  pausedAt: string | null;
}

/** What the approver ticked when giving standing permission. Every present field must match. */
export interface GrantConstraints {
  /** Customer, vendor or other name ids the request must stay within. */
  entityIds?: string[];
  accountIds?: string[];
  /** Decimal text: the request's amount must be at or below it. */
  maxAmount?: string;
  dateFrom?: string;
  dateTo?: string;
  maxUses?: number;
  /** Most records one request may change (bulk). */
  maxCount?: number;
}

export interface AgentGrant {
  id: string;
  agentId: string;
  /** The operation id it covers. */
  operation: string;
  constraints: GrantConstraints;
  givenBy: string;
  /** ISO time. */
  expiresAt: string;
  revokedAt: string | null;
  uses: number;
}

/** What the caller worked out about one request, for the policy and for grant matching. */
export interface RequestFacts {
  /** Confirmation flags the agent sent (allowDuplicateNumber …). */
  confirm: string[];
  /** The agent asked for unmasked values. */
  reveal: boolean;
  amount: string | null;
  count: number | null;
  entityIds: string[];
  accountIds: string[];
  /** The transaction date (ISO) when the request has one. */
  date: string | null;
  /** The date is on or before the closing date. */
  closedPeriod: boolean;
}

export interface ApprovalNeeds {
  /** An Admin must approve. */
  admin: boolean;
  /** The file Admin must approve. */
  fileAdmin: boolean;
  /** Approvable only at the host computer's own window. */
  hostOnly: boolean;
  /** The approver needs this flag themselves. */
  flag: 'sensitivePayroll' | 'fullAccountNumbers' | 'closedPeriod' | null;
  /** Secrets the approver types on the card. */
  secrets: SecretKind[];
  /** Two different people must approve. */
  twoPerson: boolean;
  /** Whether the approver may give standing permission while approving. */
  grantable: 'yes' | 'capped' | 'short' | 'no';
}

export type RefusalCode =
  | 'paused'
  | 'person_only'
  | 'hard_floor'
  | 'role'
  | 'never'
  | 'bulk_cap';

export type PolicyDecision =
  | { outcome: 'refuse'; code: RefusalCode; message: string; effectiveClass: RiskClass }
  | { outcome: 'run'; effectiveClass: RiskClass; grantId: string | null }
  | { outcome: 'ask'; effectiveClass: RiskClass; needs: ApprovalNeeds };

export interface PolicyInput {
  /** The agent's role access (its ceiling), with the agent limits applied. */
  access: EffectiveAccess;
  policy: AgentPolicy;
  operation: Operation;
  facts: RequestFacts;
  /** Live grants of this agent (unexpired, unrevoked); the engine matches them itself. */
  grants: AgentGrant[];
  /** ISO time of the decision (passed in, so the engine stays pure). */
  now: string;
}

// ---------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------

export const REQUEST_STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled', 'failed', 'executed'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** One thing that would leave the database, as a preview shows it. */
export interface EffectPreview {
  kind: EffectKind;
  /** Plain words: "Email to billing@acme.com: Invoice 1042 (1 attachment)". */
  summary: string;
  detail: Record<string, unknown>;
}

export interface RecordDiff {
  action: string;
  kind: string;
  id: string;
  /** Changed fields only; values of sensitive fields are masked. */
  fields: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface WarningPreview {
  flag: string;
  message: string;
}
