/**
 * The effects outbox (lib/effects.ts, plan section 5.4): a dry run records email, files, printing
 * and calls to other computers without doing any of them; a real run inside a transaction does
 * them only on release() after the commit, and never after a rollback; outside any scope they
 * happen at once, as they always have. Nothing leaves the machine: emails go to a recorder or to
 * nodemailer's JSON transport, files to a temporary folder, printing to a stub handler.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import {
  EffectNotRunInPreview,
  FILE_NOT_CHECKED,
  PINNED_FOLDER_CHANGED,
  PRINTING_NOT_AVAILABLE,
  STILL_RUNNING,
  currentEffects,
  currentEffectsMode,
  effects,
  effectsAbout,
  effectsOfFailedRun,
  formatSize,
  outsideEffects,
  pinFile,
  runWithEffects,
  setPrintHandler,
  type EmailMessage,
} from './effects';
import { ServiceError } from '@/lib/services/errors';

const sent: EmailMessage[] = [];
let refuse: ((m: EmailMessage) => string | null) | null = null;
/** A mail server stand-in: records what it is handed, or refuses it. */
const send = async (m: EmailMessage) => {
  const why = refuse?.(m);
  if (why) throw new Error(why);
  sent.push(m);
  return { messageId: `<${sent.length}@test>` };
};
const subjects = () => sent.map((m) => m.subject);
const msg = (subject: string, extra: Partial<EmailMessage> = {}): EmailMessage => ({
  from: 'books@acme.test',
  to: 'customer@globex.test',
  subject,
  text: `Body of ${subject}`,
  ...extra,
});
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TMP = path.join(os.tmpdir(), `ironbooks-effects-${process.pid}-${Date.now().toString(36)}`);

beforeEach(() => {
  sent.length = 0;
  refuse = null;
});

afterEach(() => {
  setPrintHandler(null);
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('outside any scope: everything happens at once, as today', () => {
  it('an email is handed to the mail server now and its answer comes back', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const r = await effects.email(msg('Invoice 1042'), (m) => transport.sendMail(m));
    expect(r).toMatchObject({ sent: true, status: 'done' });
    const info = r.info as { message: string; envelope: { to: string[] } };
    expect(JSON.parse(info.message)).toMatchObject({ subject: 'Invoice 1042' });
    expect(info.envelope.to).toEqual(['customer@globex.test']);
    expect(r.effect.summary).toBe('Email to customer@globex.test: Invoice 1042');
    expect(currentEffectsMode()).toBeNull();
    expect(currentEffects()).toBeNull();
  });

  it("a send's error is thrown as it is", async () => {
    refuse = () => 'Mail server said no';
    await expect(effects.email(msg('Hi'), send)).rejects.toThrow('Mail server said no');
  });

  it('a file is saved now; a call to another computer runs; printing uses the handler', async () => {
    const dir = path.join(TMP, 'now');
    const w = await effects.writeFile({ dir, name: 'report.csv', bytes: 'a,b\n1,2\n' });
    expect(w).toMatchObject({ written: true, status: 'done', size: 8, replaces: false });
    expect(fs.readFileSync(path.join(dir, 'report.csv'), 'utf8')).toBe('a,b\n1,2\n');
    expect(fs.readdirSync(dir)).toEqual(['report.csv']); // no temporary file left behind

    expect(await effects.network({ purpose: 'reading the statement', host: 'api.example.com' }, () => 42)).toBe(42);

    // A ServiceError, so a route shows these words and not "Internal server error".
    await expect(effects.print({ fileId: 'f1' })).rejects.toMatchObject({ code: 'VALIDATION', message: PRINTING_NOT_AVAILABLE });
    const jobs: unknown[] = [];
    setPrintHandler(async (job) => void jobs.push(job));
    const p = await effects.print({ fileId: 'f1', printer: 'Front desk', copies: 2 });
    expect(p).toMatchObject({ printed: true, status: 'done' });
    expect(jobs).toEqual([{ fileId: 'f1', printer: 'Front desk', copies: 2, name: null }]);
  });
});

describe("capture (a dry run): everything is recorded, nothing happens", () => {
  it('records the email and sends nothing; the caller gets a not-sent answer and carries on', async () => {
    const run = await runWithEffects('capture', async () => {
      expect(currentEffectsMode()).toBe('capture');
      const r = await effects.email(msg('Invoice 1042'), send);
      expect(r).toMatchObject({ sent: false, status: 'previewed', info: null });
      expect(currentEffects()).toHaveLength(1);
      return 'done';
    });
    expect(run.value).toBe('done');
    expect(sent).toEqual([]);
    expect(run.effects).toEqual([
      expect.objectContaining({ kind: 'email', summary: 'Email to customer@globex.test: Invoice 1042' }),
    ]);
    // Nothing was queued, so release has nothing to send.
    expect(await run.release()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('attachments are summarised by name, size and type; their bytes and the body are not in the preview', async () => {
    const marker = 'SECRET-PDF-BYTES';
    const pdf = Buffer.concat([Buffer.from(marker), Buffer.alloc(84 * 1024 - marker.length, 7)]);
    const run = await runWithEffects('capture', () =>
      effects.email(
        msg('Invoice 1042', {
          to: 'billing@acme.com',
          text: 'Private body text',
          attachments: [{ filename: 'invoice-1042.pdf', content: pdf, contentType: 'application/pdf' }],
        }),
        send,
      ),
    );
    const [e] = run.effects;
    expect(e.summary).toBe('Email to billing@acme.com: Invoice 1042 (1 attachment, 84 KB)');
    expect(e.detail.attachments).toEqual([{ name: 'invoice-1042.pdf', size: 84 * 1024, type: 'application/pdf' }]);
    const text = JSON.stringify(run.effects);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(Buffer.from(marker).toString('base64').slice(0, 16));
    expect(text).not.toContain('Private body text');
    expect(sent).toEqual([]);
  });

  it('names every recipient kind in plain words', async () => {
    const run = await runWithEffects('capture', async () => {
      await effects.email(
        msg('Statement', {
          to: ['"Doe, Jane" <jane@globex.test>', { name: 'Ap Desk', address: 'ap@globex.test' }],
          cc: 'owner@globex.test',
          bcc: ['me@acme.test'],
          attachments: [
            { filename: 'a.pdf', content: 'x'.repeat(2048) },
            { filename: 'b.csv', content: Buffer.alloc(1024) },
          ],
        }),
        send,
      );
      await effects.email(msg('', { to: 'a@x.test, b@x.test; c@x.test' }), send);
    });
    expect(run.effects[0].summary).toBe(
      'Email to jane@globex.test and ap@globex.test, copy to owner@globex.test, hidden copy to me@acme.test: Statement (2 attachments, 3 KB)',
    );
    expect(run.effects[0].detail).toMatchObject({
      to: ['"Doe, Jane" <jane@globex.test>', 'Ap Desk <ap@globex.test>'],
      cc: ['owner@globex.test'],
      bcc: ['me@acme.test'],
    });
    expect(run.effects[1].summary).toBe('Email to a@x.test and 2 others: (no subject)');
  });

  it('a file is not written and its folder not made; printing is recorded with or without a printer', async () => {
    const dir = path.join(TMP, 'capture');
    const run = await runWithEffects('capture', async () => {
      const w = await effects.writeFile({ dir, name: 'Profit and Loss.pdf', bytes: new Uint8Array(3 * 1024) });
      expect(w).toMatchObject({ written: false, status: 'previewed', path: path.join(dir, 'Profit and Loss.pdf') });
      await effects.print({ fileId: 'f9', name: 'Check 1042.pdf', copies: 2 });
    });
    expect(fs.existsSync(dir)).toBe(false);
    expect(run.effects.map((e) => e.summary)).toEqual([
      `Save Profit and Loss.pdf (3 KB) in ${dir}`,
      'Print Check 1042.pdf on the default printer, 2 copies',
    ]);
    expect(run.effects[1].detail).toMatchObject({ available: false });
  });

  it('a call to another computer is not made: it throws EffectNotRunInPreview, which carries the effect', async () => {
    const fn = vi.fn(async () => 'answer');
    let caught: unknown;
    const run = await runWithEffects('capture', async () => {
      try {
        await effects.network({ purpose: 'reading the bank statement', host: 'api.example.com' }, fn);
      } catch (err) {
        caught = err;
      }
    });
    expect(fn).not.toHaveBeenCalled();
    expect(caught).toBeInstanceOf(EffectNotRunInPreview);
    expect(caught).toBeInstanceOf(ServiceError);
    const err = caught as EffectNotRunInPreview;
    expect(err.message).toMatch(/^This would contact api\.example\.com for reading the bank statement\./);
    expect(err.effect).toEqual({
      kind: 'network',
      summary: 'Contact api.example.com for reading the bank statement',
      detail: { host: 'api.example.com', purpose: 'reading the bank statement', ran: false },
    });
    // Recorded in the scope too, for when a service catches the error and carries on another way.
    expect(run.effects).toEqual([err.effect]);
  });

  it('when fn throws to roll back, the effects so far can be read inside it first', async () => {
    let seen: unknown = null;
    await expect(
      runWithEffects('capture', async () => {
        await effects.email(msg('Invoice 7'), send);
        seen = currentEffects();
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(seen).toEqual([expect.objectContaining({ summary: 'Email to customer@globex.test: Invoice 7' })]);
    expect(sent).toEqual([]);
  });

  it('checks still run: a bad file name or copy count fails the preview as it would the real run', async () => {
    const names = [
      '../evil.txt',
      'a/b.txt',
      'C:\\x.txt',
      '',
      '..',
      ' padded.txt',
      // Shown as "Invoiceexe.pdf" by the right-to-left mark; a zero-width space; a C1 control.
      'Invoice\u202Efdp.exe',
      'Invoice\u200B.pdf',
      'a\u0085b.txt',
      // Windows drops a trailing dot, and keeps device names for itself, with any extension.
      'report.',
      'CON',
      'con.txt',
      'nul .txt',
      'LPT1.pdf',
      'COM\u00B9',
      'x'.repeat(256),
    ];
    await runWithEffects('capture', async () => {
      for (const name of names) {
        await expect(effects.writeFile({ dir: TMP, name, bytes: 'x' }), name).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      await expect(effects.print({ fileId: 'f1', copies: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(effects.print({ fileId: 'f1', copies: 101 })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(effects.network({ purpose: '', host: 'api.example.com' }, () => 1)).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(currentEffects()).toEqual([]);
    });
    // Ordinary names are fine, dots inside included.
    const ok = await runWithEffects('capture', () => effects.writeFile({ dir: TMP, name: 'Console v2.report.csv', bytes: 'x' }));
    expect(ok.effects).toHaveLength(1);
  });

  it('the preview says when a file is replaced, and a folder of that name is refused', async () => {
    const dir = path.join(TMP, 'replace');
    fs.mkdirSync(path.join(dir, 'taken'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.csv'), 'old');
    const run = await runWithEffects('capture', async () => {
      const w = await effects.writeFile({ dir, name: 'old.csv', bytes: 'new' });
      expect(w).toMatchObject({ written: false, replaces: true });
      await effects.writeFile({ dir, name: 'fresh.csv', bytes: 'new' });
      await expect(effects.writeFile({ dir, name: 'taken', bytes: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' });
    });
    expect(run.effects.map((e) => e.summary)).toEqual([
      `Save old.csv (3 bytes) in ${dir}, replacing the file already there`,
      `Save fresh.csv (3 bytes) in ${dir}`,
    ]);
    expect(run.effects.map((e) => e.detail.replaces)).toEqual([true, false]);
    expect(fs.readFileSync(path.join(dir, 'old.csv'), 'utf8')).toBe('old');
  });
});

describe('defer (a real run in a transaction): queued, done on release after the commit', () => {
  it('sends nothing until release, then everything in order, and reports each', async () => {
    const dir = path.join(TMP, 'defer');
    const jobs: string[] = [];
    setPrintHandler(async (job) => void jobs.push(job.fileId));
    const run = await runWithEffects('defer', async () => {
      const a = await effects.email(msg('First'), send);
      expect(a).toMatchObject({ sent: false, status: 'queued' });
      await effects.writeFile({ dir, name: 'out.txt', bytes: 'hello' });
      await effects.print({ fileId: 'f3' });
      await effects.email(msg('Second'), send);
      return 7;
    });
    expect(run.value).toBe(7);
    expect(sent).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(jobs).toEqual([]);

    const report = await run.release();
    expect(subjects()).toEqual(['First', 'Second']);
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('hello');
    expect(jobs).toEqual(['f3']);
    expect(report.map((r) => [r.effect.kind, r.status, r.error])).toEqual([
      ['email', 'sent', null],
      ['file', 'sent', null],
      ['print', 'sent', null],
      ['email', 'sent', null],
    ]);
  });

  it('a throw inside the scope sends nothing, ever', async () => {
    await expect(
      runWithEffects('defer', async () => {
        await effects.email(msg('Never'), send);
        await effects.writeFile({ dir: path.join(TMP, 'never'), name: 'x.txt', bytes: 'x' });
        throw new Error('the transaction rolled back');
      }),
    ).rejects.toThrow('the transaction rolled back');
    // The next scope starts empty: nothing of the failed one leaks into it.
    const next = await runWithEffects('defer', async () => undefined);
    expect(next.effects).toEqual([]);
    expect(await next.release()).toEqual([]);
    expect(sent).toEqual([]);
    expect(fs.existsSync(path.join(TMP, 'never'))).toBe(false);
  });

  it('release twice sends once; discard drops the queue', async () => {
    const run = await runWithEffects('defer', () => effects.email(msg('Once'), send));
    const [first, second] = await Promise.all([run.release(), run.release()]);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(await run.release()).toEqual([]);
    expect(subjects()).toEqual(['Once']);

    const dropped = await runWithEffects('defer', () => effects.email(msg('Dropped'), send));
    dropped.discard();
    expect(await dropped.release()).toEqual([]);
    expect(subjects()).toEqual(['Once']);
  });

  it('a failure at release is reported with its words, and the rest still go', async () => {
    refuse = (m) => (m.subject === 'Bad' ? 'The mail server refused the user name or password.' : null);
    const run = await runWithEffects('defer', async () => {
      await effects.email(msg('Good 1'), send);
      await effects.email(msg('Bad'), send);
      await effects.print({ fileId: 'f1' });
      await effects.email(msg('Good 2'), send);
    });
    const report = await run.release();
    expect(report.map((r) => [r.status, r.error])).toEqual([
      ['sent', null],
      ['failed', 'The mail server refused the user name or password.'],
      ['failed', PRINTING_NOT_AVAILABLE],
      ['sent', null],
    ]);
    expect(subjects()).toEqual(['Good 1', 'Good 2']);
  });

  it('a call to another computer runs at once and is recorded for the audit trail', async () => {
    const fn = vi.fn(async () => ({ lines: 3 }));
    const run = await runWithEffects('defer', async () => {
      const answer = await effects.network({ purpose: 'reading the bank statement', host: 'api.example.com' }, fn);
      expect(fn).toHaveBeenCalledTimes(1);
      return answer;
    });
    expect(run.value).toEqual({ lines: 3 });
    expect(run.effects).toEqual([expect.objectContaining({ kind: 'network', detail: expect.objectContaining({ ran: true }) })]);
    expect(await run.release()).toEqual([
      expect.objectContaining({ status: 'sent', error: null, ranDuringOperation: true }),
    ]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('an effect a service marked (effectsAbout) carries its record to the report, sent or failed; others carry none', async () => {
    refuse = (m) => (m.subject === 'Bad' ? 'The mail server refused the recipient.' : null);
    const about = { entityType: 'invoice', entityId: 'inv-1', onFailure: { toBeEmailed: true } };
    const run = await runWithEffects('defer', async () => {
      await effectsAbout(about, async () => {
        await delay(1);
        await effects.email(msg('Bad'), send);
      });
      // Two at once: each keeps its own mark.
      await Promise.all([
        effectsAbout({ entityType: 'invoice', entityId: 'inv-2' }, () => effects.email(msg('Good'), send)),
        effects.email(msg('Plain'), send),
      ]);
    });
    about.onFailure.toBeEmailed = false;
    const report = await run.release();
    expect(report.map((r) => [r.effect.summary.split(': ')[1], r.status, r.about ?? null])).toEqual([
      ['Bad', 'failed', { entityType: 'invoice', entityId: 'inv-1', onFailure: { toBeEmailed: true } }],
      ['Good', 'sent', { entityType: 'invoice', entityId: 'inv-2' }],
      ['Plain', 'sent', null],
    ]);
    expect(report[2]).not.toHaveProperty('about');
  });

  it('with no scope the mark changes nothing: sent at once, errors thrown as they are', async () => {
    const out = await effectsAbout({ entityType: 'invoice', entityId: 'x' }, () => effects.email(msg('Now'), send));
    expect(out).toMatchObject({ sent: true, status: 'done' });
    refuse = () => 'Refused.';
    await expect(effectsAbout({ entityType: 'invoice', entityId: 'x' }, () => effects.email(msg('No'), send))).rejects.toThrow('Refused.');
  });

  it('printing with no handler at release reports that printing is not available here', async () => {
    const run = await runWithEffects('defer', () => effects.print({ fileId: 'f1', printer: 'Office' }));
    expect(run.effects[0].summary).toBe('Print file f1 on Office');
    expect(await run.release()).toEqual([
      expect.objectContaining({ status: 'failed', error: 'Printing is not available here.' }),
    ]);
  });
});

describe('a file pinned to the folder that was approved (pinFile)', () => {
  /** A link to a folder: a junction on Windows (no special right needed), a symbolic link elsewhere. */
  const linkFolder = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  const real = (p: string) => fs.realpathSync.native(p);
  const fileEffect = () => (currentEffects() ?? []).find((e) => e.kind === 'file')!;

  it('is written into exactly that folder at release, made when it is new', async () => {
    const allowed = path.join(TMP, 'pin-ok');
    fs.mkdirSync(allowed, { recursive: true });
    const target = path.join(real(allowed), 'reports', '2026');
    const run = await runWithEffects('defer', async () => {
      await effects.writeFile({ dir: path.join(allowed, 'reports', '2026'), name: 'r.csv', bytes: 'x' });
      await pinFile(fileEffect(), target);
      // Pinning it again to the same folder changes nothing; to another one is refused.
      await pinFile(fileEffect(), target);
      await expect(pinFile(fileEffect(), path.join(real(allowed), 'other'))).rejects.toThrow(/already pinned to another folder/);
    });
    expect(fs.existsSync(target)).toBe(false);
    const report = await run.release();
    expect(report.map((r) => [r.status, r.error])).toEqual([['sent', null]]);
    expect(fs.readFileSync(path.join(target, 'r.csv'), 'utf8')).toBe('x');
    expect(fs.readdirSync(target)).toEqual(['r.csv']); // no temporary file left behind
  });

  it('a link made inside the approved folder before release cannot lead the write elsewhere', async () => {
    const allowed = path.join(TMP, 'pin-allowed');
    const elsewhere = path.join(TMP, 'pin-elsewhere');
    fs.mkdirSync(allowed, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    // A folder still to be made, one that exists, and one still to be made BELOW a name still to be
    // made: each swapped for a link while the work commits. Nothing is saved, and no folder is made,
    // where the link leads.
    const cases: Array<{ name: string; dir: string; prepare: () => void }> = [
      { name: 'new', dir: 'new', prepare: () => linkFolder(elsewhere, path.join(allowed, 'new')) },
      {
        name: 'old',
        dir: 'old',
        prepare: () => {
          fs.rmSync(path.join(allowed, 'old'), { recursive: true, force: true });
          linkFolder(elsewhere, path.join(allowed, 'old'));
        },
      },
      { name: 'deep', dir: path.join('deep', 'reports', '2026'), prepare: () => linkFolder(elsewhere, path.join(allowed, 'deep')) },
    ];
    fs.mkdirSync(path.join(allowed, 'old'));
    for (const c of cases) {
      const dir = path.join(allowed, c.dir);
      const run = await runWithEffects('defer', async () => {
        await effects.writeFile({ dir, name: `${c.name}.csv`, bytes: 'secret rows' });
        await pinFile(fileEffect(), path.join(real(allowed), c.dir));
      });
      c.prepare();
      const report = await run.release();
      expect(report, c.name).toEqual([expect.objectContaining({ status: 'failed', error: PINNED_FOLDER_CHANGED })]);
      expect(fs.readdirSync(elsewhere), c.name).toEqual([]);
    }
  });

  it('a link at a name still to be made that leads nowhere yet gets no folder made where it points', async () => {
    const allowed = path.join(TMP, 'pin-dangling');
    const nowhere = path.join(TMP, 'pin-nowhere');
    fs.mkdirSync(allowed, { recursive: true });
    const run = await runWithEffects('defer', async () => {
      await effects.writeFile({ dir: path.join(allowed, 'out', 'sub'), name: 'x.csv', bytes: 'x' });
      await pinFile(fileEffect(), path.join(real(allowed), 'out', 'sub'));
    });
    // A link to a folder that does not exist (yet): mkdir through it would make it.
    fs.mkdirSync(nowhere);
    linkFolder(nowhere, path.join(allowed, 'out'));
    fs.rmSync(nowhere, { recursive: true, force: true });
    const report = await run.release();
    expect(report).toEqual([expect.objectContaining({ status: 'failed', error: PINNED_FOLDER_CHANGED })]);
    expect(fs.existsSync(nowhere)).toBe(false);
  });

  it('an unpinned file is saved where the work said, as before; pinning only works on a file of the open work', async () => {
    const dir = path.join(TMP, 'pin-none');
    const run = await runWithEffects('defer', async () => {
      await effects.writeFile({ dir, name: 'plain.txt', bytes: 'p' });
      await effects.email(msg('Not a file'), send);
      const email = (currentEffects() ?? []).find((e) => e.kind === 'email')!;
      await expect(pinFile(email, dir)).rejects.toThrow(/not a file this work asked to save/);
      await expect(pinFile(fileEffect(), 'relative/folder')).rejects.toThrow(/full folder path/);
    });
    await run.release();
    expect(fs.readFileSync(path.join(dir, 'plain.txt'), 'utf8')).toBe('p');
    // Outside the work, and after it ended: refused.
    await expect(pinFile(run.effects[0], dir)).rejects.toThrow(/only be pinned while the work/);
  });
});

describe('a scope whose caller checks the folders itself ({ pinFiles: true })', () => {
  const real = (p: string) => fs.realpathSync.native(p);
  const fileEffect = () => (currentEffects() ?? []).find((e) => e.kind === 'file')!;

  it('writeFile does not look at the disk; pinFile looks, once the folder is approved, and the preview says what it found', async () => {
    const dir = path.join(TMP, 'pinned-look');
    fs.mkdirSync(path.join(dir, 'taken'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.csv'), 'old');
    const looks = [vi.spyOn(fs.promises, 'stat'), vi.spyOn(fs.promises, 'lstat'), vi.spyOn(fs.promises, 'realpath')];
    const looked = () => looks.flatMap((s) => s.mock.calls.map(([p]) => String(p)));
    try {
      const run = await runWithEffects(
        'capture',
        async () => {
          const w = await effects.writeFile({ dir, name: 'old.csv', bytes: 'new' });
          // Not looked at yet: nothing known about what is there.
          expect(w).toMatchObject({ written: false, replaces: false });
          expect(looked().filter((p) => p.startsWith(dir))).toEqual([]);
          await pinFile(fileEffect(), real(dir));
          await effects.writeFile({ dir, name: 'taken', bytes: 'x' });
          const taken = (currentEffects() ?? []).filter((e) => e.kind === 'file')[1];
          await expect(pinFile(taken, real(dir))).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/There is a folder called "taken"/) });
        },
        { pinFiles: true },
      );
      expect(run.effects[0].summary).toBe(`Save old.csv (3 bytes) in ${dir}, replacing the file already there`);
      expect(run.effects[0].detail.replaces).toBe(true);
    } finally {
      for (const s of looks) s.mockRestore();
    }
    expect(fs.readFileSync(path.join(dir, 'old.csv'), 'utf8')).toBe('old');
  });

  it('release saves only pinned files: one never pinned is reported and not written anywhere', async () => {
    const dir = path.join(TMP, 'pinned-only');
    fs.mkdirSync(dir, { recursive: true });
    const run = await runWithEffects(
      'defer',
      async () => {
        await effects.writeFile({ dir, name: 'checked.txt', bytes: 'c' });
        await pinFile(fileEffect(), real(dir));
        // Asked for after the caller's last check: never pinned.
        await effects.writeFile({ dir, name: 'late.txt', bytes: 'l' });
      },
      { pinFiles: true },
    );
    const report = await run.release();
    expect(report.map((r) => [r.effect.detail.name, r.status, r.error])).toEqual([
      ['checked.txt', 'sent', null],
      ['late.txt', 'failed', FILE_NOT_CHECKED],
    ]);
    expect(fs.readdirSync(dir)).toEqual(['checked.txt']);
  });
});

describe('scopes', () => {
  it('two concurrent scopes do not mix, and a person sending meanwhile is not caught by either', async () => {
    const [a, b, c] = await Promise.all([
      runWithEffects('defer', async () => {
        await effects.email(msg('a1'), send);
        await delay(10);
        await effects.email(msg('a2'), send);
        return 'A';
      }),
      runWithEffects('capture', async () => {
        await delay(5);
        await effects.email(msg('b1'), send);
        await delay(10);
        await effects.email(msg('b2'), send);
        return 'B';
      }),
      (async () => {
        await delay(7);
        await effects.email(msg('person'), send);
      })(),
    ]);
    expect(c).toBeUndefined();
    expect(subjects()).toEqual(['person']);
    expect(a.effects.map((e) => e.detail.subject)).toEqual(['a1', 'a2']);
    expect(b.effects.map((e) => e.detail.subject)).toEqual(['b1', 'b2']);
    await b.release();
    expect(subjects()).toEqual(['person']);
    await a.release();
    expect(subjects()).toEqual(['person', 'a1', 'a2']);
  });

  it('nested scopes are refused', async () => {
    const run = await runWithEffects('defer', async () => {
      await expect(runWithEffects('capture', async () => 1)).rejects.toThrow(/cannot start inside/);
      await expect(runWithEffects('defer', async () => 1)).rejects.toThrow(/cannot start inside/);
      return 'outer';
    });
    expect(run.value).toBe('outer');
  });

  it('an effect asked for after the scope finished is refused, not sent', async () => {
    const late: { p: Promise<unknown> | null } = { p: null };
    const run = await runWithEffects('defer', async () => {
      late.p = delay(5).then(() => effects.email(msg('Late'), send));
    });
    await expect(late.p).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/after the work it belongs to had finished/) });
    expect(await run.release()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a file asked for while the work was finishing, and recorded after, is refused rather than lost', async () => {
    // writeFile looks at the disk before it records; the work finishes during that look.
    const late: { p: Promise<unknown> | null } = { p: null };
    const run = await runWithEffects('defer', () => {
      late.p = effects.writeFile({ dir: path.join(TMP, 'late'), name: 'x.txt', bytes: 'x' });
    });
    await expect(late.p).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(run.effects).toEqual([]);
    expect(await run.release()).toEqual([]);
    expect(fs.existsSync(path.join(TMP, 'late'))).toBe(false);
  });

  it('outsideEffects steps out of the scope (for long-lived timers), so its effects happen at once', async () => {
    const run = await runWithEffects('capture', async () => {
      await outsideEffects(() => effects.email(msg('Scheduled'), send));
      expect(currentEffectsMode()).toBe('capture');
    });
    expect(subjects()).toEqual(['Scheduled']);
    expect(run.effects).toEqual([]);
  });

  it('formats sizes in plain words', () => {
    expect([0, 1, 1023, 1024, 84 * 1024, 1.5 * 1024 * 1024, 12 * 1024 * 1024].map(formatSize)).toEqual([
      '0 bytes',
      '1 byte',
      '1023 bytes',
      '1 KB',
      '84 KB',
      '1.5 MB',
      '12 MB',
    ]);
  });
});

describe('a run that throws: nothing is released, and what it asked for stays readable', () => {
  it('a dry run stopped by a call to another computer still shows the email asked for before it', async () => {
    const fn = vi.fn(async () => 'answer');
    let thrown: unknown;
    try {
      await runWithEffects('capture', async () => {
        await effects.email(msg('Invoice 9'), send);
        await effects.network({ purpose: 'reading the statement', host: 'api.example.com' }, fn);
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EffectNotRunInPreview);
    expect(fn).not.toHaveBeenCalled();
    const failed = effectsOfFailedRun(thrown);
    expect(failed?.mode).toBe('capture');
    expect(failed?.effects.map((e) => e.summary)).toEqual([
      'Email to customer@globex.test: Invoice 9',
      'Contact api.example.com for reading the statement',
    ]);
    expect(failed?.ran).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a failed real run lists the calls to other computers that did happen, and sends nothing', async () => {
    const boom = new Error('the transaction rolled back');
    await expect(
      runWithEffects('defer', async () => {
        await effects.network({ purpose: 'reading the statement', host: 'api.example.com' }, async () => 'ok');
        await effects.email(msg('Never'), send);
        throw boom;
      }),
    ).rejects.toBe(boom);
    const failed = effectsOfFailedRun(boom);
    expect(failed?.effects.map((e) => e.kind)).toEqual(['network', 'email']);
    expect(failed?.ran).toEqual([
      expect.objectContaining({ status: 'sent', error: null, ranDuringOperation: true, effect: expect.objectContaining({ kind: 'network' }) }),
    ]);
    expect(sent).toEqual([]);
    expect(effectsOfFailedRun(new Error('another error'))).toBeNull();
    expect(effectsOfFailedRun('a thrown string')).toBeNull();
  });

  it('a call to another computer that fn did not wait for is reported as still running, not left out', async () => {
    const pending: { p: Promise<unknown> | null } = { p: null };
    const run = await runWithEffects('defer', () => {
      pending.p = effects.network({ purpose: 'checking for updates', host: 'updates.example.com' }, () => delay(30));
    });
    expect(await run.release()).toEqual([
      expect.objectContaining({ status: 'failed', error: STILL_RUNNING, ranDuringOperation: true }),
    ]);
    await pending.p;
  });
});

describe('the preview shows what is really sent', () => {
  it("reads recipients with nodemailer's own parser, so the preview and the delivery agree", async () => {
    // An escaped quote inside a quoted name: a naive splitter sees three recipients here.
    const to = '"Smith \\", J" <j@x.test>, k@x.test';
    const run = await runWithEffects('capture', () => effects.email(msg('Hi', { to }), send));
    expect(run.effects[0].summary).toBe('Email to j@x.test and k@x.test: Hi');
    expect(run.effects[0].detail.to).toEqual(['"Smith \\", J" <j@x.test>', 'k@x.test']);

    const transport = nodemailer.createTransport({ jsonTransport: true });
    const r = await effects.email(msg('Hi', { to }), (m) => transport.sendMail(m));
    expect((r.info as { envelope: { to: string[] } }).envelope.to).toEqual(['j@x.test', 'k@x.test']);
  });

  it('inside a scope, refuses an email that would go elsewhere or read a file as it goes out; outside, it sends as before', async () => {
    const cases: Array<Record<string, unknown>> = [
      { envelope: { from: 'books@acme.test', to: ['other@elsewhere.test'] } },
      { raw: 'To: other@elsewhere.test\r\nSubject: x\r\n\r\nhello' },
      { headers: { Bcc: 'other@elsewhere.test' } },
      { headers: [{ key: 'cc', value: 'other@elsewhere.test' }] },
      { attachments: [{ filename: 'a.pdf', path: 'C:\\private\\a.pdf' }] },
      { attachments: [{ href: 'https://elsewhere.test/x.pdf' }] },
      { attachments: [{ filename: 'a.txt', content: { path: '/etc/hosts' } }] },
      { attachments: [{ raw: 'Content-Type: text/plain\r\n\r\nx' }] },
      { attachments: ['not an attachment'] },
      { html: { path: 'C:\\private\\page.html' } },
      { alternatives: [{ contentType: 'text/x-web-markdown', href: 'https://elsewhere.test/a.md' }] },
      { to: 42 },
    ];
    for (const mode of ['capture', 'defer'] as const) {
      for (const extra of cases) {
        const run = await runWithEffects(mode, async () => {
          await expect(effects.email(msg('Bad', extra as Partial<EmailMessage>), send), JSON.stringify(extra)).rejects.toMatchObject({
            code: 'VALIDATION',
            message: expect.stringMatching(/^This email cannot be sent from an agent's work\. /),
          });
          expect(currentEffects()).toEqual([]);
        });
        expect(await run.release()).toEqual([]);
      }
    }
    expect(sent).toEqual([]);

    // Outside a scope nothing changes: the same message is handed to the mail server as it is.
    const r = await effects.email(msg('Person', { envelope: { from: 'books@acme.test', to: ['b@x.test'] } }), send);
    expect(r).toMatchObject({ sent: true, status: 'done', effect: { kind: 'email', summary: 'Email' } });
    expect(subjects()).toEqual(['Person']);
  });

  it('an attachment given as a data: link is its own content, so it is allowed', async () => {
    const run = await runWithEffects('capture', () =>
      effects.email(msg('Logo', { attachments: [{ filename: 'logo.png', path: 'data:image/png;base64,iVBORw0KGgo=' }] }), send),
    );
    expect(run.effects[0].summary).toBe('Email to customer@globex.test: Logo (1 attachment)');
  });

  it('summaries are one line, without invisible characters, of a sensible length; the detail keeps the full values', async () => {
    const subject = `Invoice\u202E 1042\nBcc: someone ${'x'.repeat(300)}`;
    const run = await runWithEffects('capture', async () => {
      await effects.email(msg(subject), send);
      await effects.print({ fileId: 'f1', name: 'Check\u202Efdp.exe', printer: 'Front\ndesk' });
      await effects.network({ purpose: 'reading\u200B the statement\r\n', host: 'api.example.com' }, () => 1).catch(() => undefined);
      await effects.writeFile({ dir: path.join(TMP, 'd'.repeat(200)), name: `${'n'.repeat(150)}.pdf`, bytes: 'x' });
    });
    for (const e of run.effects) {
      expect(e.summary).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      expect(e.summary.length).toBeLessThan(300);
    }
    expect(run.effects[0].summary).toMatch(/^Email to customer@globex\.test: Invoice 1042 Bcc: someone x+…$/);
    expect(run.effects[0].detail.subject).toBe(subject);
    expect(run.effects[1].summary).toBe('Print Checkfdp.exe on Front desk');
    expect(run.effects[2].summary).toBe('Contact api.example.com for reading the statement');
    // A long file name and folder keep both ends: the extension and the last folder show.
    expect(run.effects[3].summary).toMatch(/^Save n+…n+\.pdf \(1 byte\) in .+…d+$/);
    expect(run.effects[3].detail.name).toBe(`${'n'.repeat(150)}.pdf`);
  });
});

// ---------------------------------------------------------------------------
// lib/services/email.ts goes through the outbox: every caller is covered without a change
// ---------------------------------------------------------------------------

describe('sendMail (lib/services/email.ts) through the outbox', () => {
  const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-effects-email');
  const SMTP = { SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'Acme Books <books@acme.test>' };
  const savedEnv: Record<string, string | undefined> = {};
  const handed: Array<Record<string, unknown>> = [];
  let failWith: unknown = null;
  let realCreate: (options: Record<string, unknown>) => unknown;
  let mod: {
    db: import('@/lib/db').DB;
    ctx: import('@/lib/services/_base').ServiceContext;
    sendMail: typeof import('@/lib/services/email').sendMail;
    mailTransport: typeof import('@/lib/services/emailSettings').mailTransport;
    closeDb: typeof import('@/lib/db').closeDb;
  };
  const attachment = { filename: 'invoice-1042.pdf', content: Buffer.alloc(84 * 1024, 1), contentType: 'application/pdf' };
  const opts = () => ({ to: 'ap@globex.test', subject: 'Invoice 1042', text: 'Please find it attached.', attachments: [attachment] });

  beforeAll(async () => {
    for (const [k, v] of Object.entries(SMTP)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    const { getDb, closeDb } = await import('@/lib/db');
    const { users } = await import('@/lib/db/schema');
    const { createCompany } = await import('@/lib/services/company');
    const { sendMail } = await import('@/lib/services/email');
    const { mailTransport } = await import('@/lib/services/emailSettings');
    const db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'owner@effects.test', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Effects Co', ownerId: u.id });
    mod = { db, ctx: { db, companyId: company.id, userId: u.id }, sendMail, mailTransport, closeDb };
    realCreate = mailTransport.create;
    mailTransport.create = () =>
      ({
        sendMail: async (message: Record<string, unknown>) => {
          if (failWith) throw failWith;
          handed.push(message);
          return { messageId: 'test' };
        },
      }) as never;
  }, 180_000);

  beforeEach(() => {
    handed.length = 0;
    failWith = null;
  });

  afterAll(async () => {
    if (mod) mod.mailTransport.create = realCreate as never;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await mod?.closeDb(TEST_DIR).catch(() => undefined);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* Windows */
    }
  });

  it("a person's send (no scope) goes out at once with the same message and answer as before", async () => {
    const r = await mod.sendMail(opts(), mod.ctx);
    expect(r).toEqual({ from: 'books@acme.test', to: 'ap@globex.test' });
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({
      from: { name: 'Acme Books', address: 'books@acme.test' },
      to: 'ap@globex.test',
      subject: 'Invoice 1042',
      text: 'Please find it attached.',
      attachments: [attachment],
    });
  });

  it('a mail server failure is still thrown in plain words for a person', async () => {
    failWith = Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535 });
    await expect(mod.sendMail(opts(), mod.ctx)).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/refused the user name or password/),
    });
  });

  it('in a preview: the same answer, the email recorded, nothing handed to the mail server', async () => {
    const run = await runWithEffects('capture', () => mod.sendMail(opts(), mod.ctx));
    expect(run.value).toEqual({ from: 'books@acme.test', to: 'ap@globex.test' });
    expect(handed).toEqual([]);
    expect(run.effects).toHaveLength(1);
    expect(run.effects[0].summary).toBe('Email to ap@globex.test: Invoice 1042 (1 attachment, 84 KB)');
    expect(run.effects[0].detail).toMatchObject({ from: 'Acme Books <books@acme.test>', subject: 'Invoice 1042' });
  });

  it('in a real run: sent only after the transaction committed and release() ran; a rollback sends nothing', async () => {
    const run = await runWithEffects('defer', () =>
      mod.db.transaction(async (tx) => mod.sendMail(opts(), { ...mod.ctx, db: tx as never })),
    );
    expect(handed).toEqual([]);
    const report = await run.release();
    expect(report).toEqual([expect.objectContaining({ status: 'sent', error: null })]);
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ to: 'ap@globex.test', subject: 'Invoice 1042' });

    handed.length = 0;
    await expect(
      runWithEffects('defer', () =>
        mod.db.transaction(async (tx) => {
          await mod.sendMail(opts(), { ...mod.ctx, db: tx as never });
          throw new Error('rolled back');
        }),
      ),
    ).rejects.toThrow('rolled back');
    expect(handed).toEqual([]);
  });

  it('a mail server failure at release is reported in the same plain words, not thrown', async () => {
    const run = await runWithEffects('defer', () => mod.sendMail(opts(), mod.ctx));
    failWith = Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535 });
    const [r] = await run.release();
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/refused the user name or password/);
  });

  it('the checks still run in a preview: with no mail server the preview fails the way the send would', async () => {
    const host = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      await expect(runWithEffects('capture', () => mod.sendMail(opts(), mod.ctx))).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringMatching(/Preferences > Send Forms/),
      });
    } finally {
      process.env.SMTP_HOST = host;
    }
    expect(handed).toEqual([]);
  });
});
