'use client';
/**
 * A page whose data could not be loaded: says so in plain words and offers "Try again", instead
 * of a loading skeleton that never ends (the server was restarting, the connection to the host
 * dropped, the session ran out…).
 */
import { AlertTriangle } from 'lucide-react';
import { Button, Card } from '@/components/ui';

export default function LoadFailed({
  message,
  onRetry,
  retrying = false,
}: {
  /** What went wrong (the server's message when it sent one). */
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <Card role="alert" className="p-6 flex items-start gap-4">
      <AlertTriangle className="h-6 w-6 shrink-0 text-gold" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold text-navy">This page could not be loaded.</p>
        <p className="mt-1 text-sm text-navy/60">{message}</p>
        <Button className="mt-4" size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
          Try again
        </Button>
      </div>
    </Card>
  );
}
