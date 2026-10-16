'use client';
/** Small client helpers shared by the Accountant Center tool pages. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/client';
import { localDateISO, todayISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/money';

export interface AccountOpt {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string;
  isActive?: boolean;
}
export interface NamedOpt {
  id: string;
  name?: string;
  displayName?: string;
}

/** Load a list endpoint once; failures (e.g. no permission) yield an empty list. */
export function useList<T>(url: string): T[] {
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .get<T[]>(url)
      .then((r) => alive && setRows(Array.isArray(r) ? r : []))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [url]);
  return rows;
}

export function accountLabel(a: AccountOpt): string {
  return `${a.code} · ${a.name}`;
}

export function BackToCenter() {
  return (
    <Link href="/accountant" className="mb-3 inline-flex items-center gap-1 text-sm text-electric hover:underline print-hidden">
      <ArrowLeft className="h-4 w-4" /> Accountant Center
    </Link>
  );
}

export function money(v: string | number | null | undefined): string {
  return formatCurrency(v ?? 0);
}

/** Today's local calendar date (lib/dates.ts todayISO). */
export function today(): string {
  return todayISO();
}

/** The local calendar date n months ago. */
export function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return localDateISO(d);
}
