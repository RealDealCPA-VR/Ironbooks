/**
 * Client-side helpers for the AI layer (browser-safe: no node imports).
 */
import { api } from '@/lib/client';

export interface PrefillLine {
  accountId: string;
  classId: string | null;
  customerId: string | null;
  jobId: string | null;
  confidence: number;
}

export interface PrefillResult {
  source: 'vendor-default' | 'last-used' | 'learned' | 'none';
  lines: PrefillLine[];
}

export const PREFILL_SOURCE_LABEL: Record<PrefillResult['source'], string> = {
  'vendor-default': "from the vendor's default account",
  'last-used': 'from the last transaction with this vendor',
  learned: 'learned from your past categorizations',
  none: '',
};

/**
 * QB "pre-fill accounts for vendor". Best-effort: returns null on any failure so forms
 * never break because the AI layer is unavailable.
 */
export async function fetchVendorPrefill(q: { vendorId?: string; payee?: string }): Promise<PrefillResult | null> {
  const params = new URLSearchParams();
  if (q.vendorId) params.set('vendorId', q.vendorId);
  else if (q.payee?.trim()) params.set('payee', q.payee.trim());
  else return null;
  try {
    const r = await api.get<PrefillResult>(`/api/ai/prefill?${params.toString()}`);
    return r.lines.length ? r : null;
  } catch {
    return null;
  }
}
