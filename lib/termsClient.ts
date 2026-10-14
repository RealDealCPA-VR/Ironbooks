/**
 * Browser helpers for the Terms list on invoice and bill forms (B5).
 *
 *  - useTermsChoices — the company's active Terms list entries (custom "Net 45", date-driven
 *    "15th of month", …) as form choices. `value` is what documents and parties store in their
 *    `terms` varchar (the entry's code, else its name).
 *  - fetchDueDateForTerms — the due date a terms entry gives a document date, computed by
 *    /api/terms/compute (Standard and Date-Driven); the four built-in codes fall back to the
 *    local table when the server cannot be reached.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { dueDateForTerms } from '@/lib/preferences';

export interface TermsChoice {
  value: string;
  label: string;
}

interface TermsEntry {
  id: string;
  name: string;
  code?: string | null;
  isActive: boolean;
}

/** Active Terms list entries as choices; `fallback` until (or unless) the list loads. */
export function useTermsChoices(fallback: TermsChoice[] = []): TermsChoice[] {
  const [choices, setChoices] = useState<TermsChoice[]>(fallback);
  useEffect(() => {
    let live = true;
    api
      .get<{ entries: TermsEntry[] }>('/api/lists/terms')
      .then((d) => {
        if (!live || !Array.isArray(d?.entries) || d.entries.length === 0) return;
        setChoices(
          d.entries
            .filter((t) => t.isActive !== false)
            .map((t) => ({ value: (t.code ?? t.name).slice(0, 50), label: t.name })),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return choices;
}

/** Choices plus the current value when it is not on the list (an older document's terms). */
export function withCurrentTerms(choices: TermsChoice[], current: string | null | undefined): TermsChoice[] {
  if (!current || choices.some((c) => c.value === current || c.label === current)) return choices;
  return [...choices, { value: current, label: current }];
}

/** Due date ('YYYY-MM-DD') for a document dated `dateIso` under `terms`; '' when unknown. */
export async function fetchDueDateForTerms(dateIso: string, terms: string | null | undefined): Promise<string> {
  if (!dateIso || !terms) return '';
  try {
    const r = await api.get<{ dueDate?: string | null }>(
      `/api/terms/compute?terms=${encodeURIComponent(terms)}&date=${encodeURIComponent(dateIso.slice(0, 10))}`,
    );
    if (r?.dueDate) return String(r.dueDate).slice(0, 10);
  } catch {
    // Not on the Terms list (or offline): fall back to the built-in codes.
  }
  return dueDateForTerms(dateIso, terms);
}
