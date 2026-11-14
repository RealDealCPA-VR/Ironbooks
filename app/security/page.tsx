'use client';
/**
 * Company > Security: the company file's own passwords (filecrypto: protect the file, who can
 * open it, the recovery key), your challenge question, and two-factor sign-in.
 * ?protect=1 (an Admin just signed in to an unprotected file) highlights the protection offer;
 * ?challenge=1 asks for a challenge question. ?next= continues afterwards.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Copy, Download, KeyRound, ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button, Card, Input, Label, PageHeader, Spinner, toast } from '@/components/ui';
import { ChallengeQuestionCard } from '@/components/ChallengeQuestionCard';
import { FileProtectionCard } from '@/components/FileProtectionCard';
import { ApiError, api } from '@/lib/client';
// Only same-app paths for ?next= (never an open redirect).
import { safeNext } from '@/lib/safeNext';

interface Me {
  id: string;
  email: string;
  name: string | null;
  totpEnabled: boolean;
}


export default function SecurityPage() {
  // After sign-in, someone without a challenge question is sent here once (app/login).
  const [prompt, setPrompt] = useState<{ next: string } | null>(null);
  /** Two-factor setup asks for the current password first. */
  const [setupPassword, setSetupPassword] = useState('');
  const [protectPrompt, setProtectPrompt] = useState<{ next: string } | null>(null);
  // prefsperms: signed in with a one-time recovery code (app/login) - how many are left.
  const [recovered, setRecovered] = useState<{ left: number; next: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('challenge') === '1') setPrompt({ next: safeNext(q.get('next')) });
    if (q.get('protect') === '1') setProtectPrompt({ next: safeNext(q.get('next')) });
    const r = q.get('recovered');
    if (r !== null) setRecovered({ left: Math.max(0, Number(r) || 0), next: safeNext(q.get('next')) });
  }, []);
  // Recovery codes: shown once (after turning 2FA on or making new ones); the count otherwise.
  const [shownCodes, setShownCodes] = useState<string[] | null>(null);
  const [codesLeft, setCodesLeft] = useState<number | null>(null);
  const [renewCode, setRenewCode] = useState('');
  const [secret, setSecret] = useState('');
  const [otpUrl, setOtpUrl] = useState('');
  const [code, setCode] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Initialize from the server so a refresh doesn't offer "Set up authenticator"
  // (which would regenerate the secret) to a user who already has 2FA on.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.get<Me | null>('/api/auth/me');
        if (!cancelled) setEnabled(!!me?.totpEnabled);
        if (me?.totpEnabled) {
          const rc = await api.get<{ remaining: number }>('/api/auth/2fa/recovery-codes').catch(() => null);
          if (!cancelled && rc) setCodesLeft(rc.remaining);
        }
      } catch {
        // Treat as not-enabled; the enable/disable calls still verify server-side.
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function setup() {
    setBusy(true);
    try {
      const r = await api.post<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/setup', { currentPassword: setupPassword });
      setSetupPassword('');
      setSecret(r.secret);
      setOtpUrl(r.otpauthUrl);
      toast('Scan or enter the secret in your authenticator app, then enter a code.', 'info');
    } catch (e) {
      // 409: two-factor sign-in is already on (the server never replaces a live secret).
      if (e instanceof ApiError && e.status === 409) setEnabled(true);
      toast(e instanceof Error ? e.message : 'Failed', 'danger');
    } finally {
      setBusy(false);
    }
  }
  async function enable() {
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes?: string[] }>('/api/auth/2fa/enable', { token: code });
      setEnabled(true);
      setCode('');
      setShownCodes(r?.recoveryCodes ?? null);
      setCodesLeft(r?.recoveryCodes?.length ?? null);
      toast('Two-factor authentication enabled. Save your recovery codes.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Invalid code', 'danger');
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    try {
      await api.post('/api/auth/2fa/disable', { token: code });
      setEnabled(false);
      setSecret('');
      setOtpUrl('');
      setCode('');
      setShownCodes(null);
      setCodesLeft(null);
      toast('Two-factor authentication disabled.', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function renewCodes() {
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery-codes', { token: renewCode });
      setShownCodes(r.recoveryCodes);
      setCodesLeft(r.recoveryCodes.length);
      setRenewCode('');
      toast('New recovery codes made. The old ones no longer work.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'danger');
    } finally {
      setBusy(false);
    }
  }
  function downloadCodes() {
    if (!shownCodes) return;
    const text = `Ironbooks two-factor recovery codes\nEach code works once, instead of the code from your authenticator app.\n\n${shownCodes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Ironbooks recovery codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Security" icon={ShieldCheck} />
      {recovered && (
        <Card className="mb-6 max-w-xl border-amber-300 bg-amber-50 p-4 text-sm text-navy" role="status">
          <p className="font-semibold">You signed in with a recovery code. {recovered.left} left.</p>
          <p className="mt-1 text-navy/70">
            Got a new phone? Turn two-factor sign-in off below with another recovery code, then set it up again. Or make
            new recovery codes so you do not run out.
          </p>
          <a href={recovered.next} className="mt-2 inline-block font-semibold text-electric hover:underline">
            Continue without changing anything
          </a>
        </Card>
      )}
      <div className="mb-6">
        <FileProtectionCard
          key={protectPrompt ? 'prompt' : 'page'}
          highlight={Boolean(protectPrompt)}
          onDone={protectPrompt ? () => (window.location.href = protectPrompt.next) : undefined}
        />
        {protectPrompt && (
          <p className="mt-2 max-w-xl text-sm">
            <Link href={protectPrompt.next} className="text-electric hover:underline">
              Continue without protecting the file
            </Link>
          </p>
        )}
      </div>
      <div className="mb-6">
        <ChallengeQuestionCard
          prompt={Boolean(prompt)}
          onDone={prompt ? () => (window.location.href = prompt.next) : undefined}
        />
      </div>
      <Card className="p-6 max-w-xl">
        <h2 className="text-lg font-bold text-navy mb-1">Two-Factor Authentication (TOTP)</h2>
        <p className="text-sm text-navy/50 mb-4">
          Add a second step at sign-in using Google Authenticator, Authy, or 1Password.
        </p>

        {statusLoading ? (
          <div className="flex items-center gap-2 text-navy/40 text-sm py-2">
            <Spinner className="h-4 w-4" /> Checking 2FA status…
          </div>
        ) : (
          <>
            {!secret && !enabled && (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="setup-password">Your current password</Label>
                  <Input
                    id="setup-password"
                    type="password"
                    autoComplete="current-password"
                    value={setupPassword}
                    onChange={(e) => setSetupPassword(e.target.value)}
                    className="w-64"
                  />
                </div>
                <Button onClick={setup} loading={busy} disabled={!setupPassword}>
                  Set up authenticator
                </Button>
              </div>
            )}

            {secret && !enabled && (
              <div className="space-y-3">
                <div>
                  <Label>Scan with your authenticator app</Label>
                  <div className="inline-block rounded-lg border border-slate-200 bg-white p-3">
                    <QRCodeSVG value={otpUrl} size={168} aria-label="2FA setup QR code" />
                  </div>
                </div>
                <div>
                  <Label>Or enter the secret key manually</Label>
                  <code className="block bg-navy/5 rounded-lg px-3 py-2 text-navy font-mono text-sm break-all">{secret}</code>
                </div>
                <div>
                  <Label>Enter the 6-digit code to confirm</Label>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" />
                </div>
                <Button onClick={enable} loading={busy} disabled={code.length < 6}>Enable 2FA</Button>
              </div>
            )}

            {enabled && (
              <div className="space-y-3">
                <p className="flex items-center gap-2 text-emerald font-semibold">
                  <CheckCircle2 className="h-5 w-5" /> Two-factor authentication is enabled.
                </p>
                <div>
                  <Label htmlFor="tfa-off">Enter a current code (or a recovery code) to disable</Label>
                  <Input id="tfa-off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" spellCheck={false} />
                </div>
                <Button variant="danger" onClick={disable} loading={busy}>Disable 2FA</Button>
              </div>
            )}
          </>
        )}
      </Card>
      {enabled && (
        <Card className="mt-6 max-w-xl p-6">
          <h2 className="mb-1 flex items-center gap-2 text-lg font-bold text-navy">
            <KeyRound className="h-5 w-5" /> Recovery codes
          </h2>
          <p className="mb-4 text-sm text-navy/60">
            If you lose your phone or authenticator app, type one of these at sign-in instead of the 6-digit code. Each
            works once. Keep them somewhere safe, away from your computer. If you lose both, another Admin must turn off
            your two-factor sign-in.
          </p>
          {shownCodes ? (
            <div className="space-y-3">
              <ol className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-white p-4 font-mono text-sm text-navy" aria-label="Your recovery codes">
                {shownCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
              <p className="text-xs font-semibold text-amber-700">These codes are shown only now. Save or print them before you leave this page.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(shownCodes.join('\n')).then(
                      () => toast('Recovery codes copied.', 'success'),
                      () => toast('Could not copy. Select the codes and copy them instead.', 'danger'),
                    );
                  }}
                >
                  <Copy className="h-4 w-4" /> Copy
                </Button>
                <Button variant="secondary" onClick={downloadCodes}>
                  <Download className="h-4 w-4" /> Download as text
                </Button>
                <Button variant="secondary" onClick={() => window.print()}>
                  Print
                </Button>
                <Button onClick={() => setShownCodes(null)}>I saved them</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-navy">
                {codesLeft === null ? 'Checking...' : `${codesLeft} of 10 recovery codes left.`}
              </p>
              <div>
                <Label htmlFor="tfa-renew">To make new codes, enter a current code from your authenticator app</Label>
                <Input id="tfa-renew" value={renewCode} onChange={(e) => setRenewCode(e.target.value)} placeholder="123456" inputMode="numeric" />
              </div>
              <Button variant="secondary" onClick={renewCodes} loading={busy} disabled={renewCode.trim().length < 6}>
                Make new recovery codes
              </Button>
            </div>
          )}
        </Card>
      )}
    </main>
  );
}
