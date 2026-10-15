'use client';
/** Shared bits of the receipt capture screens (status badge, row type). */
import { Badge } from '@/components/ui';

export type ReceiptStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'saved';

export interface ReceiptRow {
  id: string;
  attachmentId: string;
  filename: string;
  mimeType: string | null;
  source: 'desktop' | 'phone';
  status: ReceiptStatus;
  method: string | null;
  message: string | null;
  vendorName: string | null;
  date: string | null;
  total: string | null;
  subtotal?: string | null;
  tax: string | null;
  cardLast4?: string | null;
  cardBrand?: string | null;
  reference?: string | null;
  confidence?: Record<string, number> | null;
  rawText?: string | null;
  txnType: string | null;
  txnId: string | null;
  version: number;
  createdAt: string;
}

/** Plain-language status for a receipt. */
export function ReceiptStatusBadge({ status, txnType }: { status: ReceiptStatus; txnType: string | null }) {
  switch (status) {
    case 'pending':
    case 'processing':
      return <Badge tone="info">Reading…</Badge>;
    case 'ready':
      return <Badge tone="warning">Ready to review</Badge>;
    case 'failed':
      return <Badge tone="danger">Enter by hand</Badge>;
    case 'saved':
      return <Badge tone="success">Saved as {txnType === 'bill' ? 'a bill' : 'an expense'}</Badge>;
  }
}
