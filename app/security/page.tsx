'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button, Card, Input, Label, PageHeader, Spinner, toast } from '@/components/ui';
import { ChallengeQuestionCard } from '@/components/ChallengeQuestionCard';
import { api } from '@/lib/client';
import { safeAppPath } from '@/lib/nav';

interface Me {
  id: string;
  email: string;
  name: string | null;
  totpEnabled: boolean;
}

/** Only same-app paths for ?next= (never an open redirect, "/\evil.com" included). */
function safeNext(raw: string | null): string {
  return safeAppPath(raw, '/dashboard');
}

export default function SecurityPage() {
  // After sign-in, someone without a challenge question is sent here once (app/login).
  const [prompt, setPrompt] = useState<{ next: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('challenge') === '1') setPrompt({ next: safeNext(q.get('next')) });
  }, []);
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
      const r = await api.post<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/setup');
      setSecret(r.secret);
      setOtpUrl(r.otpauthUrl);
      toast('Scan or enter the secret in your authenticator app, then enter a code.', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'danger');
    } finally {
      setBusy(false);
    }
  }
  async function enable() {
    setBusy(true);
    try {
      await api.post('/api/auth/2fa/enable', { token: code });
      setEnabled(true);
      setCode('');
      toast('Two-factor authentication enabled.', 'success');
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
      toast('Two-factor authentication disabled.', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Security" icon={ShieldCheck} />
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
              <Button onClick={setup} loading={busy}>Set up authenticator</Button>
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
                  <Label>Enter a current code to disable</Label>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" />
                </div>
                <Button variant="danger" onClick={disable} loading={busy}>Disable 2FA</Button>
              </div>
            )}
          </>
        )}
      </Card>
    </main>
  );
}
