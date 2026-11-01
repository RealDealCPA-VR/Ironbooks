'use client';
/**
 * Preferences > Send Forms: the mail server this company file sends forms through (prefsperms).
 *
 * Stored IN the company file (lib/services/emailSettings.ts), so it works on every computer that
 * opens the file and a desktop user never needs environment variables. The password is sealed
 * with the file's own secret and never comes back: the field shows "saved" instead.
 *
 *  - Save / Remove need Company & Preferences > Send Forms (email set-up): modify.
 *  - Test sends a short email through the typed settings (before saving) or the saved ones, and
 *    explains a failure in plain words. Without the set-up right the test goes to your own
 *    address only (My Preferences > Send Forms).
 *  - A mail server on the internet needs the company's opt-in for email (Privacy & Network).
 */
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, Mail, Send, Server, XCircle } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Input, Label, Select, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';

type Security = 'ssl' | 'starttls' | 'none';

interface EmailSetupView {
  source: 'file' | 'environment' | 'none';
  configured: boolean;
  host: string;
  port: number | null;
  security: Security;
  username: string;
  hasPassword: boolean;
  passwordReadable: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  bcc: string;
  useSenderAddress: boolean;
  lastTest: { at: string; ok: boolean; message: string } | null;
  environment: { host: string; port: number; from: string } | null;
}

interface TestResult {
  ok: boolean;
  message: string;
  to: string;
  from: string;
}

const SECURITY_OPTIONS: Array<[Security, string, number]> = [
  ['starttls', 'STARTTLS (usually port 587)', 587],
  ['ssl', 'SSL/TLS (usually port 465)', 465],
  ['none', 'None (a mail relay on your own network, usually port 25)', 25],
];

/** Common providers: fill the server, port and security in one click. */
const PRESETS: Array<{ label: string; host: string; port: number; security: Security; note: string }> = [
  { label: 'Microsoft 365 / Outlook.com', host: 'smtp.office365.com', port: 587, security: 'starttls', note: 'Sign in with your full email address.' },
  { label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 587, security: 'starttls', note: 'Use a Google "app password", not your normal password.' },
  { label: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl', note: 'Use a Yahoo "app password".' },
  { label: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587, security: 'starttls', note: 'Use an Apple "app-specific password".' },
];

interface Draft {
  host: string;
  port: string;
  security: Security;
  username: string;
  /** '' = keep the saved password. */
  password: string;
  removePassword: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  bcc: string;
  useSenderAddress: boolean;
}

function draftOf(v: EmailSetupView | null): Draft {
  return {
    host: v?.host ?? '',
    port: v?.port ? String(v.port) : '587',
    security: v?.security ?? 'starttls',
    username: v?.username ?? '',
    password: '',
    removePassword: false,
    fromName: v?.fromName ?? '',
    fromEmail: v?.fromEmail ?? '',
    replyTo: v?.replyTo ?? '',
    bcc: v?.bcc ?? '',
    useSenderAddress: v?.useSenderAddress ?? true,
  };
}

function payloadOf(d: Draft) {
  return {
    host: d.host.trim(),
    port: Number(d.port),
    security: d.security,
    username: d.username.trim() || null,
    // A typed password replaces the saved one; "remove" clears it; otherwise it is kept.
    ...(d.password ? { password: d.password } : d.removePassword ? { password: null } : {}),
    fromName: d.fromName.trim() || null,
    fromEmail: d.fromEmail.trim(),
    replyTo: d.replyTo.trim() || null,
    bcc: d.bcc.trim() || null,
    useSenderAddress: d.useSenderAddress,
  };
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function EmailServerSetup({ canEdit = true }: { canEdit?: boolean }) {
  const [view, setView] = React.useState<EmailSetupView | null>(null);
  const [forbidden, setForbidden] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [draft, setDraft] = React.useState<Draft>(draftOf(null));
  const [testTo, setTestTo] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [result, setResult] = React.useState<TestResult | null>(null);
  const [dirty, setDirty] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const v = await api.get<EmailSetupView>('/api/email/settings');
      setView(v);
      setDraft(draftOf(v));
      setDirty(false);
      setForbidden(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else toast(errorText(err, 'Could not load the email set-up.'), 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };

  async function save() {
    setSaving(true);
    try {
      const v = await api.put<EmailSetupView>('/api/email/settings', payloadOf(draft));
      setView(v);
      setDraft(draftOf(v));
      setDirty(false);
      toast('Email set-up saved. Use Test to check it.', 'success');
    } catch (err) {
      toast(errorText(err, 'Could not save the email set-up.'), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      // Typed but not saved settings are tested as typed (the saved password is reused when none is typed).
      const body = canEdit && !forbidden && dirty ? { to: testTo.trim() || null, draft: payloadOf(draft) } : { to: testTo.trim() || null };
      const r = await api.post<TestResult>('/api/email/test', body);
      setResult(r);
      if (!(canEdit && !forbidden && dirty)) void load();
    } catch (err) {
      setResult({ ok: false, message: errorText(err, 'The test could not run.'), to: testTo, from: '' });
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      const v = await api.del<EmailSetupView>('/api/email/settings');
      setView(v);
      setDraft(draftOf(v));
      setDirty(false);
      setResult(null);
      toast('The mail server was removed from this company file.', 'success');
    } catch (err) {
      toast(errorText(err, 'Could not remove the email set-up.'), 'danger');
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  if (loading) {
    return (
      <Card className="p-8">
        <p className="text-sm text-navy/50">Loading the email set-up…</p>
      </Card>
    );
  }

  const readOnly = !canEdit || forbidden;
  const portNum = Number(draft.port);
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const ready = draft.host.trim() !== '' && portOk && draft.fromEmail.trim() !== '';

  return (
    <Card className="p-8">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
          <Server className="h-5 w-5 text-electric" aria-hidden="true" /> Email set-up (mail server)
        </h2>
        {view && (
          <Badge tone={view.configured ? 'success' : 'warning'}>
            {view.configured
              ? view.source === 'file'
                ? 'Ready: set up in this company file'
                : 'Ready: set up on this computer'
              : 'Not set up'}
          </Badge>
        )}
      </div>
      <p className="mb-5 text-sm text-navy/50">
        Ironbooks emails invoices, estimates, statements, purchase orders and payment reminders through your own
        email account. The settings are saved in this company file, so they work on every computer that opens it.
        The password is stored encrypted and is never shown again.
      </p>

      {forbidden && (
        <p className="mb-5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-navy/70" role="note">
          Only someone allowed to set up email (Users &amp; Roles: Company &amp; Preferences &gt; Send Forms) can see or
          change the mail server. You can still send yourself a test email below, and choose your own sender address
          under My Preferences.
        </p>
      )}

      {view && view.hasPassword && !view.passwordReadable && (
        <p className="mb-5 rounded-lg border border-gold/40 bg-gold/10 p-3 text-sm text-navy/80" role="alert">
          The mail server password was saved in another copy of this company file and cannot be read here (for
          example, this is an Accountant&apos;s Copy). Type the password again and save.
        </p>
      )}

      {view && view.source !== 'file' && view.environment && (
        <p className="mb-5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-navy/70" role="note">
          This computer already sends email through {view.environment.host} (port {view.environment.port}) from{' '}
          {view.environment.from}, set up by whoever installed Ironbooks. A mail server saved here takes its place for
          this company file.
        </p>
      )}

      {!forbidden && (
        <>
          {!readOnly && (
            <div className="mb-5">
              <Label htmlFor="mail-preset">Fill in for a common provider (optional)</Label>
              <Select
                id="mail-preset"
                value=""
                onChange={(e) => {
                  const p = PRESETS.find((x) => x.label === e.target.value);
                  if (!p) return;
                  setDraft((d) => ({ ...d, host: p.host, port: String(p.port), security: p.security }));
                  setDirty(true);
                  toast(`${p.label}: ${p.note}`, 'info');
                }}
                className="max-w-sm"
              >
                <option value="">Choose a provider…</option>
                {PRESETS.map((p) => (
                  <option key={p.label} value={p.label}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
            <legend className="sr-only">Mail server</legend>
            <div>
              <Label htmlFor="mail-host">Mail server (SMTP)</Label>
              <Input
                id="mail-host"
                value={draft.host}
                placeholder="smtp.office365.com"
                autoComplete="off"
                onChange={(e) => set('host', e.target.value)}
              />
            </div>
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <div>
                <Label htmlFor="mail-port">Port</Label>
                <Input id="mail-port" inputMode="numeric" value={draft.port} onChange={(e) => set('port', e.target.value.replace(/[^0-9]/g, ''))} />
              </div>
              <div>
                <Label htmlFor="mail-security">Connection security</Label>
                <Select
                  id="mail-security"
                  value={draft.security}
                  onChange={(e) => {
                    const sec = e.target.value as Security;
                    const def = SECURITY_OPTIONS.find(([s]) => s === sec)?.[2];
                    setDraft((d) => ({
                      ...d,
                      security: sec,
                      // Switch the port along with the security when it was still a standard one.
                      port: ['25', '465', '587', ''].includes(d.port) && def ? String(def) : d.port,
                    }));
                    setDirty(true);
                  }}
                >
                  {SECURITY_OPTIONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="mail-user">User name</Label>
              <Input
                id="mail-user"
                value={draft.username}
                placeholder="you@yourcompany.com"
                autoComplete="off"
                onChange={(e) => set('username', e.target.value)}
              />
              <p className="mt-1 text-xs text-navy/50">Usually your full email address. Leave blank for a relay that needs no sign-in.</p>
            </div>
            <div>
              <Label htmlFor="mail-pass">Password</Label>
              <Input
                id="mail-pass"
                type="password"
                value={draft.password}
                autoComplete="new-password"
                placeholder={view?.hasPassword && !draft.removePassword ? 'Saved (type to replace)' : ''}
                onChange={(e) => {
                  set('password', e.target.value);
                  if (e.target.value) set('removePassword', false);
                }}
              />
              {view?.hasPassword && !draft.password && (
                <label className="mt-1 flex items-center gap-2 text-xs text-navy/60">
                  <input
                    type="checkbox"
                    checked={draft.removePassword}
                    onChange={(e) => set('removePassword', e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  Remove the saved password
                </label>
              )}
              <p className="mt-1 text-xs text-navy/50">Gmail, Outlook.com and Yahoo need an &quot;app password&quot; here.</p>
            </div>
            <div>
              <Label htmlFor="mail-from-name">Send as (name)</Label>
              <Input id="mail-from-name" value={draft.fromName} placeholder="Your company name" onChange={(e) => set('fromName', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="mail-from">Send from (email address)</Label>
              <Input id="mail-from" type="email" value={draft.fromEmail} placeholder="billing@yourcompany.com" onChange={(e) => set('fromEmail', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="mail-reply">Replies go to (optional)</Label>
              <Input id="mail-reply" type="email" value={draft.replyTo} onChange={(e) => set('replyTo', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="mail-bcc">Always send a copy to (optional)</Label>
              <Input id="mail-bcc" value={draft.bcc} placeholder="books@yourcompany.com" onChange={(e) => set('bcc', e.target.value)} />
              <p className="mt-1 text-xs text-navy/50">Separate several addresses with commas.</p>
            </div>
            <div className="sm:col-span-2 flex items-start gap-3">
              <input
                id="mail-own-sender"
                type="checkbox"
                checked={draft.useSenderAddress}
                onChange={(e) => set('useSenderAddress', e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-electric focus:ring-electric"
              />
              <div>
                <Label htmlFor="mail-own-sender" className="mb-0 cursor-pointer">
                  Let each person send from their own address
                </Label>
                <p className="mt-0.5 text-xs text-navy/50">
                  When someone sets a sender address under My Preferences &gt; Send Forms, their emails come from it;
                  otherwise they come from the address above with replies to that person. Your mail server must allow
                  it (Test checks).
                </p>
              </div>
            </div>
          </fieldset>
        </>
      )}

      <div className="mt-6 rounded-xl border border-slate-200 p-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-navy">
          <Send className="h-4 w-4 text-electric" aria-hidden="true" /> Test
        </h3>
        {!readOnly ? (
          <div className="max-w-sm">
            <Label htmlFor="mail-test-to">Send the test email to</Label>
            <Input id="mail-test-to" type="email" value={testTo} placeholder="Your own address" onChange={(e) => setTestTo(e.target.value)} />
          </div>
        ) : (
          <p className="text-sm text-navy/60">The test email is sent to your own address.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void test()} loading={testing} disabled={!readOnly && !ready}>
            <Mail className="h-4 w-4" aria-hidden="true" /> {dirty && !readOnly ? 'Test these settings' : 'Send a test email'}
          </Button>
          {view?.lastTest && !result && (
            <span className="text-xs text-navy/50">
              Last test {new Date(view.lastTest.at).toLocaleString()}: {view.lastTest.ok ? 'worked' : 'failed'}.
            </span>
          )}
        </div>
        {result && (
          <p
            role="status"
            className={`mt-3 flex items-start gap-2 rounded-lg p-3 text-sm ${result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}
          >
            {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
            <span>{result.message}</span>
          </p>
        )}
        <p className="mt-3 text-xs text-navy/50">
          A mail server on the internet (Microsoft 365, Gmail…) also needs the company to allow email under{' '}
          <Link href="/privacy" className="font-semibold text-electric hover:underline">
            Privacy &amp; Network
          </Link>
          ; a mail relay on your own network does not. Nothing is sent from a practice copy (sandbox).
        </p>
      </div>

      {!readOnly && (
        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={() => void save()} loading={saving} disabled={!ready}>
            Save email set-up
          </Button>
          {view?.source === 'file' && (
            <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
              Remove the mail server
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="Remove the mail server?"
        message="Ironbooks will stop sending email from this company file until a mail server is set up again."
        confirmLabel="Remove"
        tone="danger"
        loading={removing}
        onConfirm={() => void remove()}
        onClose={() => setConfirmRemove(false)}
      />
    </Card>
  );
}
