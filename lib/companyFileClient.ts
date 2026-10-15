/**
 * Renderer helpers for company-file exports shared by the Company File page and the desktop
 * File menu (components/DesktopBridge.tsx): Portable Company File (.bkp) and the shareable
 * ledger (.xlsx / .pdf).
 *
 * In the desktop shell the bytes go through window.bookkeeper.saveBytes (native Save dialog
 * with the right file-type filter); in a browser they fall back to an <a download>.
 */

interface SaveBytesBridge {
  saveBytes?: (opts: {
    defaultName: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    data: ArrayBuffer;
  }) => Promise<string | null>;
}

function bridge(): SaveBytesBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: SaveBytesBridge }).bookkeeper;
}

/** Pull the server's suggested name out of Content-Disposition (RFC 5987 form preferred). */
function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = cd.match(/filename="([^"]+)"/);
  return plain ? plain[1] : fallback;
}

/**
 * Fetch a file from the API and save it. Returns the saved path (desktop), the file name
 * (browser download), or null when the user cancelled the Save dialog. Throws with the
 * server's error message on failure.
 */
export async function fetchAndSave(
  url: string,
  fallbackName: string,
  filter: { name: string; extensions: string[] },
): Promise<string | null> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || 'The file could not be created.');
  }
  const name = filenameFrom(res, fallbackName);
  const data = await res.arrayBuffer();
  const b = bridge();
  if (b?.saveBytes) {
    return b.saveBytes({ defaultName: name, filters: [filter], data });
  }
  const blobUrl = URL.createObjectURL(new Blob([data]));
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = name;
  a.click();
  URL.revokeObjectURL(blobUrl);
  return name;
}

export function savePortableCompanyFile(): Promise<string | null> {
  return fetchAndSave('/api/portable', 'Company.bkp', {
    name: 'Ironbooks Portable Company File',
    extensions: ['bkp'],
  });
}

export function saveShareableLedger(format: 'xlsx' | 'pdf'): Promise<string | null> {
  return fetchAndSave(
    `/api/portable/shareable?format=${format}`,
    `ledger.${format}`,
    format === 'xlsx'
      ? { name: 'Excel Workbook', extensions: ['xlsx'] }
      : { name: 'PDF Document', extensions: ['pdf'] },
  );
}
