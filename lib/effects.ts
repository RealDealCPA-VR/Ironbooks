/**
 * The effects outbox (agent full access, plan section 5.4): everything an operation does that
 * leaves the database goes through here. An email, a file saved to disk, a print job, a call to
 * another computer. An agent's work can then be previewed and committed safely: those things must
 * not happen inside a transaction that may still roll back, and a preview must SHOW them.
 *
 * Three ways it runs:
 *  - No scope: every request a person makes in the window, every schedule, every test that does
 *    not open one. Each effect happens at once, exactly as before this module existed: the same
 *    send, the same errors, the same answer.
 *  - runWithEffects('capture', fn): a dry run. Nothing happens. Every effect is recorded so the
 *    preview can say who an email goes to, its subject and attachments, which file is saved where,
 *    which printer. A call to another computer is not made at all: effects.network throws
 *    EffectNotRunInPreview, because the operation cannot carry on without the answer.
 *  - runWithEffects('defer', fn): a real run inside a database transaction. Effects are queued and
 *    happen only when the caller calls release() AFTER the transaction committed. If fn throws (the
 *    transaction rolled back) nothing is released, ever: no email about books that were not saved.
 *    A call to another computer is the one exception. The operation needs its answer to go on, so
 *    it is made at once (the run was approved) and recorded for the audit trail.
 *
 * When fn throws, runWithEffects throws the same error and nothing is released. What fn asked for
 * before it threw stays readable through effectsOfFailedRun(err): a dry run stopped by
 * EffectNotRunInPreview still shows the emails asked for before the stop, and a failed real run
 * still lists the calls to other computers that DID happen (the statement already went to the AI
 * provider), so the audit trail can say so. Only an error that is an object can carry this; a
 * thrown string cannot.
 *
 * In memory only. The queue lives in this process until release(); it is not written anywhere.
 * If the app stops between the commit and release() (a crash, a power cut), the books are saved
 * but the queued emails are never sent, the files never written, the pages never printed. Nothing
 * retries them later. The caller records what release() reported in the audit trail, so an effect
 * with no "sent" line there is one that did not happen, and a person can do it again by hand. A
 * lasting outbox (a table retried at start-up) was not built on purpose: an email to a customer
 * that goes out hours late, after the person has moved on, surprises more than one that is missing.
 *
 * What the queue holds. A queued email carries its attachments and the way to reach the company's
 * mail server, the password included. AsyncLocalStorage keeps a scope alive for as long as any
 * timer or promise started inside it lives, so when fn finishes the queue moves out of the scope
 * into the run object, and release() or discard() drops it. A caller that does neither keeps it for
 * as long as it keeps the run object.
 *
 * The scope follows the async work started inside it (AsyncLocalStorage). Code that starts a
 * long-lived timer while handling a request (the backup scheduler or autosave, started by the
 * first request that needs them) must start it in outsideEffects() or at start-up. Otherwise the
 * timer belongs to the agent's scope: while that is open, the timer's effects are captured or
 * queued into the agent's run, and once it has closed they are refused.
 *
 * Email. effects.email(message, send) takes the message and the function that hands it to the
 * mail server; this module knows nothing of the company's mail settings. Services do not call it:
 * they call sendMail(opts, ctx) in lib/services/email.ts, which builds the message from the
 * company's settings and calls this. Where the plan writes effects.email({ to, cc, subject, ... }),
 * read sendMail. The test email (sendTestEmail in lib/services/emailSettings.ts) comes through here
 * too.
 *
 * A preview shows what is really sent. Recipients are read with nodemailer's own address parser.
 * Inside a scope an email is refused when nodemailer would deliver it to anyone but its To, Cc and
 * Bcc (its own delivery list, a finished raw message, recipients named in extra headers), when part
 * of it would be read from a file or a web address only as it goes out, and when its preview cannot
 * be built. Summaries are one line, without invisible formatting characters (a right-to-left mark
 * can make "Invoice[U+202E]fdp.exe" read as "Invoiceexe.pdf"), and cut to a sensible length; the
 * full values stay in the detail.
 *
 * Folders. effects.writeFile does not know who asks, so it does not check which folders an agent
 * may save in: the bridge checks every file the work asked for against the folders the Admin
 * allows, inside the collection, before anything is committed (plan 5.5). This module only refuses
 * names that would be saved under another name, or not at all, so the file saved is the file
 * previewed.
 *
 * A check made during the work is only as good as the folder still being that folder when the file
 * is written, after the commit. So the caller pins a queued file to the real folder it approved
 * (pinFile: links resolved, inside an allowed folder). At release a pinned file is written into
 * exactly that folder, never through the path the work named, and only after looking again: the
 * part of the folder that exists must still resolve to itself before anything is made in it, and
 * the whole folder again once it is made. A link or junction made inside an allowed folder while
 * the work was committing, pointing somewhere else, fails that look, and the file is not saved
 * (reported as failed), nor any folder made where the link leads. The temporary file the save
 * writes first is created new, never opened through something already there.
 *
 * A caller that checks the folders itself opens its scope with { pinFiles: true } (the bridge
 * does). In such a scope writeFile does not look at the disk at all: the folder the work named may
 * be on someone's network share, and merely looking at it there offers that share the person's
 * Windows sign-in. pinFile looks, once the caller knows the folder is one it allows (whether a file
 * is replaced, whether a folder is in the way). And release writes only pinned files: a file the
 * caller never pinned (asked for while its check was already running, say) is reported as failed
 * and never written.
 *
 * Pure Node: no database or Next imports, so the bridge, the services and the tests can all use it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import addressparser from 'nodemailer/lib/addressparser';
import type Mail from 'nodemailer/lib/mailer';
import type { EffectPreview } from '@/lib/agent/operations/types';
import { ServiceError } from '@/lib/services/errors';

export type EffectsMode = 'capture' | 'defer';

/** What an effect call did: happened now, only recorded (dry run), or waiting for release(). */
export type EffectStatus = 'done' | 'previewed' | 'queued';

/** How one effect went when it was released (a call to another computer: when it ran). */
export interface EffectReport {
  effect: EffectPreview;
  /** 'sent': it happened (handed to the mail server, the file saved, the job sent to the printer). */
  status: 'sent' | 'failed';
  /** What went wrong, in the words it was raised with. Null when it was sent. */
  error: string | null;
  /** True for a call to another computer: it ran during the operation, not at release. */
  ranDuringOperation: boolean;
}

/** What runWithEffects resolves to once fn has finished without throwing. */
export interface EffectsRun<T> {
  mode: EffectsMode;
  value: T;
  /** Every effect fn asked for, in order. */
  effects: EffectPreview[];
  /**
   * Run the queued effects in order and say how each went. A failure does not stop the rest (each
   * is its own email or file). A call to another computer is reported as it went when it ran, or
   * as failed with STILL_RUNNING when fn did not wait for it. Only the first call does anything;
   * later calls resolve to []. Nothing is queued in 'capture' mode, so there it resolves to [].
   */
  release(): Promise<EffectReport[]>;
  /** Drop the queue without running anything (the caller decided not to commit after all). */
  discard(): void;
}

/** What a run that threw had asked for (effectsOfFailedRun). */
export interface FailedRunEffects {
  mode: EffectsMode;
  /** Every effect fn asked for before it threw, in order. None happened, except those in `ran`. */
  effects: EffectPreview[];
  /** Calls to another computer made during a real run before it failed: these DID happen. */
  ran: EffectReport[];
}

/** A message as nodemailer takes it. effects.email passes it on unchanged. */
export type EmailMessage = Mail.Options;

/** Hands one message to the mail server and returns the server's answer. */
export type EmailSender = (message: EmailMessage) => Promise<unknown>;

export interface EmailResult {
  /** True only when the message was handed to the mail server now. */
  sent: boolean;
  status: EffectStatus;
  /** The mail server's answer (nodemailer's info) when sent now; null otherwise. */
  info: unknown;
  effect: EffectPreview;
}

export interface FileToWrite {
  /** The folder. Created when it does not exist yet. */
  dir: string;
  /** A plain file name, never a path: the folder is given separately so a preview shows both. */
  name: string;
  /** The content. Text is saved as UTF-8. */
  bytes: Uint8Array | string;
}

export interface WriteFileResult {
  /** True only when the file was saved now. */
  written: boolean;
  status: EffectStatus;
  /** The full path the file is (or would be) saved at. */
  path: string;
  size: number;
  /** True when a file of that name was already there (when asked) and saving replaces it. */
  replaces: boolean;
  effect: EffectPreview;
}

export interface PrintJob {
  /** The file to print (a staged output file id). */
  fileId: string;
  /** The printer's name; null or absent for the default printer. */
  printer?: string | null;
  /** Default 1. */
  copies?: number;
  /** The file's name, for the summary ("Print Check 1042.pdf ..."). */
  name?: string | null;
}

/** Does the printing. The desktop shell registers one; the server alone cannot print. */
export type PrintHandler = (job: { fileId: string; printer: string | null; copies: number; name: string | null }) => Promise<void>;

export interface PrintResult {
  /** True only when the job was handed to the printer now. */
  printed: boolean;
  status: EffectStatus;
  effect: EffectPreview;
}

export interface NetworkCall {
  /** What the call is for, in plain words: "reading the bank statement". */
  purpose: string;
  /** The computer it contacts: "api.openai.com". */
  host: string;
}

/** The release report's words when no print handler is registered. */
export const PRINTING_NOT_AVAILABLE = 'Printing is not available here.';

/** The report's words for a call to another computer that had not finished when the work did. */
export const STILL_RUNNING = 'Whether it worked is not known: it was still running when the work finished.';

/** Most copies one print job may ask for. A person printing more prints again. */
export const MAX_PRINT_COPIES = 100;

// ---------------------------------------------------------------------------
// Plain words for summaries
// ---------------------------------------------------------------------------

/** Invisible formatting characters (direction marks, zero-width characters) and broken pairs. */
const INVISIBLE = /[\p{Cf}\p{Cs}]/gu;
/** Line breaks, tabs, other control characters and runs of spaces. */
const BREAKS = /[\p{Cc}\s]+/gu;

/**
 * One line of plain text for a summary: no line breaks, no invisible formatting characters, at
 * most `max` characters. 'middle' keeps both ends (a folder's last part, a file's extension, an
 * address's domain); 'end' keeps the start (a subject). The full value stays in the detail.
 */
function oneLine(value: string, max: number, cut: 'end' | 'middle' = 'end'): string {
  const s = value.replace(INVISIBLE, '').replace(BREAKS, ' ').trim();
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  if (cut === 'middle') {
    const head = Math.ceil((max - 1) / 2);
    const tail = max - 1 - head;
    return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
  }
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** "84 KB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')} MB`;
}

/** "a", "a and b", "a and 3 others". */
function nameList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items[0]} and ${items.length - 1} others`;
}

/**
 * A dry run reached a call to another computer. The call was not made, so the operation cannot
 * go on. The bridge turns this into "this would contact {host} for {purpose}".
 *
 * A ServiceError so a route handler that catches it still answers with this message instead of
 * "Internal server error". The effect is also recorded in the scope, so the bridge knows even
 * when a service caught this error and carried on another way.
 */
export class EffectNotRunInPreview extends ServiceError {
  readonly effect: EffectPreview;

  constructor(effect: EffectPreview) {
    const host = oneLine(String(effect.detail.host ?? '') || 'another computer', 80, 'middle');
    const purpose = oneLine(String(effect.detail.purpose ?? '') || 'this work', 120);
    super(
      'VALIDATION',
      `This would contact ${host} for ${purpose}. A preview does not contact other computers, so it stopped here.`,
      { notRunInPreview: true, effect },
    );
    this.name = 'EffectNotRunInPreview';
    this.effect = effect;
  }
}

// ---------------------------------------------------------------------------
// The scope
// ---------------------------------------------------------------------------

interface Entry {
  preview: EffectPreview;
  /** Makes it happen at release ('defer'). Null when it was only recorded, or already ran. */
  run: (() => Promise<unknown>) | null;
  /** A call to another computer made during a real run: it happened then, not at release. */
  ran: boolean;
  /** How that call went; null while it is still running. */
  outcome: { status: 'sent' | 'failed'; error: string | null } | null;
  /** A file save: where the caller pinned it (pinFile), read by its run at release. */
  file: FileTarget | null;
}

/** Where a queued file goes: the real folder the caller approved, once pinned. */
interface FileTarget {
  pinned: string | null;
  /** The file's name and size, for the summary pinFile writes again once it has looked. */
  name: string;
  size: number;
}

interface Scope {
  mode: EffectsMode;
  entries: Entry[];
  /** False once fn has finished: an effect asked for after that is refused. */
  open: boolean;
  /** The caller checks and pins every file (EffectsOptions.pinFiles). */
  pinFiles: boolean;
}

/** How a scope runs, besides its mode. */
export interface EffectsOptions {
  /**
   * The caller checks every file save's folder itself and pins it (pinFile). writeFile then never
   * looks at the disk, pinFile looks once the folder is approved, and release writes a file only
   * when it was pinned: one that never was is reported failed (FILE_NOT_CHECKED) and not saved.
   */
  pinFiles?: boolean;
}

interface EffectsState {
  scope: AsyncLocalStorage<Scope>;
  printHandler: PrintHandler | null;
  /** What each run that threw had asked for, by the error it threw (effectsOfFailedRun). */
  failed: WeakMap<object, { mode: EffectsMode; entries: Entry[] }>;
}

// On globalThis: Next can load this module more than once (the bridge's bundle and a route's).
// One store keeps a scope the bridge opened visible to the email service the route calls.
const g = globalThis as typeof globalThis & { __ironbooksEffects?: EffectsState };

function state(): EffectsState {
  if (!g.__ironbooksEffects) {
    g.__ironbooksEffects = { scope: new AsyncLocalStorage<Scope>(), printHandler: null, failed: new WeakMap() };
  }
  // A store an older copy of this module left behind (a reload while developing) may lack the map;
  // without it a failed run would throw a TypeError in place of its own error.
  if (!g.__ironbooksEffects.failed) g.__ironbooksEffects.failed = new WeakMap();
  return g.__ironbooksEffects;
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function refusedLate(what: string): ServiceError {
  return new ServiceError('CONFLICT', `${what} was asked for after the work it belongs to had finished, so it was not done.`);
}

/** The open scope this code runs in, null outside any scope. A closed one refuses. */
function activeScope(what: string): Scope | null {
  const s = state().scope.getStore();
  if (!s) return null;
  if (!s.open) throw refusedLate(what);
  return s;
}

/** Close a scope and take its queue out of it (see "What the queue holds" in the header). */
function closeScope(scope: Scope): Entry[] {
  scope.open = false;
  const entries = scope.entries;
  scope.entries = [];
  return entries;
}

/** How a call to another computer made during the run went. */
function ranReport(e: Entry): EffectReport {
  const outcome = e.outcome ?? { status: 'failed' as const, error: STILL_RUNNING };
  return { effect: e.preview, ...outcome, ranDuringOperation: true };
}

function isObject(v: unknown): v is object {
  return v !== null && (typeof v === 'object' || typeof v === 'function');
}

/**
 * Run fn with its effects captured (a dry run) or deferred (a real run in a transaction). See the
 * header. Scopes do not nest: a second one inside an open scope is refused, because the inner
 * caller's release() could send what the outer run may still roll back.
 *
 * If fn throws, the same error is thrown here and nothing is ever released; effectsOfFailedRun(err)
 * says what fn had asked for.
 */
export async function runWithEffects<T>(mode: EffectsMode, fn: () => T | Promise<T>, options: EffectsOptions = {}): Promise<EffectsRun<T>> {
  if (mode !== 'capture' && mode !== 'defer') throw new Error(`Unknown effects mode "${String(mode)}".`);
  const outer = state().scope.getStore();
  if (outer?.open) {
    throw new Error('Effects are already being collected for this work, so another collection cannot start inside it.');
  }
  const scope: Scope = { mode, entries: [], open: true, pinFiles: options?.pinFiles === true };
  let value: T;
  try {
    value = await state().scope.run(scope, fn);
  } catch (err) {
    // Rolled back: nothing can ever run. The ways to run each effect go (with the message bytes
    // and the mail server password they hold); what was asked for stays readable by the error.
    const entries = closeScope(scope);
    for (const e of entries) e.run = null;
    if (isObject(err)) state().failed.set(err, { mode, entries });
    throw err;
  }
  // Only release and discard can reach the queue from here on.
  let queue: Entry[] | null = closeScope(scope);
  const effects = queue.map((e) => e.preview);
  return {
    mode,
    value,
    effects,
    release: async () => {
      if (!queue) return [];
      const entries = queue;
      queue = null;
      const reports: EffectReport[] = [];
      for (const e of entries) {
        if (e.ran) {
          reports.push(ranReport(e));
          continue;
        }
        const run = e.run;
        e.run = null;
        if (!run) continue;
        try {
          await run();
          reports.push({ effect: e.preview, status: 'sent', error: null, ranDuringOperation: false });
        } catch (err) {
          reports.push({ effect: e.preview, status: 'failed', error: errorText(err), ranDuringOperation: false });
        }
      }
      return reports;
    },
    discard: () => {
      queue = null;
    },
  };
}

/**
 * What a run that threw had asked for, given the error runWithEffects threw; null for any other
 * error. The bridge reads it to show a dry run stopped by EffectNotRunInPreview, and to record in
 * the audit trail the calls to other computers a failed real run had already made.
 */
export function effectsOfFailedRun(err: unknown): FailedRunEffects | null {
  if (!isObject(err)) return null;
  const run = state().failed.get(err);
  if (!run) return null;
  return {
    mode: run.mode,
    effects: run.entries.map((e) => e.preview),
    ran: run.entries.filter((e) => e.ran).map(ranReport),
  };
}

/** The mode of the scope this code runs in, or null outside any scope. */
export function currentEffectsMode(): EffectsMode | null {
  const s = state().scope.getStore();
  return s?.open ? s.mode : null;
}

/**
 * The effects recorded so far in the scope this code runs in (null outside any scope). Once fn
 * has thrown, effectsOfFailedRun(err) gives the same list.
 */
export function currentEffects(): EffectPreview[] | null {
  const s = state().scope.getStore();
  return s?.open ? s.entries.map((e) => e.preview) : null;
}

/**
 * Run fn outside any scope, so its effects happen at once. For code that starts long-lived work
 * (a scheduler's timer) while handling a request; never for the work of the operation itself.
 */
export function outsideEffects<T>(fn: () => T): T {
  return state().scope.exit(fn);
}

/** Register (or, with null, remove) what does the printing. The desktop shell calls this. */
export function setPrintHandler(handler: PrintHandler | null): void {
  state().printHandler = handler;
}

// ---------------------------------------------------------------------------
// Email: what nodemailer will really do, never the content itself
// ---------------------------------------------------------------------------

interface Mailbox {
  name: string;
  address: string;
}

/** The words of every refusal of an email inside a scope. */
function refuseEmail(reason: string): ServiceError {
  return new ServiceError('VALIDATION', `This email cannot be sent from an agent's work. ${reason}`);
}

/**
 * The mailboxes an address field reaches, read the way nodemailer reads them: text with its own
 * parser, a { name, address } object as it is, lists flattened, groups opened, entries with no
 * address left out (nothing is sent to them). Any other value throws: who it reaches is unknown.
 */
function mailboxes(v: unknown, field: string): Mailbox[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap((x) => mailboxes(x, field));
  if (typeof v === 'string') {
    return addressparser(v, { flatten: true })
      .filter((a) => a.address)
      .map((a) => ({ name: a.name || '', address: a.address }));
  }
  const a = v as { name?: unknown; address?: unknown };
  if (typeof v === 'object' && typeof a.address === 'string' && a.address) {
    return [{ name: typeof a.name === 'string' ? a.name : '', address: a.address }];
  }
  throw refuseEmail(`Its ${field} addresses could not be read, so the preview cannot show who it goes to.`);
}

/** A name that needs no quotes in "Name <address>". */
const PLAIN_NAME = /^[\p{L}\p{N}!#$%&'*+\-/=?^_`{|}~ ]+$/u;

/** "Ap Desk <ap@globex.test>", "\"Doe, Jane\" <jane@globex.test>" or "ap@globex.test". */
function mailboxText(m: Mailbox): string {
  if (!m.name) return m.address;
  const name = PLAIN_NAME.test(m.name) ? m.name : `"${m.name.replace(/(["\\])/g, '\\$1')}"`;
  return `${name} <${m.address}>`;
}

/**
 * True when nodemailer would read this content from a file or a web address only as the email
 * goes out, so a preview cannot know what it holds. A data: link is the content itself, and a
 * stream supplies its own bytes.
 */
function readsLater(v: unknown): boolean {
  if (!v || typeof v !== 'object' || v instanceof Uint8Array) return false;
  const c = v as { pipe?: unknown; path?: unknown; href?: unknown; content?: unknown };
  if (typeof c.pipe === 'function') return false;
  for (const where of [c.path, c.href]) {
    if (typeof where === 'string' && where && !/^data:/i.test(where.trim())) return true;
  }
  return readsLater(c.content);
}

/** True for a part given as finished MIME text: its name and size cannot be read from it. */
function isRawPart(v: unknown): boolean {
  return !!v && typeof v === 'object' && !(v instanceof Uint8Array) && !!(v as { raw?: unknown }).raw;
}

/** The message's own content fields, in plain words. */
const CONTENT_FIELDS: Array<[string, string]> = [
  ['text', 'text'],
  ['html', 'formatted (HTML) text'],
  ['watchHtml', 'smartwatch text'],
  ['amp', 'interactive (AMP) text'],
  ['icalEvent', 'calendar invitation'],
];

/** Headers that would add a sender or recipients the preview does not read. */
const ADDRESS_HEADERS = new Set(['from', 'sender', 'to', 'cc', 'bcc', 'reply-to']);

function headerNames(h: unknown): string[] {
  if (!h || typeof h !== 'object') return [];
  if (Array.isArray(h)) {
    return h.map((x) => (x && typeof x === 'object' && typeof (x as { key?: unknown }).key === 'string' ? (x as { key: string }).key : ''));
  }
  return Object.keys(h);
}

/** Size of attachment content held in memory; null for a stream or a data: link. */
function contentSize(content: unknown, encoding: unknown): number | null {
  if (typeof content === 'string') {
    const enc = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8';
    return Buffer.byteLength(content, enc);
  }
  if (content instanceof Uint8Array) return content.byteLength;
  return null;
}

interface AttachmentSummary {
  name: string;
  size: number | null;
  type: string | null;
}

/** The attachment's name as nodemailer will give it. */
function attachmentName(att: { filename?: unknown; path?: unknown; href?: unknown }, i: number): string {
  if (typeof att.filename === 'string' && att.filename) return att.filename;
  if (att.filename === false) return 'attachment';
  const where = typeof att.path === 'string' ? att.path : typeof att.href === 'string' ? att.href : '';
  const fromWhere = /^data:/i.test(where) ? '' : (where.split(/[/\\]/).pop() ?? '').split('?')[0];
  return fromWhere || `attachment-${i + 1}`;
}

function attachmentSummaries(list: unknown): AttachmentSummary[] {
  const items: unknown[] = !list ? [] : Array.isArray(list) ? list : [list];
  return items.map((a, i) => {
    if (!a || typeof a !== 'object') throw refuseEmail('One of its attachments could not be read.');
    const att = a as Mail.Attachment;
    const name = attachmentName(att, i);
    if (readsLater(att)) {
      throw refuseEmail(
        `The attachment "${oneLine(name, 80, 'middle')}" would be read from a file or a web address only as the email goes out, so the preview cannot show it. Attach its content instead.`,
      );
    }
    if (isRawPart(att)) {
      throw refuseEmail(`The attachment "${oneLine(name, 80, 'middle')}" is given as a finished part of a message, so the preview cannot show its name or size.`);
    }
    return {
      name,
      size: contentSize(att.content, att.encoding),
      type: typeof att.contentType === 'string' && att.contentType ? att.contentType : null,
    };
  });
}

/**
 * "Email to billing@acme.com: Invoice 1042 (1 attachment, 84 KB)". Recipients, subject and the
 * attachments' names, sizes and types only: never the body or the attachment bytes, which can be
 * large and are not needed to decide.
 *
 * Throws (a ServiceError in plain words) rather than describe an email wrongly: one nodemailer
 * would deliver to anyone but its To, Cc and Bcc, one with a part read from a file or a web
 * address only as it goes out, one whose addresses or attachments cannot be read. Outside a scope
 * effects.email does not let this stop a person's send.
 */
export function emailPreview(message: EmailMessage): EffectPreview {
  if (!message || typeof message !== 'object') throw refuseEmail('There is no message to send.');
  const m = message as unknown as Record<string, unknown>;
  if (m.raw) {
    throw refuseEmail('It is given as a finished message, so the preview cannot show who it goes to or what it holds.');
  }
  if (m.envelope) {
    throw refuseEmail('It names delivery addresses of its own besides To, Cc and Bcc, and the preview would not show them.');
  }
  if (headerNames(m.headers).some((k) => ADDRESS_HEADERS.has(k.trim().toLowerCase()))) {
    throw refuseEmail('Its extra headers name a sender or recipients, and the preview would not show them.');
  }
  for (const [key, words] of CONTENT_FIELDS) {
    if (readsLater(m[key])) {
      throw refuseEmail(`Its ${words} would be read from a file or a web address only as the email goes out, so the preview cannot show it.`);
    }
  }
  if (Array.isArray(m.alternatives) && m.alternatives.some(readsLater)) {
    throw refuseEmail('One of its versions would be read from a file or a web address only as the email goes out, so the preview cannot show it.');
  }
  if (m.subject !== undefined && m.subject !== null && typeof m.subject !== 'string') {
    throw refuseEmail('Its subject is not text.');
  }

  const to = mailboxes(m.to, 'To');
  const cc = mailboxes(m.cc, 'Cc');
  const bcc = mailboxes(m.bcc, 'Bcc');
  const replyTo = mailboxes(m.replyTo, 'Reply-To');
  const from = mailboxes(m.from, 'From')[0] ?? null;
  const subject = typeof m.subject === 'string' ? m.subject : '';
  const attachments = attachmentSummaries(m.attachments);
  const known = attachments.filter((a) => a.size !== null);
  const total = known.reduce((sum, a) => sum + (a.size ?? 0), 0);

  const short = (list: Mailbox[]) => nameList(list.map((x) => oneLine(x.address, 80, 'middle')));
  let summary = to.length ? `Email to ${short(to)}` : 'Email with no recipient';
  if (cc.length) summary += `, copy to ${short(cc)}`;
  if (bcc.length) summary += `, hidden copy to ${short(bcc)}`;
  summary += `: ${oneLine(subject, 120) || '(no subject)'}`;
  if (attachments.length) {
    const count = `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`;
    summary += known.length ? ` (${count}, ${formatSize(total)})` : ` (${count})`;
  }
  return {
    kind: 'email',
    summary,
    detail: {
      from: from ? mailboxText(from) : null,
      to: to.map(mailboxText),
      cc: cc.map(mailboxText),
      bcc: bcc.map(mailboxText),
      replyTo: replyTo.map(mailboxText),
      subject,
      attachments,
      attachmentsSize: known.length ? total : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Files, printing, calls to other computers
// ---------------------------------------------------------------------------

function filePreview(file: { dir: string; name: string; path: string; size: number; replaces: boolean }): EffectPreview {
  const replacing = file.replaces ? ', replacing the file already there' : '';
  return {
    kind: 'file',
    summary: `Save ${oneLine(file.name, 80, 'middle')} (${formatSize(file.size)}) in ${oneLine(file.dir, 120, 'middle')}${replacing}`,
    detail: { dir: file.dir, name: file.name, path: file.path, size: file.size, replaces: file.replaces },
  };
}

function printPreview(job: { fileId: string; printer: string | null; copies: number; name: string | null }, available: boolean): EffectPreview {
  const what = job.name ? oneLine(job.name, 80, 'middle') : `file ${oneLine(job.fileId, 40, 'middle')}`;
  const where = job.printer ? oneLine(job.printer, 60) : 'the default printer';
  return {
    kind: 'print',
    summary: `Print ${what} on ${where}${job.copies > 1 ? `, ${job.copies} copies` : ''}`,
    detail: { fileId: job.fileId, name: job.name, printer: job.printer, copies: job.copies, available },
  };
}

function networkPreview(call: NetworkCall, ran: boolean): EffectPreview {
  return {
    kind: 'network',
    summary: `Contact ${oneLine(call.host, 80, 'middle')} for ${oneLine(call.purpose, 120)}`,
    detail: { host: call.host, purpose: call.purpose, ran },
  };
}

// Checks done in every mode, so a preview fails where the real run would.

/** Characters no file name may hold on Windows, plus control and invisible formatting characters. */
const BAD_NAME = /[\\/:*?"<>|\p{Cc}\p{Cf}]/u;
/** Names Windows keeps for devices, with or without an extension ("CON", "nul.txt", "COM1.pdf"). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/iu;

function checkFile(file: FileToWrite): { dir: string; name: string; full: string; size: number } {
  if (!file || typeof file.dir !== 'string' || !file.dir.trim()) {
    throw new ServiceError('VALIDATION', 'Say which folder the file is saved in.');
  }
  const name = typeof file.name === 'string' ? file.name : '';
  if (!name.trim()) throw new ServiceError('VALIDATION', 'The file needs a name.');
  // Windows drops a trailing dot or space, so such a file would be saved under another name.
  if (BAD_NAME.test(name) || name !== name.trim() || name.endsWith('.')) {
    throw new ServiceError(
      'VALIDATION',
      `"${oneLine(name, 80, 'middle')}" cannot be used as a file name. Give the folder and the name separately, leave out \\ / : * ? " < > | and invisible characters, and do not end the name with a dot or a space.`,
    );
  }
  if (DEVICE_NAME.test(name)) {
    throw new ServiceError('VALIDATION', `"${oneLine(name, 80, 'middle')}" cannot be used as a file name: Windows keeps that name for a device. Choose another name.`);
  }
  if (name.length > 255) throw new ServiceError('VALIDATION', 'The file name is too long. Use at most 255 characters.');
  if (typeof file.bytes !== 'string' && !(file.bytes instanceof Uint8Array)) {
    throw new ServiceError('VALIDATION', 'There is nothing to save in the file.');
  }
  const dir = path.resolve(file.dir);
  const size = typeof file.bytes === 'string' ? Buffer.byteLength(file.bytes, 'utf8') : file.bytes.byteLength;
  return { dir, name, full: path.join(dir, name), size };
}

/** What is at `full` now: a file (saving replaces it), a folder (saving cannot), or nothing. */
async function whatIsAt(full: string): Promise<'file' | 'folder' | null> {
  try {
    return (await fsp.stat(full)).isDirectory() ? 'folder' : 'file';
  } catch {
    return null; // nothing there, or it cannot be looked at: the save itself will say
  }
}

/**
 * Save so a reader never sees half a file: a temporary file next to it, then renamed over the old
 * one. A failed write leaves the previous file as it was and no temporary file behind. The
 * temporary file is always created new ('wx'): something already there under its name (a link
 * planted in the folder) is never written through, and the save fails instead.
 */
async function writeNow(dir: string, full: string, bytes: Uint8Array | string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${full}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  const removeTmp = () => fsp.rm(tmp, { force: true }).catch(() => undefined);
  try {
    await fsp.writeFile(tmp, bytes, { flag: 'wx' });
  } catch (err) {
    // Only a temporary file this save made is removed, never one that was already there.
    if ((err as { code?: unknown } | null)?.code !== 'EEXIST') await removeTmp();
    throw err;
  }
  try {
    await fsp.rename(tmp, full);
  } catch (err) {
    await removeTmp();
    throw err;
  }
}

function checkPrint(job: PrintJob): { fileId: string; printer: string | null; copies: number; name: string | null } {
  if (!job || typeof job.fileId !== 'string' || !job.fileId.trim()) {
    throw new ServiceError('VALIDATION', 'Say which file to print.');
  }
  const copies = job.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_PRINT_COPIES) {
    throw new ServiceError('VALIDATION', `The number of copies must be a whole number from 1 to ${MAX_PRINT_COPIES}.`);
  }
  const printer = typeof job.printer === 'string' && job.printer.trim() ? job.printer.trim() : null;
  const name = typeof job.name === 'string' && job.name.trim() ? job.name.trim() : null;
  return { fileId: job.fileId, printer, copies, name };
}

async function printNow(job: { fileId: string; printer: string | null; copies: number; name: string | null }): Promise<void> {
  const handler = state().printHandler;
  if (!handler) throw new ServiceError('VALIDATION', PRINTING_NOT_AVAILABLE);
  await handler(job);
}

function checkCall(call: NetworkCall): NetworkCall {
  const host = typeof call?.host === 'string' ? call.host.trim() : '';
  const purpose = typeof call?.purpose === 'string' ? call.purpose.trim() : '';
  if (!host || !purpose) throw new ServiceError('VALIDATION', 'A call to another computer must say which computer and what for.');
  return { host, purpose };
}

function record(
  scope: Scope,
  what: string,
  preview: EffectPreview,
  run: (() => Promise<unknown>) | null,
  ran = false,
  file: FileTarget | null = null,
): Entry {
  // Asked again here: writeFile looks at the disk first, and the work may have finished meanwhile.
  if (!scope.open) throw refusedLate(what);
  const defer = scope.mode === 'defer';
  const entry: Entry = { preview, run: defer ? run : null, ran: defer && ran, outcome: null, file };
  scope.entries.push(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Pinned files: written only into the folder the caller approved
// ---------------------------------------------------------------------------

const WIN = process.platform === 'win32';

/** The release report's words for a pinned file whose folder changed after it was approved. */
export const PINNED_FOLDER_CHANGED =
  'The folder changed after this was approved (a link or shortcut in it now leads somewhere else), so the file was not saved there. Ask for it to be saved again.';

/** The release report's words for a file a { pinFiles } scope's caller never checked (and pinned). */
export const FILE_NOT_CHECKED =
  'This file was asked for after its folder could be checked, so it was not saved. Ask for it to be saved again.';

/** Two folder paths name the same place, as the system writes them (any case on Windows). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return WIN ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** The folder with every link resolved: the system's own answer first, the plain one where it fails. */
function realFolder(dir: string): Promise<string> {
  return new Promise((resolve, reject) =>
    fs.realpath.native(dir, (err, out) => {
      if (!err) return resolve(out);
      fsp.realpath(dir).then(resolve, reject);
    }),
  );
}

/** Throws PINNED_FOLDER_CHANGED unless `dir` exists and resolves to itself (no link in the way). */
async function assertStillItself(dir: string): Promise<void> {
  let real: string;
  try {
    real = await realFolder(dir);
  } catch {
    throw new Error(PINNED_FOLDER_CHANGED);
  }
  if (!samePath(real, dir)) throw new Error(PINNED_FOLDER_CHANGED);
}

/**
 * The nearest part of `dir` that exists (itself, or a parent), looked at with lstat so a link
 * there is found, not followed. Every part looked at is inside the folder the caller approved.
 */
async function nearestExisting(dir: string): Promise<string> {
  let at = path.resolve(dir);
  for (;;) {
    try {
      await fsp.lstat(at);
      return at;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw new Error(PINNED_FOLDER_CHANGED);
    }
    const up = path.dirname(at);
    if (up === at) throw new Error(PINNED_FOLDER_CHANGED);
    at = up;
  }
}

/**
 * Write a pinned file: into `dir` (the real folder the caller approved, made when it is new), and
 * only while that folder still resolves to itself, so a link made inside it since the check
 * cannot lead the write somewhere else. The part that exists is looked at BEFORE any folder is
 * made, so a link planted at a name still to be made gets no folder made where it leads.
 */
async function writePinned(dir: string, name: string, bytes: Uint8Array | string): Promise<void> {
  await assertStillItself(await nearestExisting(dir));
  await fsp.mkdir(dir, { recursive: true });
  await assertStillItself(dir);
  const full = path.join(dir, name);
  if ((await whatIsAt(full)) === 'folder') throw new Error(`There is now a folder called "${oneLine(name, 80, 'middle')}" there, so the file was not saved.`);
  await writeNow(dir, full, bytes);
}

/** The refusal of a file name a folder already uses (writeFile, and pinFile in a { pinFiles } scope). */
function folderInTheWay(name: string, dir: string): ServiceError {
  return new ServiceError(
    'VALIDATION',
    `There is a folder called "${oneLine(name, 80, 'middle')}" in ${oneLine(dir, 120, 'middle')}, so the file cannot be saved under that name.`,
  );
}

/**
 * Pin a file the work asked to save (its effect, as currentEffects() gave it) to `realDir`: the
 * real folder the caller approved for it, with every link resolved. At release the file is written
 * into exactly that folder, after checking once more that it still resolves to itself (see
 * "Folders" in the header). Only inside the open scope the file was asked for in, and only once
 * per file (pinning it again to the same folder changes nothing; to another folder throws).
 *
 * Then it looks at the file's place in that folder (approved, so it may be looked at): the preview
 * says when the save replaces a file there, and a folder of that name throws the same VALIDATION
 * error writeFile gives a person. In a { pinFiles } scope this is the first look at the disk.
 */
export async function pinFile(effect: EffectPreview, realDir: string): Promise<void> {
  const s = state().scope.getStore();
  if (!s?.open) throw new Error('A file can only be pinned while the work that asked for it is running.');
  const entry = s.entries.find((e) => e.preview === effect);
  if (!entry || !entry.file) throw new Error('That is not a file this work asked to save.');
  if (typeof realDir !== 'string' || !path.isAbsolute(realDir)) throw new Error('A file can only be pinned to a full folder path.');
  const dir = path.resolve(realDir);
  if (entry.file.pinned !== null && !samePath(entry.file.pinned, dir)) throw new Error('This file is already pinned to another folder.');
  entry.file.pinned = dir;
  const there = await whatIsAt(path.join(dir, entry.file.name));
  if (there === 'folder') throw folderInTheWay(entry.file.name, String(effect.detail.dir ?? dir));
  const replaces = there === 'file';
  if (effect.detail.replaces !== replaces) {
    const fresh = filePreview({ dir: String(effect.detail.dir ?? dir), name: entry.file.name, path: String(effect.detail.path ?? ''), size: entry.file.size, replaces });
    effect.summary = fresh.summary;
    effect.detail.replaces = replaces;
  }
}

// ---------------------------------------------------------------------------
// The effects
// ---------------------------------------------------------------------------

export const effects = {
  /**
   * Send one email. `send` hands the message to the mail server: this module does not know the
   * company's mail settings. Services call sendMail in lib/services/email.ts, which passes the
   * company's own server, rather than this. No scope: sent now, and its errors are thrown as they
   * are. 'capture': recorded, not sent. 'defer': sent on release, where a failure is reported
   * instead of thrown. Inside a scope an email the preview cannot show truthfully is refused
   * (see emailPreview).
   */
  async email(message: EmailMessage, send: EmailSender): Promise<EmailResult> {
    const scope = activeScope('An email');
    if (!scope) {
      // A person's send, exactly as before: the preview is only a courtesy here, so an email it
      // cannot describe still goes out.
      let effect: EffectPreview;
      try {
        effect = emailPreview(message);
      } catch {
        effect = { kind: 'email', summary: 'Email', detail: {} };
      }
      const info = await send(message);
      return { sent: true, status: 'done', info, effect };
    }
    const effect = emailPreview(message);
    record(scope, 'An email', effect, () => send(message));
    return { sent: false, status: scope.mode === 'capture' ? 'previewed' : 'queued', info: null, effect };
  },

  /**
   * Save a file in a folder. Same three behaviours as email. The preview says when it replaces a
   * file already there. Which folders an agent may use is the bridge's check, not this one's. In a
   * { pinFiles } scope the disk is not looked at here (see "Folders" in the header): `replaces` is
   * false until pinFile has looked, and only the preview is brought up to date then.
   */
  async writeFile(file: FileToWrite): Promise<WriteFileResult> {
    const scope = activeScope('Saving a file');
    const f = checkFile(file);
    const there = scope?.pinFiles ? null : await whatIsAt(f.full);
    if (there === 'folder') throw folderInTheWay(f.name, f.dir);
    const replaces = there === 'file';
    const effect = filePreview({ dir: f.dir, name: f.name, path: f.full, size: f.size, replaces });
    const bytes = file.bytes;
    if (!scope) {
      await writeNow(f.dir, f.full, bytes);
      return { written: true, status: 'done', path: f.full, size: f.size, replaces, effect };
    }
    // Pinned (pinFile): only into the approved folder. Unpinned: where the work said, except in a
    // { pinFiles } scope, where a file its caller never checked is not saved at all.
    const target: FileTarget = { pinned: null, name: f.name, size: f.size };
    const pinFiles = scope.pinFiles;
    const run = () =>
      target.pinned !== null
        ? writePinned(target.pinned, f.name, bytes)
        : pinFiles
          ? Promise.reject(new Error(FILE_NOT_CHECKED))
          : writeNow(f.dir, f.full, bytes);
    record(scope, 'Saving a file', effect, run, false, target);
    return { written: false, status: scope.mode === 'capture' ? 'previewed' : 'queued', path: f.full, size: f.size, replaces, effect };
  },

  /**
   * Print a file through the handler the desktop shell registers (setPrintHandler). No scope and
   * no handler: throws "Printing is not available here." In 'defer' the handler is looked up at
   * release, so one registered in between is used; with none, the release reports that failure.
   */
  async print(job: PrintJob): Promise<PrintResult> {
    const scope = activeScope('Printing');
    const j = checkPrint(job);
    const effect = printPreview(j, state().printHandler !== null);
    if (!scope) {
      await printNow(j);
      return { printed: true, status: 'done', effect };
    }
    record(scope, 'Printing', effect, () => printNow(j));
    return { printed: false, status: scope.mode === 'capture' ? 'previewed' : 'queued', effect };
  },

  /**
   * Contact another computer (an AI provider, an update check, an e-file service) and return what
   * `fn` returns. No scope: runs fn. 'defer': runs fn at once (the operation needs the answer and
   * was approved) and records it for the audit trail; fn should be awaited, or the report can only
   * say STILL_RUNNING. 'capture': does NOT run fn; records it and throws EffectNotRunInPreview.
   */
  async network<T>(call: NetworkCall, fn: () => T | Promise<T>): Promise<T> {
    const scope = activeScope('A call to another computer');
    if (!scope) return fn();
    const c = checkCall(call);
    if (scope.mode === 'capture') {
      const effect = networkPreview(c, false);
      record(scope, 'A call to another computer', effect, null);
      throw new EffectNotRunInPreview(effect);
    }
    const entry = record(scope, 'A call to another computer', networkPreview(c, true), null, true);
    try {
      const value = await fn();
      entry.outcome = { status: 'sent', error: null };
      return value;
    } catch (err) {
      entry.outcome = { status: 'failed', error: errorText(err) };
      throw err;
    }
  },
};
