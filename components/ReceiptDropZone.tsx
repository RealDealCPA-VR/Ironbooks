'use client';

/**
 * Global receipt drop zone (receipt capture). Drag a photo or PDF of a receipt anywhere in the
 * app and drop it: it goes into the Doc Center inbox as a receipt and is read on this computer.
 *
 * Plays nicely with screens that have their own drop targets (attachment panels, imports): if
 * the element under the pointer already handled the drag (preventDefault), this stays out of the
 * way, and file inputs keep their normal behaviour.
 */
import * as React from 'react';
import Link from 'next/link';
import { Receipt, X } from 'lucide-react';
import { RECEIPT_MAX_BYTES } from '@/lib/receipts/files';

export interface UploadedReceipt {
  id: string;
  filename: string;
  status: string;
}

/** Event other screens (the Receipts page) listen to, to refresh after an upload. */
export const RECEIPTS_UPLOADED_EVENT = 'bka:receipts-uploaded';

const ACCEPTED = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;
const ACCEPTED_TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;

export function looksLikeReceiptFile(f: { name: string; type: string }): boolean {
  return ACCEPTED_TYPES.test(f.type) || ACCEPTED.test(f.name);
}

/** Upload files to the receipts inbox, one request each. Returns what was added and what failed. */
export async function uploadReceiptFiles(
  files: File[],
): Promise<{ added: UploadedReceipt[]; failed: { name: string; error: string }[] }> {
  const added: UploadedReceipt[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const file of files) {
    if (!looksLikeReceiptFile(file)) {
      failed.push({ name: file.name, error: 'Only photos (JPG, PNG, HEIC) and PDF files can be added as receipts.' });
      continue;
    }
    if (file.size > RECEIPT_MAX_BYTES) {
      failed.push({ name: file.name, error: 'That file is bigger than 25 MB.' });
      continue;
    }
    const form = new FormData();
    form.append('file', file, file.name);
    try {
      const res = await fetch('/api/receipts', { method: 'POST', body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        failed.push({ name: file.name, error: body?.error || `Upload failed (${res.status}).` });
        continue;
      }
      added.push(body.receipt as UploadedReceipt);
    } catch {
      failed.push({ name: file.name, error: 'Could not reach Ironbooks.' });
    }
  }
  if (added.length && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RECEIPTS_UPLOADED_EVENT, { detail: added }));
  }
  return { added, failed };
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

function isOwnDropTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  return Boolean(el?.closest('input[type="file"], [data-own-drop]'));
}

export default function ReceiptDropZone({ enabled }: { enabled: boolean }) {
  const [dragging, setDragging] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ added: UploadedReceipt[]; failed: { name: string; error: string }[] } | null>(null);
  const depth = React.useRef(0);

  React.useEffect(() => {
    if (!enabled) return;
    function onEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    }
    function onOver(e: DragEvent) {
      if (!hasFiles(e)) return;
      // A screen's own drop target (or a file input) takes the file instead.
      if (e.defaultPrevented || isOwnDropTarget(e.target)) {
        setDragging(false);
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    }
    function onLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    }
    async function onDrop(e: DragEvent) {
      depth.current = 0;
      setDragging(false);
      if (!hasFiles(e) || e.defaultPrevented || isOwnDropTarget(e.target)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      setBusy(true);
      setResult(null);
      try {
        setResult(await uploadReceiptFiles(files));
      } finally {
        setBusy(false);
      }
    }
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [enabled]);

  // The result note fades after a while unless something failed.
  React.useEffect(() => {
    if (!result || result.failed.length) return;
    const t = setTimeout(() => setResult(null), 12000);
    return () => clearTimeout(t);
  }, [result]);

  if (!enabled) return null;

  return (
    <>
      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 bottom-0 top-[var(--titlebar-h)] z-[90] flex items-center justify-center bg-black/30 backdrop-blur-[1px]"
        >
          <div className="rounded-2xl border-4 border-dashed border-white/80 bg-white/95 px-10 py-8 text-center shadow-2xl">
            <Receipt className="mx-auto mb-3 h-10 w-10 text-electric" />
            <p className="text-lg font-bold text-navy">Drop to add a receipt</p>
            <p className="mt-1 text-sm text-navy/60">Photos (JPG, PNG, HEIC) or PDF. It is read on this computer.</p>
          </div>
        </div>
      )}
      <div aria-live="polite" className="fixed bottom-4 right-4 z-[80] w-80 max-w-[calc(100vw-2rem)]">
        {(busy || result) && (
          <div className="rounded-2xl border border-slate-100 bg-white p-4 text-sm shadow-2xl">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-navy">
                {busy
                  ? 'Adding receipt…'
                  : result && result.added.length
                    ? `${result.added.length === 1 ? 'Receipt' : `${result.added.length} receipts`} added to your inbox`
                    : 'Nothing was added'}
              </p>
              {!busy && (
                <button
                  type="button"
                  onClick={() => setResult(null)}
                  className="rounded p-0.5 text-navy/40 hover:text-navy outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {result?.added.length === 1 && (
              <Link href={`/receipts/${result.added[0].id}`} className="mt-2 inline-block font-semibold text-electric hover:underline" onClick={() => setResult(null)}>
                Review it now
              </Link>
            )}
            {result && result.added.length > 1 && (
              <Link href="/receipts" className="mt-2 inline-block font-semibold text-electric hover:underline" onClick={() => setResult(null)}>
                Review receipts
              </Link>
            )}
            {result?.failed.map((f) => (
              <p key={f.name} className="mt-2 text-red-600">
                {f.name}: {f.error}
              </p>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
