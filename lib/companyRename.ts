/**
 * The open company was renamed (Company Information, or Manage companies): the header's company
 * chip and the window title follow at once instead of after the next reload. Read from the API
 * client's after-save hook (components/PreferenceBehaviors.tsx); pure, so it is unit-tested.
 */

export const COMPANY_RENAMED_EVENT = 'ironbooks:company-renamed';

export interface CompanyRenamed {
  /** The renamed company's id; null when the save was for the open company (PATCH /api/company). */
  id: string | null;
  name: string;
}

/** The rename a successful save made, or null when the save did not rename a company. */
export function companyRenameFrom(
  info: { method: string; path: string; body: unknown },
  data: unknown,
): CompanyRenamed | null {
  if (info.method !== 'PATCH' && info.method !== 'PUT') return null;
  // Only a save that sent a name renames (settings saves without one leave the name alone).
  const sent = info.body && typeof info.body === 'object' ? (info.body as { name?: unknown }).name : undefined;
  if (typeof sent !== 'string' || !sent.trim()) return null;
  // The name as the server stored it, when the answer has one.
  const saved = data && typeof data === 'object' ? (data as { name?: unknown }).name : undefined;
  const name = typeof saved === 'string' && saved.trim() ? saved : sent.trim();
  if (info.path === '/api/company') return { id: null, name };
  const m = /^\/api\/companies\/([^/]+)$/.exec(info.path);
  return m ? { id: decodeURIComponent(m[1]), name } : null;
}
