/**
 * Where a memorized report opens (Memorized Report List, Process Multiple Reports): a standard
 * report opens its page with the saved settings in the URL; a Report Builder report opens the
 * builder with its id (?mem=), and the builder loads and runs that saved setup.
 */
export interface MemorizedLink {
  id: string;
  reportType: string;
  config?: { params?: Record<string, string> } | null;
}

export function memorizedReportHref(r: MemorizedLink): string {
  if (r.reportType === 'custom') return `/reports/builder?mem=${encodeURIComponent(r.id)}`;
  const params = new URLSearchParams(r.config?.params ?? {});
  params.set('mem', r.id);
  return `/reports/std/${encodeURIComponent(r.reportType)}?${params.toString()}`;
}

/** The memorized report a page was opened for (?mem=), or null. */
export function memorizedIdFrom(search: string): string | null {
  const id = new URLSearchParams(search).get('mem');
  return id && id.trim() ? id.trim() : null;
}
