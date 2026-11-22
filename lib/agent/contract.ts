/**
 * Agent full access: the shared shapes of everything built on the registry and the policy: the
 * route bridge, staged files, the policy store, grants, permission requests, the agent's door,
 * the HTTP API a person's window uses, and the screens.
 *
 * Types and constants only (safe to `import type` from client components). Each module exports its
 * functions typed by the function types below (`export const stageFile: StageFile = async …`), so
 * the type checker holds every side to the same contract.
 */
import type { EffectiveAccess, Area } from '@/lib/permissions/model';
import type { ServiceContext } from '@/lib/services/_base';
import type { EffectReport } from '@/lib/effects';
import type { ChangePreview } from './actions';
import type {
  AgentGrant,
  AgentPolicy,
  AgentPreset,
  ApprovalNeeds,
  EffectPreview,
  GrantConstraints,
  Operation,
  PolicyOverride,
  PolicySetting,
  RecordDiff,
  RequestFacts,
  RequestStatus,
  RiskClass,
  SecretKind,
  WarningPreview,
} from './operations/types';

// ---------------------------------------------------------------------------
// 1. What an agent sends for one operation
// ---------------------------------------------------------------------------

/** A file field in a body: the bridge turns it into the route's own shape (§5.7). */
export interface FileRef {
  fileId: string;
}

export interface OperationInput {
  /** Path parameters by name ("id"). */
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  /** The JSON body in the app's own field names. A file field may be a FileRef. */
  body?: unknown;
  /** Confirmation flags the agent resends after a warning (allowDuplicateNumber …). */
  confirm?: string[];
  /** Ask for unmasked values (always asks a person). */
  reveal?: boolean;
  /**
   * (wave 4) The record's updatedAt as the caller last read it. The bridge sends it to the route as
   * the x-expected-updated-at header, so the route's own withVersionCheck compares it inside the
   * committing transaction: a person's edit made in between answers 409, never an overwrite.
   */
  expectedUpdatedAt?: string;
}

// ---------------------------------------------------------------------------
// 2. Preview: what a request does, or would do
// ---------------------------------------------------------------------------

export interface OperationPreview {
  /** Ledger entries and touched records (lib/agent/actions.ts changesInTransaction). */
  ledger: ChangePreview | null;
  /** Field-level changes from the audit rows, sensitive values masked. */
  records: RecordDiff[];
  /** What would leave the database: emails, saved files, print jobs, calls to other computers. */
  effects: EffectPreview[];
  /** Warnings the route raised (each names the flag that would accept it). */
  warnings: WarningPreview[];
  /** For work that removes something: what is lost, in plain words. */
  loss: string | null;
  /** The route's own preview answer, for operations with dryRun 'preview'. */
  routePreview: unknown;
  /** True when rows were left out to keep the preview small. */
  truncated: boolean;
}

/** Most ledger entries and most record changes a stored preview keeps. */
export const PREVIEW_ROW_LIMIT = 200;
/** Time limit of one bridged call, and of a report. */
export const BRIDGE_TIME_LIMIT_MS = 10_000;
export const BRIDGE_REPORT_TIME_LIMIT_MS = 30_000;

// ---------------------------------------------------------------------------
// 3. Staged files (lib/agent/files.ts), plan §5.7
// ---------------------------------------------------------------------------

export interface StagedFile {
  fileId: string;
  name: string;
  /** MIME type. */
  type: string;
  size: number;
}

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const STAGED_FILE_HOURS = 24;

/** Whose file it is: an agent only ever reaches its own company's and its own files. */
export interface FileOwner {
  companyId: string;
  agentId: string;
}

export type StageFile = (owner: FileOwner, file: { name: string; type: string; bytes: Uint8Array }) => Promise<StagedFile>;
/** Null when there is no such file for this owner (also when it has been cleared). */
export type ReadStagedFile = (owner: FileOwner, fileId: string) => Promise<{ file: StagedFile; bytes: Uint8Array } | null>;
export type StagedFileInfo = (owner: FileOwner, fileId: string) => Promise<StagedFile | null>;
/** One chunk of an upload. The first call has no uploadId; the last has `last: true` and returns the file. */
export type UploadChunk = (
  owner: FileOwner,
  part: { uploadId?: string; name: string; type: string; chunkBase64: string; last: boolean },
) => Promise<{ uploadId: string; received: number; file: StagedFile | null }>;
/** Remove files older than STAGED_FILE_HOURS (all of them with `all`). Returns how many went. */
export type ClearStagedFiles = (opts?: { all?: boolean }) => Promise<number>;
/**
 * The folder as it will be used, when `folder` is inside one of `allowed` (after resolving links
 * and ".."), otherwise null.
 */
export type AllowedFolder = (allowed: readonly string[], folder: string) => Promise<string | null>;

// ---------------------------------------------------------------------------
// 4. The route bridge (lib/agent/bridge.ts), plan §5.2
// ---------------------------------------------------------------------------

/** 'read': on the read-only handle. 'dry_run': really run, rolled back. 'commit': run and keep. */
export type BridgeMode = 'read' | 'dry_run' | 'commit';

/** Who a bridged run is for and what it may use. Built by the door or the approval, never by a request body. */
export interface BridgeActor {
  agent: { id: string; name: string; preset: AgentPreset; onBehalfOf: string | null };
  /**
   * The access the handler runs with: the agent's ceiling (its roles, agent limits applied) when
   * it runs on its own policy or a grant; the approver's access ∩ that ceiling on an approved run.
   */
  access: EffectiveAccess;
  role: NonNullable<ServiceContext['role']>;
  /** The approver on an approved run (routes that need a person read it); null otherwise. */
  userId: string | null;
  /** Recorded on every audit row of the run (audit_logs.approved_by / agent_request_id / agent_grant_id). */
  approval: { approvedBy: string | null; requestId: string | null; grantId: string | null };
  /** A person approved unmasked values for this one call. */
  reveal: boolean;
  /** Typed by the approver on the card, held in memory for this one run. Never from the agent. */
  secrets: Partial<Record<SecretKind, string>>;
  /** Folders this agent may save files to. */
  folders: string[];
  /** The approval was given at the host computer's own window (host-only routes). */
  atHost: boolean;
}

export interface BridgeError {
  /** The app's own message. */
  message: string;
  code: string | null;
  details: unknown;
}

export interface ProducedSecret {
  kind: SecretKind;
  /** "Temporary password for Dana Lee". */
  label: string;
  value: string;
}

export interface BridgeResult {
  mode: BridgeMode;
  /** The handler's HTTP status (0 when it never ran). */
  httpStatus: number;
  /** 'needs_confirmation': the route answered 409 with a warning the agent may accept with a flag. */
  outcome: 'ok' | 'needs_confirmation' | 'error';
  /** The parsed JSON answer, masked, produced secrets redacted. Null for a file answer. */
  result: unknown;
  /** A PDF or download, staged. */
  file: StagedFile | null;
  /** Dry run: what would happen. Commit: what happened. Read: null. */
  preview: OperationPreview | null;
  warnings: WarningPreview[];
  error: BridgeError | null;
  /** Commit only: how each effect went after the commit. */
  effects: EffectReport[];
  /** The request's facts with what the run itself showed (amount and count from the answer). */
  facts: RequestFacts;
  /** Versions of the records the run touched; a later run with another key means the books changed. */
  stalenessKey: string | null;
  /** Secrets the operation produced. For the approver's screen only: never stored, never sent to the agent. */
  produced: ProducedSecret[];
}

/**
 * Run one registry operation in-process. `base` is the context of the request doing the work (the
 * agent's own, or the approving person's): the bridge takes the company and the database from it
 * and builds the handler's context from `actor`, never from `base.access`.
 * Never throws for what the handler answered: that comes back as outcome 'error'.
 */
export type RunOperation = (
  base: ServiceContext,
  operation: Operation,
  input: OperationInput,
  mode: BridgeMode,
  actor: BridgeActor,
) => Promise<BridgeResult>;

// ---------------------------------------------------------------------------
// 5. Input guards, facts and the one-line summary (lib/agent/guards.ts, facts.ts, describe.ts)
// ---------------------------------------------------------------------------

export interface GuardedInput {
  input: OperationInput;
  /** Set when the request must be refused outright (hard floor reached through a body field). */
  refused: string | null;
  /** Dotted paths removed from the agent's input (secret fields, fields only a person may set). */
  stripped: string[];
}
/** Remove what an agent may never supply and refuse what it may never ask. Pure. */
export type GuardInput = (operation: Operation, input: OperationInput) => GuardedInput;
/** Put the approver's secrets where the route reads them (a header or a body field). Pure. */
export type ApplySecrets = (
  operation: Operation,
  input: OperationInput,
  secrets: Partial<Record<SecretKind, string>>,
) => { input: OperationInput; headers: Record<string, string>; missing: SecretKind[] };
/** Redact produced secrets and mask sensitive fields in an answer. Pure. */
export type RedactAnswer = (
  operation: Operation,
  answer: unknown,
  opts: { reveal: boolean },
) => { answer: unknown; produced: ProducedSecret[] };
/**
 * The facts of a request. Before a run only the body is known; pass the dry run's `answer` to add
 * what only the answer holds. An amount is the LARGER of body and answer, never the body alone;
 * a count that cannot be known stays null (never 0).
 */
export type FactsOf = (
  operation: Operation,
  input: OperationInput,
  opts: { closingDate: string | null; answer?: unknown },
) => RequestFacts;
/** Fill the operation's describe template. A missing value shows as nothing, never "null" or "{x}". */
export type DescribeRequest = (operation: Operation, input: OperationInput, answer?: unknown) => string;

// ---------------------------------------------------------------------------
// 6. An agent's policy as stored (lib/services/agentPolicies.ts)
// ---------------------------------------------------------------------------

export interface AgentPolicyInput {
  preset?: AgentPreset;
  /** Replaces every stored override. */
  overrides?: PolicyOverride[];
  bulkCap?: number | null;
  twoPersonOver?: string | null;
  requestExpiryDays?: number;
  folders?: string[];
  notifyEmail?: boolean;
}

export interface AgentPolicyView {
  agentId: string;
  preset: AgentPreset;
  overrides: PolicyOverride[];
  policy: AgentPolicy;
  /** Cells the grid shows locked, with the reason ("Delete can never be Allow"). */
  locked: Array<{ class: RiskClass; setting: PolicySetting; reason: string }>;
}

export type LoadAgentPolicy = (ctx: ServiceContext, agentId: string) => Promise<AgentPolicy>;
export type GetAgentPolicyView = (ctx: ServiceContext, agentId: string) => Promise<AgentPolicyView>;
/** A person with Users & Roles rights; never an agent (hard floor). */
export type SaveAgentPolicy = (ctx: ServiceContext, agentId: string, input: AgentPolicyInput) => Promise<AgentPolicyView>;
export type PauseAgent = (ctx: ServiceContext, agentId: string, paused: boolean) => Promise<void>;
/** The Integrated Applications switch (company setting), one click away. */
export type PauseAllAgents = (ctx: ServiceContext, paused: boolean) => Promise<void>;
/** The agent's ceiling: its roles' access with the agent limits applied (lib/permissions/agentAccess.ts). */
export type AgentCeiling = (ctx: ServiceContext, agentId: string) => Promise<{ access: EffectiveAccess; role: NonNullable<ServiceContext['role']>; roleNames: string[] }>;

// ---------------------------------------------------------------------------
// 7. Grants: standing permission (lib/services/agentGrants.ts), plan §4.4
// ---------------------------------------------------------------------------

export interface AgentGrantView extends AgentGrant {
  agentName: string;
  operationLabel: string;
  class: RiskClass;
  givenByName: string;
  createdAt: string;
  maxUses: number | null;
}

export interface NewGrant {
  agentId: string;
  /** The operation id it covers. */
  operation: string;
  constraints: GrantConstraints;
  /** How long it lasts; checked against maxGrantMinutes (lib/agent/policy.ts). */
  minutes: number;
  /** The request it was given with, if any. */
  requestId: string | null;
}

/** Unexpired, unrevoked, not used up. */
export type LiveGrants = (ctx: ServiceContext, agentId: string, now?: Date) => Promise<AgentGrant[]>;
/** `ctx` is the approving person. Refuses classes that cannot be granted and windows that are too long. */
export type CreateGrant = (ctx: ServiceContext, facts: RequestFacts, grant: NewGrant) => Promise<AgentGrant>;
export type RevokeGrant = (ctx: ServiceContext, grantId: string) => Promise<void>;
/** Count one use inside the run's transaction; throws when the grant is gone or used up. */
export type UseGrant = (tx: ServiceContext, grantId: string) => Promise<void>;
export type ListGrants = (ctx: ServiceContext, opts?: { agentId?: string; live?: boolean }) => Promise<AgentGrantView[]>;

// ---------------------------------------------------------------------------
// 8. Permission requests (lib/services/agentRequests.ts), plan §4.3 and §7.2
// ---------------------------------------------------------------------------

/** 'operation': run this once approved. 'grant': the agent asked ahead for standing permission. */
export type AgentRequestKind = 'operation' | 'grant';

export interface AgentRequestView {
  id: string;
  kind: AgentRequestKind;
  agentId: string;
  agentName: string;
  /** The operation id ("estimates.create"), or "action:<name>" for a request copied from an old proposal. */
  operation: string;
  class: RiskClass;
  area: Area | null;
  status: RequestStatus;
  /** The agent's own words. Shown in quotes, labelled as the agent's. */
  reason: string | null;
  /** Built from the operation and the preview, never from the agent's text. */
  summary: string;
  amount: string | null;
  needs: ApprovalNeeds | null;
  /** The agent's input with secrets stripped and sensitive fields masked. */
  input: OperationInput | null;
  preview: OperationPreview | null;
  /** Asked for with a grant request. */
  grantAsked: { constraints: GrantConstraints; minutes: number } | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  secondApproverName: string | null;
  /** The person's note to the agent (on a denial, mostly). */
  note: string | null;
  /** The app's own message when the approved run failed. */
  error: string | null;
  /** The run's answer, masked and redacted: what the agent reads. */
  result: unknown;
  file: StagedFile | null;
  grantId: string | null;
  // --- wave 3 (optional: rows and readers from before it have none of these) ---
  /**
   * The books changed since the preview a person was last shown (plan §7.4): `preview` is the new
   * one, and a yes must be given again on it.
   */
  stale?: boolean;
  /** The executed run posted to the ledger (the agent's 'posted') rather than only changing records ('done'). */
  posted?: boolean;
  /** Journal entries the executed run created, oldest first, for links from the card. */
  entryIds?: string[];
  /** The standing permission actually given with the approval (it may be narrower than `grantAsked`). */
  grant?: { minutes: number; constraints: GrantConstraints; expiresAt: string } | null;
  /**
   * The approver asked to give standing permission with the approval and it was not given: why.
   * The run itself still counts as executed.
   */
  grantError?: string | null;
}

/** What a person's window gets on top: may THIS person approve, and if not, why. */
export interface AgentRequestForPerson extends AgentRequestView {
  canApprove: boolean;
  cannotApproveWhy: string | null;
  /** Up to how many minutes of standing permission this person may give with the approval (0 = none). */
  grantMinutesMax: number;
  /** wave 3: a desktop operation's questions the approver answers on the card (ApproveInput.answers). */
  questions?: FlowQuestion[];
}

export interface NewAgentRequest {
  kind: AgentRequestKind;
  /** The agent's request id (idempotency key): asking twice with it gives the same request. */
  requestKey: string;
  operation: Operation;
  input: OperationInput;
  reason: string | null;
  summary: string;
  effectiveClass: RiskClass;
  needs: ApprovalNeeds;
  facts: RequestFacts;
  preview: OperationPreview | null;
  stalenessKey: string | null;
  grantAsked?: { constraints: GrantConstraints; minutes: number } | null;
}

export interface ApproveInput {
  /** Typed on the card. Used for this one run, never stored. */
  secrets?: Partial<Record<SecretKind, string>>;
  /** "Approve similar…": also give standing permission. */
  grant?: { minutes: number; constraints: GrantConstraints } | null;
  /** The books changed since the agent asked and the person saw the new preview and said yes again. */
  acceptStale?: boolean;
  /** Answers to a shell flow's questions, by question id. */
  answers?: Record<string, unknown>;
  note?: string | null;
}

export interface ApproveResult {
  /**
   * 'executed': done. 'failed': the run failed (the request says why). 'needs_second_approver':
   * recorded, a different person must also approve. 'stale': nothing ran; `request.preview` is what
   * would happen now and the person must approve again with acceptStale. 'not_approved' (wave 3,
   * batch approval only): this one was not approved by this call and this call ran nothing;
   * `request.error` says why and `request.status` says where the request stands now (usually still
   * waiting; it may meanwhile be denied, expired, withdrawn or being carried out for someone else).
   */
  status: 'executed' | 'failed' | 'needs_second_approver' | 'stale' | 'not_approved';
  request: AgentRequestForPerson;
  /** Secrets the run produced: shown once on this screen. */
  produced: ProducedSecret[];
  effects: EffectReport[];
}

/** Most requests one agent may make in an hour before it is paused (plan §11.2). */
export const ASKS_PER_HOUR_BEFORE_PAUSE = 50;
/** Longest one long-poll may wait. */
export const WAIT_MAX_SECONDS = 50;

/** `ctx` is the agent's. Idempotent on (agent, requestKey). */
export type CreateAgentRequest = (ctx: ServiceContext, req: NewAgentRequest) => Promise<AgentRequestView>;
/** The agent's own request, or null. Also by its request key. */
export type RequestForAgent = (ctx: ServiceContext, idOrKey: string) => Promise<AgentRequestView | null>;
export type ListRequestsForAgent = (ctx: ServiceContext, opts?: { status?: RequestStatus; limit?: number }) => Promise<AgentRequestView[]>;
export type CancelAgentRequest = (ctx: ServiceContext, id: string) => Promise<AgentRequestView>;
/** Resolves when the request is decided or the time is up (whichever is first) with its state then. */
export type WaitForDecision = (ctx: ServiceContext, id: string, timeoutSeconds: number) => Promise<AgentRequestView>;

/**
 * `ctx` is a signed-in person's (never an agent's: refused). `atHost` (wave 3) is false for a
 * teammate's window: a host-only request then has canApprove false. Left out, it counts as true.
 */
export type ListRequestsForPerson = (
  ctx: ServiceContext,
  opts?: { status?: RequestStatus | 'all'; agentId?: string; limit?: number; atHost?: boolean },
) => Promise<AgentRequestForPerson[]>;
export type RequestForPerson = (ctx: ServiceContext, id: string, opts?: { atHost?: boolean }) => Promise<AgentRequestForPerson>;
/** Pending requests this person could approve (the badge). 0 for an agent's context. */
export type PendingCountForPerson = (ctx: ServiceContext) => Promise<number>;
/**
 * wave 3, exported as `badgeForPerson` by lib/services/agentRequests.ts: the title bar's count and
 * its newest request from ONE scan. Zero and null for an agent's context.
 */
export type BadgeForPerson = (
  ctx: ServiceContext,
  opts: { atHost: boolean },
) => Promise<{ pending: number; newest: { id: string; agentName: string; summary: string; createdAt: string } | null }>;
export type ApproveAgentRequest = (ctx: ServiceContext, id: string, input: ApproveInput, opts: { atHost: boolean }) => Promise<ApproveResult>;
export type DenyAgentRequest = (ctx: ServiceContext, id: string, note: string | null) => Promise<AgentRequestForPerson>;
/** Same-operation enter/change requests only; each is approved on its own and reported on its own. */
export type BatchApprove = (ctx: ServiceContext, ids: string[], opts: { atHost: boolean }) => Promise<ApproveResult[]>;
/** Mark overdue pending requests expired. Returns how many. */
export type ExpireRequests = (ctx: ServiceContext, now?: Date) => Promise<number>;

// ---------------------------------------------------------------------------
// 9. The agent's door (lib/agent/operate.ts; POST /api/agent/actions)
// ---------------------------------------------------------------------------

/**
 * 'asked': a person must approve; `requestId` names the request. 'needs_confirmation': the route
 * raised a warning; resend with the flag in `confirm`. 'proposed' is the older word for 'asked',
 * still answered by requests copied from old proposals.
 */
export type AgentOutcome = 'read' | 'dry_run' | 'posted' | 'done' | 'asked' | 'needs_confirmation' | 'refused';

export interface AgentOperationAnswer {
  operation: string;
  outcome: AgentOutcome;
  summary?: string;
  /** True when this is the stored answer of an earlier request with the same request id. */
  replayed?: boolean;
  result?: unknown;
  file?: StagedFile;
  /** Kept for the curated tools: the ledger part of the preview. */
  ledger?: ChangePreview;
  preview?: OperationPreview;
  warnings?: WarningPreview[];
  effects?: EffectReport[];
  /** The permission request, when the outcome is 'asked'. */
  requestId?: string;
  status?: RequestStatus;
  needs?: ApprovalNeeds;
  /** Why it was refused, or what to do next. */
  note?: string;
  /** The grant it ran under. */
  grantId?: string;
  /** (wave 4) With a "slow down" refusal: how long to wait before asking again. The route answers 429. */
  retryAfterSeconds?: number;
}

export interface RunOperationRequest extends OperationInput {
  operation: string;
  dryRun?: boolean;
  /** Required for anything that changes or asks: asking again with it gives the first answer. */
  requestId?: string;
  /** Required when the answer would be 'asked'. */
  reason?: string;
}

/** Policy, grants, bridge and requests in one place. The only way an agent's operation runs. */
export type Operate = (ctx: ServiceContext, req: RunOperationRequest) => Promise<AgentOperationAnswer>;
/** Run an approved request (called by approveRequest). */
export type RunApproved = (
  approver: ServiceContext,
  request: { id: string; agentId: string; operation: string; input: OperationInput },
  input: ApproveInput,
  opts: { atHost: boolean },
) => Promise<BridgeResult>;

/** How the agent's policy treats an operation right now. */
export type Treatment = 'run' | 'ask' | 'refused';

export interface OperationSummary {
  id: string;
  describe: string;
  class: RiskClass;
  area: Area | null;
  method: string;
  route: string;
  treatment: Treatment;
  /** Why it is refused, or who must approve. */
  why: string | null;
}

export interface OperationDescription extends OperationSummary {
  params: string[];
  /** JSON Schema (draft 2020-12) of the body, or null when the route takes none or parses by hand. */
  bodySchema: unknown;
  querySchema: unknown;
  body: Operation['body'];
  output: Operation['output'];
  dryRun: Operation['dryRun'];
  confirmFlags: string[];
  reveal: Operation['reveal'];
  needsSecret: SecretKind[];
  effects: Operation['effects'];
  /** Notes for the caller ("the amount is taken from the answer"). */
  notes: string[];
  /** (wave 4) Worked examples, each a whole request { params?, query?, body?, confirm?, reveal? } with an optional title or note. */
  examples?: unknown[];
}

export interface MyPermissions {
  agent: { id: string; name: string };
  roles: string[];
  preset: AgentPreset;
  classes: Record<RiskClass, PolicySetting>;
  areas: AgentPolicy['areas'];
  bulkCap: number | null;
  twoPersonOver: string | null;
  requestExpiryDays: number;
  folders: string[];
  paused: boolean;
  grants: AgentGrant[];
  /** Whether a person is signed in at this moment to answer a request. */
  someoneSignedIn: boolean;
}

/**
 * The verbs of POST /api/agent/actions besides the curated `{ action, input, dryRun, requestId }`:
 * the body is `{ verb, ...args }`.
 */
export interface AgentVerbs {
  find_operations: { args: { query?: string; area?: string; class?: string; limit?: number }; answer: { operations: OperationSummary[]; more: boolean } };
  describe_operation: { args: { operation: string }; answer: OperationDescription };
  run_operation: { args: RunOperationRequest; answer: AgentOperationAnswer };
  list_my_requests: { args: { status?: RequestStatus; limit?: number }; answer: { requests: AgentRequestView[] } };
  cancel_request: { args: { requestId: string }; answer: { request: AgentRequestView } };
  get_my_permissions: { args: Record<string, never>; answer: MyPermissions };
  ask_for_permission: {
    args: { operation: string; constraints?: GrantConstraints; minutes?: number; reason: string; requestId: string };
    answer: AgentOperationAnswer;
  };
  upload_file: {
    args: { uploadId?: string; name: string; type: string; chunkBase64: string; last: boolean };
    answer: { uploadId: string; received: number; file: StagedFile | null };
  };
  get_file: { args: { fileId: string }; answer: { file: StagedFile; base64: string } };
  /** Class 'file': asks. Runs the built-in operation "files.save". */
  save_file: { args: { fileId: string; folder: string; name?: string; requestId: string; reason?: string }; answer: AgentOperationAnswer };
}
export type AgentVerb = keyof AgentVerbs;
export const AGENT_VERBS: readonly AgentVerb[] = [
  'find_operations',
  'describe_operation',
  'run_operation',
  'list_my_requests',
  'cancel_request',
  'get_my_permissions',
  'ask_for_permission',
  'upload_file',
  'get_file',
  'save_file',
];
export type HandleVerb = (ctx: ServiceContext, verb: AgentVerb, args: unknown) => Promise<unknown>;

// ---------------------------------------------------------------------------
// 10. Operations that are not API routes (lib/agent/operations/shell.ts), plan §5.5
// ---------------------------------------------------------------------------

/** One question a desktop flow would have asked in a message box; the approver answers it on the card. */
export interface FlowQuestion {
  id: string;
  /** The question as the window words it. */
  text: string;
  kind: 'yes_no' | 'choice' | 'text' | 'path' | 'password';
  choices?: string[];
  /** For 'password': which secret it is. */
  secret?: SecretKind;
}

export interface ShellOperationDef {
  /** "shell.company.switch", "files.save". */
  id: string;
  /** 'electron': carried out by the desktop shell (electron/agentShell.js). 'server': by the server itself. */
  runner: 'electron' | 'server';
  /** The flow's name in the shell (createCompanyFlow …) or the server function's. */
  flow: string;
  class: RiskClass;
  area: Area | null;
  describe: string;
  why: string;
  /** Input fields by name, with what each is. */
  input: Record<string, { type: 'string' | 'number' | 'boolean' | 'path' | 'fileId'; required: boolean; describe: string }>;
  questions: FlowQuestion[];
  needsSecret: SecretKind[];
  hostOnly: boolean;
  fileAdmin: boolean;
  /** Ironbooks restarts (or changes company file): the agent's connection ends and it must ask again. */
  restarts: boolean;
}

/** HMAC ticket the server makes when a person approves a shell operation (lib/agent/shellTicket.ts). */
export interface ShellTicket {
  requestId: string;
  operation: string;
  /** sha256 of the stable JSON of the input. */
  inputHash: string;
  approverId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Hex HMAC-SHA256 over the fields above with the per-launch shell key. */
  mac: string;
}
export const SHELL_TICKET_SECONDS = 120;

// ---------------------------------------------------------------------------
// 11. The HTTP API a person's window uses (never reachable with an agent token: hard floor)
// ---------------------------------------------------------------------------
//
//   GET    /api/agent-requests?status=&agentId=      → { requests: AgentRequestForPerson[] }
//   GET    /api/agent-requests/count                 → AgentRequestCount
//   GET    /api/agent-requests/[id]                  → { request: AgentRequestForPerson }
//   POST   /api/agent-requests/[id]/approve          ApproveInput → ApproveResult
//   POST   /api/agent-requests/[id]/deny             { note?: string } → { request: AgentRequestForPerson }
//   POST   /api/agent-requests/batch-approve         { ids: string[] } → { results: ApproveResult[] }
//   GET    /api/agents                               → { agents: (AgentView & { overrideCount: number })[], allPaused: boolean }   (wave 3)
//   GET    /api/agents/[id]                          → AgentDetail
//   PATCH  /api/agents/[id]                          AgentPolicyInput → AgentDetail
//   POST   /api/agents/[id]/pause                    { paused: boolean } → AgentDetail
//   POST   /api/agents/pause-all                     { paused: boolean } → { paused: boolean }
//   GET    /api/agents/[id]/grants                   → { grants: AgentGrantView[] }
//   DELETE /api/agent-grants/[id]                    → { ok: true }
//   GET    /api/agents/[id]/activity                 → { activity: AgentActivityRow[] }
//
// And for the agent (its token; reads only):
//   GET    /api/agent/requests?status=               → { requests: AgentRequestView[] }
//   GET    /api/agent/requests/[id]?wait=<seconds>   → { request: AgentRequestView }   (long-poll, ≤ WAIT_MAX_SECONDS;
//                                                       429 RATE_LIMITED with Retry-After when the agent already has 4 waits open)
//
// POST /api/agents, PATCH /api/agents/[id] and DELETE /api/agents/[id] are host-only (403 with
// details { hostOnly: true } from a teammate's window). Pause, pause-all, taking back a grant,
// approve and deny work from any signed-in person's window. The list and single-request reads pass
// atHost so a teammate's window shows a host-only request as not approvable.

export interface AgentDetail {
  id: string;
  name: string;
  roleKeys: string[];
  roleNames: string[];
  unattended: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  paused: boolean;
  policy: AgentPolicyView;
  /** Integrated Applications is switched off for the company: every agent is paused. */
  allPaused: boolean;
}

export interface AgentActivityRow {
  at: string;
  /** 'operation': something it ran. 'request': something it asked. */
  kind: 'operation' | 'request';
  operation: string;
  summary: string;
  class: RiskClass | null;
  status: RequestStatus | 'done' | 'refused';
  approvedByName: string | null;
  /** Link target in the audit trail, when there is one. */
  auditId: string | null;
  requestId: string | null;
}

/** What the title bar polls: the badge, and whether to show Pause all agents. */
export interface AgentRequestCount {
  /** Pending requests this person could approve. */
  pending: number;
  /** The newest of them, for the desktop notice (summary only, never the agent's own words). */
  newest: { id: string; agentName: string; summary: string; createdAt: string } | null;
  /** Agents of this company that are not removed. */
  agents: number;
  /** Integrated Applications is switched off: every agent is paused. */
  allPaused: boolean;
  /** This person may pause all agents. */
  canPauseAll: boolean;
}
