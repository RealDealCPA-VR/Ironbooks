/**
 * Renderer helpers for the Accountant's Copy and Period Copy pages: POST a request whose answer
 * is a file and save it — through the desktop shell's native Save dialog when available
 * (window.bookkeeper.saveBytes), otherwise as a browser download.
 */

interface SaveBytesBridge {
  saveBytes?: (opts: {
    defaultName: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    data: ArrayBuffer;
  }) => Promise<string | null>;
  isDesktop?: boolean;
  company?: { switch?: (dir: string) => Promise<unknown> };
}

export function desktopBridge(): SaveBytesBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: SaveBytesBridge }).bookkeeper;
}

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

export interface SavedFile {
  /** Saved path (desktop) or file name (browser); null when the Save dialog was cancelled. */
  saved: string | null;
  name: string;
  headers: Headers;
}

/** POST JSON, save the file the server answers with. Throws with the server's message on failure. */
export async function postAndSave(
  url: string,
  body: unknown,
  fallbackName: string,
  filter: { name: string; extensions: string[] },
): Promise<SavedFile> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || 'The file could not be created.');
  }
  const name = filenameFrom(res, fallbackName);
  const data = await res.arrayBuffer();
  const b = desktopBridge();
  if (b?.saveBytes) {
    return { saved: await b.saveBytes({ defaultName: name, filters: [filter], data }), name, headers: res.headers };
  }
  const blobUrl = URL.createObjectURL(new Blob([data]));
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = name;
  a.click();
  URL.revokeObjectURL(blobUrl);
  return { saved: name, name, headers: res.headers };
}

/** "Mar 31, 2026" for a 'YYYY-MM-DD' calendar date. */
export function niceDate(ymd: string | null | undefined): string {
  if (!ymd) return '';
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00.000Z`);
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
