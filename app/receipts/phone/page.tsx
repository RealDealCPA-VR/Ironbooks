'use client';

/**
 * Send receipts from your phone (receipt capture). Shows a QR code for a short-lived upload link
 * that works for THIS company only: 15 minutes, up to 20 receipts, then it stops working. The
 * phone must reach this computer over your tailnet (or local network): in the desktop app that
 * means multi-user hosting is on (File > Host multi-user access, see /multi-user), which serves
 * the app on this computer's tailnet address. Receipts sent from the phone land in the inbox on
 * the Receipts page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowLeft, Smartphone, Wifi } from 'lucide-react';
import { Button, Card, Label, PageHeader, Select, toast, toastError } from '@/components/ui';
import { ReceiptStatusBadge, type ReceiptRow } from '@/components/ReceiptStatus';
import { api } from '@/lib/client';
import { mobileReceiptUrl } from '@/lib/receipts/mobilePath';
import { canDo, useMe } from '@/lib/usePermissions';

interface HostingStatus {
  available: boolean;
  hosting: boolean;
  urls: string[];
  remoteHost?: string | null;
}
interface HostingBridge {
  hosting?: { status: () => Promise<HostingStatus> };
}
function bridge(): HostingBridge | undefined {
  return (window as unknown as { bookkeeper?: HostingBridge }).bookkeeper;
}

interface Link_ {
  id: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  maxUploads: number;
  uploadCount: number;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;

/** Where a phone can reach this app: hosting URLs (desktop) or the address this page is open on. */
function useReachableOrigins(): { origins: string[]; reason: 'hosting-off' | 'loopback' | null; loading: boolean } {
  const [state, setState] = useState<{ origins: string[]; reason: 'hosting-off' | 'loopback' | null; loading: boolean }>({
    origins: [],
    reason: null,
    loading: true,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const here = window.location;
      const h = bridge()?.hosting;
      if (h) {
        try {
          const s = await h.status();
          if (cancelled) return;
          // Connected to another computer's company file: this page is already on its address.
          if (s.remoteHost) return setState({ origins: [here.origin], reason: null, loading: false });
          if (s.hosting && s.urls.length) return setState({ origins: s.urls, reason: null, loading: false });
          return setState({ origins: [], reason: 'hosting-off', loading: false });
        } catch {
          /* fall through to the page address */
        }
      }
      if (cancelled) return;
      if (LOOPBACK.test(here.hostname)) setState({ origins: [], reason: 'loopback', loading: false });
      else setState({ origins: [here.origin], reason: null, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function remaining(expiresAt: string, now: number): string {
  const s = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function PhoneUploadPage() {
  const { me } = useMe();
  const { origins, reason, loading } = useReachableOrigins();
  const [origin, setOrigin] = useState('');
  const [link, setLink] = useState<Link_ | null>(null);
  const [making, setMaking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [arrived, setArrived] = useState<ReceiptRow[]>([]);

  useEffect(() => {
    if (origins.length && !origin) setOrigin(origins[0]);
  }, [origins, origin]);

  const expired = link ? new Date(link.expiresAt).getTime() <= now : false;

  // Countdown, and pick up receipts arriving from the phone while the link is live.
  useEffect(() => {
    if (!link) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [link]);
  const poll = useCallback(async () => {
    if (!link) return;
    try {
      const d = await api.get<{ receipts: ReceiptRow[] }>('/api/receipts?status=open');
      const since = new Date(link.createdAt).getTime() - 5000;
      setArrived(d.receipts.filter((r) => r.source === 'phone' && new Date(r.createdAt).getTime() >= since));
    } catch {
      /* keep the last list */
    }
  }, [link]);
  useEffect(() => {
    if (!link || expired) return;
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [link, expired, poll]);

  async function makeLink() {
    setMaking(true);
    try {
      const l = await api.post<Link_>('/api/receipts/upload-links');
      setLink(l);
      setNow(Date.now());
      setArrived([]);
    } catch (err) {
      toastError(err, 'Could not make a phone link.');
    } finally {
      setMaking(false);
    }
  }

  async function stopLink() {
    if (!link) return;
    try {
      await api.del(`/api/receipts/upload-links/${link.id}`);
      toast('The phone link no longer works.', 'success');
      setLink(null);
    } catch (err) {
      toastError(err, 'Could not turn the link off.');
    }
  }

  const url = useMemo(() => (link && origin ? mobileReceiptUrl(origin, link.token) : ''), [link, origin]);
  const canAdd = canDo(me, 'lists', 'create');

  return (
    <div className="p-8 max-w-4xl mx-auto w-full">
      <Link href="/receipts" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-electric hover:underline">
        <ArrowLeft className="h-4 w-4" /> All receipts
      </Link>
      <PageHeader title="Send receipts from your phone" icon={Smartphone} />

      <Card className="p-6">
        <ol className="mb-5 list-decimal space-y-1 pl-5 text-sm text-navy/70">
          <li>Make a phone link and scan the code with your phone&apos;s camera.</li>
          <li>Take a photo of each receipt (or pick a PDF) and tap Send.</li>
          <li>The receipts appear in your Receipts inbox here, ready to review.</li>
        </ol>
        <p className="mb-5 text-sm text-navy/60">
          The link works for this company only, for 15 minutes and up to 20 receipts. Your phone sends the receipts straight
          to this computer over your private network (Tailscale) — they don&apos;t go through any cloud service.
        </p>

        {loading ? (
          <p className="text-sm text-navy/60">Checking how your phone can reach this computer…</p>
        ) : reason ? (
          <div role="status" className="rounded-lg bg-gold/15 p-4 text-sm text-yellow-900">
            <p className="flex items-center gap-2 font-semibold">
              <Wifi className="h-4 w-4" /> Your phone can&apos;t reach this computer yet
            </p>
            {reason === 'hosting-off' ? (
              <p className="mt-1">
                Turn on sharing so devices on your tailnet can connect: open{' '}
                <Link href="/multi-user" className="font-semibold text-electric hover:underline">
                  Multi-user
                </Link>{' '}
                (File &gt; Host multi-user access) and start hosting. Your phone also needs the Tailscale app, signed in to the
                same tailnet. Then come back to this page.
              </p>
            ) : (
              <p className="mt-1">
                This page is open on &ldquo;localhost&rdquo;, which only this computer can reach. Open Ironbooks through this
                computer&apos;s tailnet address (or turn on multi-user hosting in the desktop app), then make the link.
              </p>
            )}
          </div>
        ) : !canAdd ? (
          <p className="text-sm text-navy/60">Your role can&apos;t add documents. Ask your administrator.</p>
        ) : !link || expired ? (
          <div className="space-y-4">
            {origins.length > 1 && (
              <div className="max-w-md">
                <Label htmlFor="origin">Address your phone will use</Label>
                <Select id="origin" value={origin} onChange={(e) => setOrigin(e.target.value)}>
                  {origins.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {expired && <p className="text-sm text-navy/60">The last link expired.</p>}
            <Button onClick={makeLink} loading={making}>
              Make a phone link
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
            <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
              <QRCodeSVG value={url} size={220} level="M" role="img" aria-label="QR code for the phone upload link" />
            </div>
            <div className="min-w-0 flex-1 space-y-3 text-sm">
              <p aria-live="polite" className="font-semibold text-navy">
                Works for {remaining(link.expiresAt, now)} more · up to {link.maxUploads} receipts
              </p>
              <div>
                <Label htmlFor="link-url">Or open this address on the phone</Label>
                <input
                  id="link-url"
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-navy"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={stopLink}>
                  Turn this link off
                </Button>
                <Button variant="ghost" size="sm" onClick={makeLink} loading={making}>
                  Make a new link
                </Button>
              </div>
              <div>
                <h2 className="mb-2 font-semibold text-navy">Received from the phone</h2>
                {arrived.length === 0 ? (
                  <p className="text-navy/50">Nothing yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {arrived.map((r) => (
                      <li key={r.id} className="flex items-center gap-2">
                        <Link href={`/receipts/${r.id}`} className="font-medium text-electric hover:underline">
                          {r.filename}
                        </Link>
                        <ReceiptStatusBadge status={r.status} txnType={r.txnType} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
