'use client';

/**
 * Phone upload page (receipt capture), opened from the QR code on the desktop's "Send receipts
 * from your phone" page. No sign-in: the token in the address is the permission, and it can only
 * add receipts to one company's inbox for a few minutes. Runs without the app chrome (see BARE in
 * components/AppShell.tsx) and is let through by middleware.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Camera, CheckCircle2, FileUp, Receipt, XCircle } from 'lucide-react';

interface Status {
  companyName: string;
  expiresAt: string;
  remaining: number;
  maxBytes: number;
}

interface Sent {
  key: string;
  name: string;
  state: 'sending' | 'done' | 'error';
  error?: string;
}

export default function MobileReceiptUploadPage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch(`/api/receipts/mobile/${encodeURIComponent(token)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setProblem(body?.error ?? 'This link does not work any more.');
        return;
      }
      setStatus(body as Status);
      setProblem(null);
    } catch {
      setProblem('Could not reach Ironbooks. Check that your phone is connected to your tailnet (Tailscale) and try again.');
    }
  }, [token]);

  useEffect(() => {
    check();
  }, [check]);

  async function send(list: FileList | null) {
    if (!list?.length || !status) return;
    setBusy(true);
    let remaining = status.remaining;
    for (const file of Array.from(list)) {
      const key = `${Date.now()}-${Math.random()}`;
      const name = file.name || 'Photo';
      setSent((s) => [{ key, name, state: 'sending' }, ...s]);
      const update = (patch: Partial<Sent>) => setSent((s) => s.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      if (file.size > status.maxBytes) {
        update({ state: 'error', error: `Too big (over ${Math.floor(status.maxBytes / (1024 * 1024))} MB).` });
        continue;
      }
      try {
        const form = new FormData();
        form.append('file', file, name);
        const res = await fetch(`/api/receipts/mobile/${encodeURIComponent(token)}`, { method: 'POST', body: form });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          update({ state: 'error', error: body?.error ?? `Not sent (${res.status}).` });
          if (res.status === 410 || res.status === 404 || res.status === 403) {
            setProblem(body?.error ?? 'This link does not work any more.');
            break;
          }
          continue;
        }
        remaining = typeof body?.remaining === 'number' ? body.remaining : remaining - 1;
        update({ state: 'done' });
      } catch {
        update({ state: 'error', error: 'Could not reach Ironbooks.' });
      }
    }
    setStatus((s) => (s ? { ...s, remaining } : s));
    setBusy(false);
    if (cameraRef.current) cameraRef.current.value = '';
    if (pickRef.current) pickRef.current.value = '';
  }

  const minutesLeft = status ? Math.max(0, Math.round((new Date(status.expiresAt).getTime() - Date.now()) / 60000)) : 0;

  return (
    <main className="min-h-screen bg-offwhite px-4 py-6 text-navy">
      <div className="mx-auto max-w-md">
        <h1 className="mb-1 flex items-center gap-2 text-2xl font-extrabold">
          <Receipt className="h-7 w-7 text-electric" aria-hidden="true" /> Send receipts
        </h1>
        {status && !problem && (
          <p className="mb-6 text-sm text-navy/60">
            To <strong className="text-navy">{status.companyName}</strong> in Ironbooks · {status.remaining} left · about{' '}
            {minutesLeft} min left
          </p>
        )}

        {problem ? (
          <div role="alert" className="rounded-2xl bg-white p-5 shadow-xl">
            <p className="font-semibold">This link can&apos;t be used</p>
            <p className="mt-1 text-sm text-navy/70">{problem}</p>
          </div>
        ) : !status ? (
          <p className="text-sm text-navy/60" role="status">
            Checking the link…
          </p>
        ) : (
          <div className="space-y-3">
            <button
              type="button"
              disabled={busy || status.remaining <= 0}
              onClick={() => cameraRef.current?.click()}
              className="flex w-full items-center justify-center gap-3 rounded-2xl bg-electric px-5 py-5 text-lg font-bold text-white shadow-lg disabled:opacity-50 outline-none focus-visible:ring-4 focus-visible:ring-electric/40"
            >
              <Camera className="h-6 w-6" aria-hidden="true" /> Take a photo
            </button>
            <button
              type="button"
              disabled={busy || status.remaining <= 0}
              onClick={() => pickRef.current?.click()}
              className="flex w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-base font-semibold text-navy shadow disabled:opacity-50 outline-none focus-visible:ring-4 focus-visible:ring-electric/40"
            >
              <FileUp className="h-5 w-5" aria-hidden="true" /> Choose photos or PDFs
            </button>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              aria-label="Take a photo of a receipt"
              onChange={(e) => send(e.target.files)}
            />
            <input
              ref={pickRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
              multiple
              className="sr-only"
              aria-label="Choose receipt photos or PDF files"
              onChange={(e) => send(e.target.files)}
            />
            {status.remaining <= 0 && (
              <p className="text-sm text-navy/70">This link has been used for as many receipts as it allows. Make a new one on your computer.</p>
            )}
          </div>
        )}

        {sent.length > 0 && (
          <ul className="mt-6 space-y-2" aria-live="polite">
            {sent.map((s) => (
              <li key={s.key} className="flex items-start gap-2 rounded-xl bg-white px-4 py-3 text-sm shadow">
                {s.state === 'done' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden="true" />
                ) : s.state === 'error' ? (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
                ) : (
                  <span className="mt-1 h-3 w-3 shrink-0 animate-pulse rounded-full bg-electric" aria-hidden="true" />
                )}
                <span className="min-w-0">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="text-navy/60">
                    {s.state === 'done' ? 'Sent — it is in your Receipts inbox.' : s.state === 'error' ? s.error : 'Sending…'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-8 text-xs text-navy/50">
          Receipts go straight to the computer running Ironbooks over your private network. They are not sent to any cloud
          service.
        </p>
      </div>
    </main>
  );
}
