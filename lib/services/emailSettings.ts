/**
 * Send Forms set-up inside the app (prefsperms; QB Preferences > Send Forms).
 *
 * The mail server Ironbooks sends forms through lives IN the company file
 * (company_email_settings), edited on Preferences > Send Forms (and the Send Forms page) by anyone
 * with Company & Preferences > Send Forms (email set-up): modify. Before this, SMTP could only be
 * set with environment variables, which a desktop user can't reach; they still work as a fallback
 * when the file has no mail server of its own (a server deployment).
 *
 *  - The password belongs to the computer it was typed on (lib/ai/keyVault.ts sealStoredSecret —
 *    like the AI provider keys): each computer that opens the file types it once; a copy of the
 *    file, a backup or a portable file carries nothing that opens it. In a company file protected
 *    with passwords it is sealed with the file's own vault secret instead (the encrypted file then
 *    keeps it for every computer). It is never returned by the API, and copies for outsiders
 *    (Accountant's Copy, Period Copy) leave it out altogether (portableFile.ts `outsider`).
 *  - "None" (no encryption) is only for a mail server on this computer or the office network /
 *    tailnet when the server signs in: a mailbox password must never cross the internet in plain
 *    text. Saving it for another server is refused; a set-up saved before this rule existed is
 *    refused at send and test time, and the Send Forms page says what to change.
 *  - Each user may send from their own name and address (My Preferences > Send Forms); the
 *    company's address is used otherwise. Replies come back to the sender.
 *  - Test sends a short message through the saved (or the typed, not yet saved) settings and
 *    explains a failure in plain words. The network policy applies to the test like to any send:
 *    a mail server on the internet needs the company's opt-in for email (Privacy & Network).
 */
import dns from 'node:dns';
import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { companyEmailSettings, users } from '@/lib/db/schema';
import { migrateStoredSecrets, needsMoveHere, openStoredSecret, readVaultSecret, sealStoredSecret } from '@/lib/ai/keyVault';
import { assertOutboundAllowed } from '@/lib/net/guard';
import { classifyHost, isPrivateClass, normalizeHost, parseIPv4, parseIPv6 } from '@/lib/net/cidr';
import { canActivity } from '@/lib/permissions/model';
import { effects } from '@/lib/effects';
import { type ServiceContext, ServiceError, inTransaction, validation, writeAudit } from './_base';
import { requireActivity } from './access';
import { assertNotSandbox } from './sandboxState';
import { getMyPreferences } from './preferences';

export const MAIL_SECURITY = ['ssl', 'starttls', 'none'] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];

export const MAIL_SECURITY_LABELS: Record<MailSecurity, string> = {
  ssl: 'SSL/TLS (usually port 465)',
  starttls: 'STARTTLS (usually port 587)',
  none: 'None (a mail relay on your own network, usually port 25)',
};

/** The saved mail password can't be opened on this computer (typed on another one, or another copy). */
export const PASSWORD_NOT_HERE_MESSAGE =
  'The mail server password is kept on the computer where it was typed. To send from this computer, type it once under Preferences > Send Forms and save.';

/** Plain message when no mail server is set up (shown by every email action). */
export const EMAIL_NOT_SET_UP_MESSAGE =
  'Email is not set up yet. An administrator can add the mail server under Preferences > Send Forms, then try again.';

/** What the Send Forms page shows. The password itself is never included. */
export interface EmailSetupView {
  /** Where the settings in use come from. */
  source: 'file' | 'environment' | 'none';
  configured: boolean;
  host: string;
  port: number | null;
  security: MailSecurity;
  username: string;
  hasPassword: boolean;
  /**
   * False when a password is saved but this computer can't open it (it was typed on another
   * computer that opens this file, or the file came from someone else): type it once here.
   */
  passwordReadable: boolean;
  /**
   * True when Connection security is None, the server signs in, and it is not on this computer or
   * your own network: sending is refused until STARTTLS or SSL/TLS is chosen.
   */
  insecureConnection: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  bcc: string;
  useSenderAddress: boolean;
  lastTest: { at: string; ok: boolean; message: string } | null;
  /** Set when this computer's environment variables configure SMTP (server deployments). */
  environment: { host: string; port: number; from: string } | null;
}

export interface EmailSetupInput {
  host: string;
  port: number;
  security: MailSecurity;
  username?: string | null;
  /** A string sets it, null / '' removes it, undefined keeps the saved one. */
  password?: string | null;
  fromName?: string | null;
  fromEmail: string;
  replyTo?: string | null;
  bcc?: string | null;
  useSenderAddress?: boolean;
}

/** A complete, usable mail configuration. */
export interface MailConfig {
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null;
  password: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  bcc: string[];
  useSenderAddress: boolean;
  source: 'file' | 'environment';
}

/**
 * How mail is handed to the server. Tests replace `create` (nodemailer's stream / JSON
 * transports) so nothing leaves the machine.
 */
export const mailTransport = {
  create: (options: Record<string, unknown>) => nodemailer.createTransport(options),
};

/**
 * One email address as it is typed into the app: no spaces, one "@", a dot in the domain, and none
 * of the characters the mailer (nodemailer's address parser, behind lib/services/email.ts sendMail)
 * reads as something other than part of one address: "( )" a comment, '"' a quoted name, "< >" the
 * "Name <address>" form, "[ ]" an address literal, "\" an escape, ":" a group name, and "," or ";"
 * a second address. Mail to a text holding one of them can go somewhere other than where it reads
 * ("a(b)@acme.com" and "acme.com:x@evil.example" both reach another mailbox), so these are refused
 * for a person's entry too.
 */
const EMAIL_RE = /^[^\s@<>()[\]\\:,;"]+@[^\s@<>()[\]\\:,;"]+\.[^\s@<>()[\]\\:,;"]+$/;
/**
 * What an address saved before that rule had to look like. Only for reading what is already saved
 * (the Bcc copy list, a person's own send-from address): a company's mail keeps working exactly as
 * it did until someone saves those settings again.
 */
const SAVED_EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
/** The domain of an address an agent sends to: letters, digits and hyphens, in dot-separated parts. */
const PLAIN_DOMAIN_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
/**
 * The part before the "@" of an address an agent sends to: printable ASCII letters, digits and the
 * punctuation an address may hold unquoted. No control characters or invisible marks (a
 * right-to-left override, a zero-width space): the approval card leaves those out, so the address a
 * person approves would not be the text sent.
 */
const PLAIN_LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const HOST_RE = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9a-fA-F:]+)$/;

function isSecurity(v: unknown): v is MailSecurity {
  return typeof v === 'string' && (MAIL_SECURITY as readonly string[]).includes(v);
}

/** True for one email address as the app takes it from a person (EMAIL_RE). */
export function isEmailAddress(v: string): boolean {
  return EMAIL_RE.test(v);
}

/**
 * True for one plain address, the only kind an agent may send to: an email address (EMAIL_RE)
 * whose domain is letters, digits, dots and hyphens only and whose part before the "@" is
 * printable ASCII (PLAIN_LOCAL_RE). The whole address is then exactly what the approval card shows
 * a person.
 */
export function isPlainAddress(v: string): boolean {
  if (!EMAIL_RE.test(v)) return false;
  const at = v.indexOf('@');
  return PLAIN_LOCAL_RE.test(v.slice(0, at)) && PLAIN_DOMAIN_RE.test(v.slice(at + 1));
}

/** What an agent is told when a recipient is not one plain address. */
export const SEND_JUST_THE_ADDRESS =
  'Send just the email address, like name@example.com, with no name, quotes, brackets or spaces around it, and one address only.';
/** What an agent is told when a recipient list holds something that is not a plain address. */
export const SEND_JUST_THE_ADDRESSES =
  'Send just the email addresses, like name@example.com, separated by commas, with no names, quotes, brackets or spaces around them.';

/**
 * Why `value` cannot be what an email goes to, in plain words, or null when it can. 'one' is a
 * field for a single recipient (no comma or semicolon); 'list' takes several, separated by commas
 * or semicolons. A person's entry must be email addresses (isEmailAddress); an agent's must be plain
 * addresses (isPlainAddress), and its message says to send just the address. The routes refuse
 * this before anything is sent; the agent door refuses it before a person is asked.
 */
export function recipientProblem(ctx: Pick<ServiceContext, 'agent'>, value: string, kind: 'one' | 'list' = 'one'): string | null {
  const v = value.trim();
  const parts = kind === 'list' ? v.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [v];
  const fits = ctx.agent ? isPlainAddress : isEmailAddress;
  const bad = parts.length === 0 ? v : parts.find((a) => !fits(a));
  if (bad === undefined) return null;
  if (ctx.agent) return kind === 'list' ? SEND_JUST_THE_ADDRESSES : SEND_JUST_THE_ADDRESS;
  const shown = bad.length > 60 ? `${bad.slice(0, 60)}…` : bad;
  return kind === 'list'
    ? `"${shown}" is not an email address. Type each address alone, like name@example.com, separated by commas.`
    : `"${shown}" is not one email address. Type just the address, like name@example.com, with no name, quotes or brackets.`;
}

/**
 * Split "a@x.com, b@y.com" into checked addresses (VALIDATION on a bad one). With `ctx` of an agent
 * each must be a plain address (isPlainAddress). `saved`: a value read back from the company file,
 * checked by the rule it was saved under (SAVED_EMAIL_RE).
 */
export function parseAddressList(
  v: string | null | undefined,
  label: string,
  opts: { ctx?: Pick<ServiceContext, 'agent'>; saved?: boolean } = {},
): string[] {
  const list = (v ?? '')
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const a of list) {
    if (opts.saved ? SAVED_EMAIL_RE.test(a) : EMAIL_RE.test(a)) {
      if (!opts.ctx?.agent || isPlainAddress(a)) continue;
      throw validation(`${label}: ${SEND_JUST_THE_ADDRESSES}`);
    }
    throw validation(`${label}: "${a}" is not an email address.`);
  }
  return list;
}

function envConfig(): MailConfig | null {
  const e = process.env;
  if (!(e.SMTP_HOST && e.SMTP_PORT && e.SMTP_USER && e.SMTP_PASS && e.SMTP_FROM)) return null;
  const port = Number(e.SMTP_PORT);
  // SMTP_FROM may be "Name <address>" or just the address.
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(e.SMTP_FROM);
  return {
    host: e.SMTP_HOST,
    port,
    security: port === 465 ? 'ssl' : 'starttls',
    username: e.SMTP_USER,
    password: e.SMTP_PASS,
    fromName: m ? m[1].replace(/^"|"$/g, '') : '',
    fromEmail: m ? m[2].trim() : e.SMTP_FROM.trim(),
    replyTo: null,
    bcc: [],
    useSenderAddress: false,
    source: 'environment',
  };
}

async function storedRow(ctx: ServiceContext) {
  let [row] = await ctx.db.select().from(companyEmailSettings).where(eq(companyEmailSettings.companyId, ctx.companyId));
  // A password that still travels with the company file (or an older version's): moved to this
  // computer's own secret first (lib/ai/keyVault.ts migrateStoredSecrets; no-op when not possible).
  if (row && needsMoveHere(row.passwordEnc) && (await migrateStoredSecrets(ctx.db)) > 0) {
    [row] = await ctx.db.select().from(companyEmailSettings).where(eq(companyEmailSettings.companyId, ctx.companyId));
  }
  return row ?? null;
}

type StoredRow = NonNullable<Awaited<ReturnType<typeof storedRow>>>;

/** The stored row's password in plain text (null when none or unreadable here). */
async function openPassword(ctx: ServiceContext, row: StoredRow | null): Promise<string | null> {
  if (!row?.passwordEnc) return null;
  return openStoredSecret(row.passwordEnc, ctx.companyId, await readVaultSecret(ctx.db));
}

function rowComplete(row: StoredRow | null): row is StoredRow & { host: string; port: number; fromEmail: string } {
  return Boolean(row?.host && row.port && row.fromEmail);
}

/**
 * The configuration sends use: the company file's own mail server when it has one, else this
 * computer's SMTP environment variables, else null (not set up).
 */
export async function resolveMailConfig(ctx: ServiceContext): Promise<MailConfig | null> {
  const row = await storedRow(ctx);
  if (rowComplete(row)) {
    const password = await openPassword(ctx, row);
    if (row.passwordEnc && password === null) {
      throw new ServiceError('VALIDATION', PASSWORD_NOT_HERE_MESSAGE);
    }
    return {
      host: row.host,
      port: row.port,
      security: isSecurity(row.security) ? row.security : 'starttls',
      username: row.username || null,
      password,
      fromName: row.fromName ?? '',
      fromEmail: row.fromEmail,
      replyTo: row.replyTo || null,
      // As saved: a list saved before the stricter address rule keeps sending as it did.
      bcc: parseAddressList(row.bcc, 'Bcc', { saved: true }),
      useSenderAddress: row.useSenderAddress,
      source: 'file',
    };
  }
  return envConfig();
}

/** Is any mail server available for this company (file settings or environment)? */
export async function isEmailConfigured(ctx: ServiceContext): Promise<boolean> {
  const row = await storedRow(ctx);
  if (rowComplete(row)) return !row.passwordEnc || (await openPassword(ctx, row)) !== null;
  return envConfig() !== null;
}

function view(row: StoredRow | null, passwordReadable: boolean, insecureConnection = false): EmailSetupView {
  const env = envConfig();
  const fileReady = rowComplete(row) && (!row.passwordEnc || passwordReadable);
  return {
    source: rowComplete(row) ? 'file' : env ? 'environment' : 'none',
    configured: fileReady || (!rowComplete(row) && env !== null),
    host: row?.host ?? '',
    port: row?.port ?? null,
    security: isSecurity(row?.security) ? row!.security as MailSecurity : 'starttls',
    username: row?.username ?? '',
    hasPassword: Boolean(row?.passwordEnc),
    passwordReadable: row?.passwordEnc ? passwordReadable : true,
    insecureConnection,
    fromName: row?.fromName ?? '',
    fromEmail: row?.fromEmail ?? '',
    replyTo: row?.replyTo ?? '',
    bcc: row?.bcc ?? '',
    useSenderAddress: row?.useSenderAddress ?? true,
    lastTest:
      row?.lastTestAt && row.lastTestOk !== null
        ? { at: row.lastTestAt.toISOString(), ok: Boolean(row.lastTestOk), message: row.lastTestMessage ?? '' }
        : null,
    environment: env ? { host: env.host, port: env.port, from: env.fromEmail } : null,
  };
}

/** What any member may know about email here (GET /api/email/status): nothing secret. */
export interface EmailStatus {
  configured: boolean;
  source: 'file' | 'environment' | 'none';
  /** The company's sender address ('' when not set up). */
  fromEmail: string;
  /** Members may send from their own address (My Preferences > Send Forms). */
  useSenderAddress: boolean;
}

export async function getEmailStatus(ctx: ServiceContext): Promise<EmailStatus> {
  const row = await storedRow(ctx);
  const v = view(row, (await openPassword(ctx, row)) !== null);
  return {
    configured: v.configured,
    source: v.source,
    fromEmail: v.source === 'file' ? v.fromEmail : v.environment?.from ?? '',
    useSenderAddress: v.source === 'file' ? v.useSenderAddress : false,
  };
}

/** The Send Forms set-up (never the password). Needs Send Forms (email set-up): view. */
export async function getEmailSetup(ctx: ServiceContext): Promise<EmailSetupView> {
  requireActivity(ctx, 'company.send_forms', 'view');
  const row = await storedRow(ctx);
  return view(row, (await openPassword(ctx, row)) !== null, await savedConnectionInsecure(row));
}

function cleanInput(ctx: Pick<ServiceContext, 'agent'>, input: EmailSetupInput) {
  const host = String(input.host ?? '').trim();
  if (!host) throw validation('Enter the mail server name, for example smtp.office365.com.');
  if (host.length > 255 || !HOST_RE.test(host) || /^[a-z]+:\/\//i.test(host)) {
    throw validation('The mail server must be a server name or address only, like smtp.gmail.com (no "smtp://", no spaces).');
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw validation('The port must be a whole number from 1 to 65535.');
  if (!isSecurity(input.security)) throw validation('Pick the connection security: SSL/TLS, STARTTLS or None.');
  const fromEmail = String(input.fromEmail ?? '').trim();
  if (!EMAIL_RE.test(fromEmail)) throw validation('Enter the email address forms are sent from.');
  if (ctx.agent && !isPlainAddress(fromEmail)) throw validation(`The address forms are sent from: ${SEND_JUST_THE_ADDRESS}`);
  const replyTo = String(input.replyTo ?? '').trim();
  if (replyTo && !EMAIL_RE.test(replyTo)) throw validation('The reply-to address is not an email address.');
  if (replyTo && ctx.agent && !isPlainAddress(replyTo)) throw validation(`The reply-to address: ${SEND_JUST_THE_ADDRESS}`);
  const bcc = parseAddressList(input.bcc, 'Always send a copy to', { ctx }).join(', ');
  if (bcc.length > 500) throw validation('Too many copy addresses.');
  const username = String(input.username ?? '').trim();
  if (username.length > 255) throw validation('The user name is too long.');
  const fromName = String(input.fromName ?? '').trim();
  if (fromName.length > 255) throw validation('The sender name is too long.');
  if (typeof input.password === 'string' && input.password.length > 500) throw validation('The password is too long.');
  return {
    host,
    port,
    security: input.security,
    username: username || null,
    fromName: fromName || null,
    fromEmail,
    replyTo: replyTo || null,
    bcc: bcc || null,
    useSenderAddress: input.useSenderAddress !== false,
  };
}

/** The part of a mail server set-up the saved password belongs to. */
type ServerIdentity = { host: string | null; port: number | null; security: string; username: string | null };

/**
 * True when `b` is the same mail server and sign-in as `a` (host letter case aside). The saved
 * password is only ever reused for exactly that: a changed host, port, security or user name could
 * otherwise carry it to a server someone else controls (prefsperms review P1).
 */
export function sameMailServer(a: ServerIdentity, b: ServerIdentity): boolean {
  return (
    a.host !== null &&
    b.host !== null &&
    a.host.trim().toLowerCase() === b.host.trim().toLowerCase() &&
    a.port === b.port &&
    a.security === b.security &&
    (a.username ?? null) === (b.username ?? null)
  );
}

/** QuickBooks-style: the password must be typed again for a different server or sign-in. */
export const RETYPE_PASSWORD_MESSAGE =
  'Type the mail server password again: the server, port, security or user name changed, and the saved password is only used for the server it was saved for.';

/**
 * Save the company file's mail server. Needs Send Forms (email set-up): modify. The password is
 * sealed with the file's vault secret; the audit row says only whether it changed. Saving a
 * different server, port, security or user name without typing the password is refused (the
 * saved one is never carried over); with no user name (a relay without sign-in) it is dropped.
 */
export async function saveEmailSetup(ctx: ServiceContext, input: EmailSetupInput): Promise<EmailSetupView> {
  requireActivity(ctx, 'company.send_forms', 'modify');
  const clean = cleanInput(ctx, input);
  // Before anything is written: never a mailbox password over the internet without encryption.
  await assertPlainMailAllowed(clean, 'save');
  return inTransaction(ctx, async (tx) => {
    const before = await storedRow(tx);
    let passwordEnc = before?.passwordEnc ?? null;
    let passwordChange: 'kept' | 'set' | 'removed' = 'kept';
    if (typeof input.password === 'string' && input.password !== '') {
      // Sealed for this computer. The password it replaces (for this very server and sign-in only)
      // decides whether other computers' copies are kept or dropped (lib/ai/keyVault.ts).
      const replaced = before?.passwordEnc && sameMailServer(before, clean) ? before.passwordEnc : null;
      passwordEnc = await sealStoredSecret(tx.db, input.password, tx.companyId, { entered: replaced });
      passwordChange = 'set';
    } else if (input.password === null || input.password === '') {
      passwordEnc = null;
      passwordChange = before?.passwordEnc ? 'removed' : 'kept';
    } else if (before?.passwordEnc && !sameMailServer(before, clean)) {
      if (clean.username) throw validation(RETYPE_PASSWORD_MESSAGE);
      // No sign-in any more: nothing to send the password with; don't keep it for the new server.
      passwordEnc = null;
      passwordChange = 'removed';
    }
    // A changed server or login makes the last test result meaningless.
    const serverChanged =
      !before ||
      before.host !== clean.host ||
      before.port !== clean.port ||
      before.security !== clean.security ||
      (before.username ?? null) !== clean.username ||
      passwordChange !== 'kept';
    const values = {
      ...clean,
      passwordEnc,
      updatedBy: tx.userId ?? null,
      updatedAt: new Date(),
      ...(serverChanged ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}),
    };
    const [row] = before
      ? await tx.db.update(companyEmailSettings).set(values).where(eq(companyEmailSettings.id, before.id)).returning()
      : await tx.db.insert(companyEmailSettings).values({ companyId: tx.companyId, ...values }).returning();
    const publicOf = (r: StoredRow | null) =>
      r
        ? {
            host: r.host,
            port: r.port,
            security: r.security,
            username: r.username,
            fromName: r.fromName,
            fromEmail: r.fromEmail,
            replyTo: r.replyTo,
            bcc: r.bcc,
            useSenderAddress: r.useSenderAddress,
            hasPassword: Boolean(r.passwordEnc),
          }
        : null;
    await writeAudit(tx, {
      action: before ? 'update' : 'create',
      entityType: 'email_settings',
      entityId: row.id,
      oldValues: publicOf(before),
      newValues: { ...publicOf(row), ...(passwordChange !== 'kept' ? { password: passwordChange } : {}) },
    });
    return view(row, (await openPassword(tx, row)) !== null, await savedConnectionInsecure(row));
  });
}

/** Remove the file's mail server (sends fall back to the environment, or are off). */
export async function removeEmailSetup(ctx: ServiceContext): Promise<EmailSetupView> {
  requireActivity(ctx, 'company.send_forms', 'modify');
  return inTransaction(ctx, async (tx) => {
    const before = await storedRow(tx);
    if (before) {
      await tx.db.delete(companyEmailSettings).where(eq(companyEmailSettings.id, before.id));
      await writeAudit(tx, {
        action: 'delete',
        entityType: 'email_settings',
        entityId: before.id,
        oldValues: { host: before.host, fromEmail: before.fromEmail },
      });
    }
    return view(null, true);
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Bracket a bare IPv6 literal so the host can be embedded in a URL for the policy check. */
function hostForUrl(host: string): string {
  const h = host.trim();
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

/** nodemailer options for a configuration. */
export function transportOptions(cfg: MailConfig): Record<string, unknown> {
  return {
    host: cfg.host.replace(/^\[|\]$/g, ''),
    port: cfg.port,
    secure: cfg.security === 'ssl',
    requireTLS: cfg.security === 'starttls',
    ...(cfg.username ? { auth: { user: cfg.username, pass: cfg.password ?? '' } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

/**
 * Network policy: a LAN / tailnet relay is fine; a public mail provider needs the email opt-in.
 * And a server that signs in with Connection security None must be on this computer or your own
 * network (assertPlainMailAllowed). Every send and test goes through here.
 */
export async function assertMailServerAllowed(ctx: ServiceContext, cfg: Pick<MailConfig, 'host' | 'port' | 'security' | 'username'>) {
  await assertOutboundAllowed(`${cfg.security === 'ssl' ? 'smtps' : 'smtp'}://${hostForUrl(cfg.host)}:${cfg.port}`, 'email', ctx);
  await assertPlainMailAllowed(cfg, 'send');
}

// ---------------------------------------------------------------------------
// Connection security "None"
// ---------------------------------------------------------------------------

/** Name lookups for the "None" check (tests replace `lookup`). Addresses only. */
export const mailDns = {
  lookup: async (host: string): Promise<string[]> => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address),
};

const MAIL_DNS_TIMEOUT_MS = 3000;

/**
 * True when `host` is this computer or on your own network (LAN / tailnet) — the only places a
 * mail server may be reached without encryption. An address is classified as it is
 * (lib/net/cidr.ts). A name ("relay.office.local", "SERVER01") counts when every address it
 * resolves to here is private; a name that can't be resolved does not.
 */
export async function mailServerIsLocal(host: string): Promise<boolean> {
  const cls = classifyHost(host);
  if (isPrivateClass(cls)) return true;
  if (cls !== 'public') return false;
  const h = normalizeHost(host);
  if (parseIPv4(h) !== null || parseIPv6(h) !== null) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addrs = await Promise.race([
      mailDns.lookup(h),
      new Promise<string[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), MAIL_DNS_TIMEOUT_MS);
      }),
    ]);
    return addrs.length > 0 && addrs.every((a) => isPrivateClass(classifyHost(a)));
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A set-up that would send a sign-in without encryption to a server outside your own network. */
async function plainSignInOutside(cfg: { host: string; security: string; username?: string | null }): Promise<boolean> {
  return cfg.security === 'none' && Boolean(cfg.username) && !(await mailServerIsLocal(cfg.host));
}

/** Refuse Connection security None for a server that signs in and is not on your own network. */
export async function assertPlainMailAllowed(
  cfg: { host: string; security: string; username?: string | null },
  when: 'save' | 'send',
): Promise<void> {
  if (!(await plainSignInOutside(cfg))) return;
  throw new ServiceError(
    'VALIDATION',
    when === 'save'
      ? `Connection security "None" sends the mailbox password without encryption, so Ironbooks only allows it for a mail server on this computer or your own network, and ${cfg.host} is not one. Choose STARTTLS or SSL/TLS.`
      : `Email was not sent: the mail server ${cfg.host} is set up with Connection security "None", which would send the mailbox password over the internet without encryption. Change Connection security to STARTTLS or SSL/TLS under Preferences > Send Forms.`,
    { insecureConnection: true },
  );
}

/** The saved set-up is one sends now refuse (shown on the Send Forms page). */
async function savedConnectionInsecure(row: StoredRow | null): Promise<boolean> {
  return rowComplete(row) ? plainSignInOutside({ host: row.host, security: row.security, username: row.username }) : false;
}

export interface SenderIdentity {
  from: { name: string; address: string };
  replyTo: string | null;
  bcc: string[];
  /** For {{sender.name}} / {{sender.email}} in the email templates. */
  senderName: string;
  senderEmail: string;
  /** The signed-in person's own address (their Send Forms address, else their sign-in email). */
  userEmail: string | null;
}

/** The signed-in person's Send Forms preferences, name and sign-in email (blank for system jobs). */
async function senderPrefs(ctx: ServiceContext) {
  let my: { sendFromName: string; sendFromEmail: string; bccMe: boolean } | null = null;
  let userName = '';
  let loginEmail = '';
  if (ctx.userId) {
    try {
      my = await getMyPreferences(ctx);
    } catch {
      my = null;
    }
    const [u] = await ctx.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, ctx.userId));
    userName = u?.name ?? '';
    loginEmail = u?.email && SAVED_EMAIL_RE.test(u.email) ? u.email : '';
  }
  const ownEmail = my?.sendFromEmail && SAVED_EMAIL_RE.test(my.sendFromEmail) ? my.sendFromEmail : '';
  const ownName = my?.sendFromName?.trim() || userName;
  return { ownEmail, ownName, loginEmail, bccMe: Boolean(my?.bccMe) };
}

/**
 * Who an email from this user comes from: their own name and address (My Preferences > Send
 * Forms) when the company allows it, else the company's sender with replies to the user.
 */
export async function senderFor(ctx: ServiceContext, cfg: MailConfig): Promise<SenderIdentity> {
  const { ownEmail, ownName, loginEmail, bccMe } = await senderPrefs(ctx);
  const useOwn = cfg.useSenderAddress && Boolean(ownEmail);
  const from = useOwn ? { name: ownName, address: ownEmail } : { name: cfg.fromName, address: cfg.fromEmail };
  const replyTo = useOwn ? null : ownEmail || cfg.replyTo;
  const bcc = [...cfg.bcc];
  if (bccMe) {
    const me = ownEmail || loginEmail || cfg.fromEmail;
    if (me && !bcc.includes(me)) bcc.push(me);
  }
  return {
    from,
    replyTo,
    bcc,
    senderName: useOwn ? ownName : cfg.fromName || ownName,
    senderEmail: from.address,
    userEmail: ownEmail || loginEmail || null,
  };
}

/**
 * {{sender.name}} / {{sender.email}} for the email templates. Never throws: without a usable mail
 * server it falls back to the person's own name and address (the send itself then explains).
 */
export async function senderMergeFields(ctx: ServiceContext): Promise<Record<'sender.name' | 'sender.email', string>> {
  let cfg: MailConfig | null = null;
  try {
    cfg = await resolveMailConfig(ctx);
  } catch {
    cfg = null;
  }
  if (cfg) {
    const s = await senderFor(ctx, cfg);
    return { 'sender.name': s.senderName, 'sender.email': s.senderEmail };
  }
  const { ownEmail, ownName, loginEmail } = await senderPrefs(ctx);
  return { 'sender.name': ownName, 'sender.email': ownEmail || loginEmail };
}

/** Plain words for a mail server failure (nodemailer error codes / SMTP replies). */
export function explainMailError(err: unknown, cfg: Pick<MailConfig, 'host' | 'port' | 'fromEmail'>): string {
  if (err instanceof ServiceError) return err.message;
  const e = (err ?? {}) as { code?: string; responseCode?: number; message?: string; command?: string };
  const msg = String(e.message ?? '');
  const where = `${cfg.host} on port ${cfg.port}`;
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534) {
    return 'The mail server refused the user name or password. Check them (some providers, like Gmail and Outlook, need an "app password").';
  }
  if (e.code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(msg)) return `No mail server named ${cfg.host} was found. Check the server name.`;
  if (/ECONNREFUSED/.test(msg) || e.code === 'ECONNECTION') return `Could not connect to ${where}. Check the server name and the port.`;
  if (e.code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) return `The mail server ${where} did not answer in time. Check the server name, the port and your internet connection.`;
  if (/wrong version number|ssl3_get_record|certificate|self.signed|TLS|tls/i.test(msg) || e.code === 'ESOCKET') {
    return `The secure connection to ${where} failed. Try SSL/TLS with port 465, or STARTTLS with port 587.`;
  }
  if (e.code === 'EENVELOPE' || e.responseCode === 550 || e.responseCode === 553 || e.responseCode === 554) {
    return `The mail server would not send this email from ${cfg.fromEmail}: ${msg.replace(/^.*?:\s*/, '') || 'sender refused'}. Use an address your mail account owns.`;
  }
  return `The email could not be sent: ${msg || 'unknown error'}.`;
}

export interface TestEmailResult {
  ok: boolean;
  message: string;
  to: string;
  from: string;
  /**
   * True only when the test email was handed to the mail server now. False when it failed, and in
   * an agent's work, where the effects outbox only records it (a preview) or sends it once the
   * work is saved; `message` then says it WOULD be sent, or WILL be.
   */
  sent: boolean;
}

/**
 * Send a test email (Preferences > Send Forms > Test). With `draft` (typed, not yet saved
 * settings) it needs Send Forms (email set-up): modify and tests those; the saved password is used
 * when none is typed ONLY for the very server and sign-in it was saved for (otherwise the password
 * must be typed: a draft must never send the company's password to another server). Without a
 * draft the saved settings are tested and the result is remembered. Someone without the set-up
 * right can test the saved settings, sent only to the address they sign in with.
 *
 * The email goes through the effects outbox (lib/effects.ts) like every other email
 * (lib/services/email.ts sendMail): a person's test is sent at once, exactly as before. In an
 * agent's preview it is only recorded, and the answer says the test WOULD be sent; in an agent's
 * real run it is sent once the work is saved, and the answer says it WILL be. Neither is
 * remembered as the last test's result: no test has happened yet. The checks before the send
 * (network policy, encryption) run in every case, so a preview fails where the test would.
 */
export async function sendTestEmail(
  ctx: ServiceContext,
  input: { to?: string | null; draft?: EmailSetupInput | null } = {},
): Promise<TestEmailResult> {
  assertNotSandbox('Email');
  const canSetUp = !ctx.access || canActivity(ctx.access, 'company.send_forms', 'modify');
  let cfg: MailConfig | null;
  if (input.draft) {
    requireActivity(ctx, 'company.send_forms', 'modify');
    const clean = cleanInput(ctx, input.draft);
    const saved = await storedRow(ctx);
    const typed = typeof input.draft.password === 'string' && input.draft.password !== '' ? input.draft.password : null;
    let password: string | null = null;
    if (typed) password = typed;
    else if (input.draft.password !== null && clean.username && saved?.passwordEnc) {
      if (!sameMailServer(saved, clean)) throw validation(RETYPE_PASSWORD_MESSAGE);
      password = await openPassword(ctx, saved);
    }
    cfg = {
      ...clean,
      fromName: clean.fromName ?? '',
      replyTo: clean.replyTo,
      bcc: parseAddressList(clean.bcc, 'Bcc'),
      password,
      source: 'file',
    };
  } else {
    cfg = await resolveMailConfig(ctx);
  }
  if (!cfg) throw new ServiceError('VALIDATION', EMAIL_NOT_SET_UP_MESSAGE);

  const sender = await senderFor(ctx, cfg);
  let to = String(input.to ?? '').trim();
  if (!canSetUp) {
    // Only to yourself: the test must not become a way to send mail to anyone. Your own "send
    // from" address (My Preferences) is free text nobody checked, so it is the sign-in address.
    to = (await senderPrefs(ctx)).loginEmail;
    if (!to) {
      throw validation('The test is sent to the email address you sign in with, and yours is not an email address. Ask an administrator to test the mail server.');
    }
  }
  if (!to) to = sender.userEmail || sender.from.address;
  if (!EMAIL_RE.test(to)) throw validation('Enter the address to send the test email to.');
  if (ctx.agent && !isPlainAddress(to)) throw validation(SEND_JUST_THE_ADDRESS);

  const server: MailConfig = cfg;
  const from = sender.from.address;
  let result: TestEmailResult;
  try {
    await assertMailServerAllowed(ctx, server);
    const options = transportOptions(server);
    const out = await effects.email(
      {
        from: sender.from.name ? { name: sender.from.name, address: sender.from.address } : sender.from.address,
        to,
        ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
        subject: 'Ironbooks test email',
        text: [
          'This is a test email from Ironbooks.',
          '',
          `It was sent through ${server.host} (port ${server.port}) from ${from}.`,
          'If you can read it, your customers will receive the forms you email.',
        ].join('\n'),
      },
      async (message) => {
        const transport = mailTransport.create(options);
        try {
          return await transport.sendMail(message);
        } catch (err) {
          // Plain words also when an agent's queued test fails after its work was saved.
          throw new ServiceError('VALIDATION', explainMailError(err, { host: server.host, port: server.port, fromEmail: from }));
        }
      },
    );
    const message = out.sent
      ? `Test email sent to ${to}. Check that it arrived (and is not in the spam folder).`
      : out.status === 'previewed'
        ? `A test email would be sent to ${to} through ${server.host} (port ${server.port}). Nothing is sent in a preview.`
        : `A test email will be sent to ${to} through ${server.host} (port ${server.port}) once this work is saved. Then check that it arrived (and is not in the spam folder).`;
    result = { ok: true, message, to, from, sent: out.sent };
  } catch (err) {
    result = { ok: false, message: explainMailError(err, { host: server.host, port: server.port, fromEmail: from }), to, from, sent: false };
  }
  // A test only recorded or queued has not happened: the last result stays as it was.
  if (!input.draft && server.source === 'file' && (result.sent || !result.ok)) {
    await ctx.db
      .update(companyEmailSettings)
      .set({ lastTestAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message })
      .where(eq(companyEmailSettings.companyId, ctx.companyId));
  }
  return result;
}
