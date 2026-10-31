'use client';
/**
 * The page area of the app shell, which F5 (QuickBooks' "Refresh list") starts over in place:
 * the page is mounted afresh, so it fetches its lists, totals and reports again — without
 * reloading the whole window (the sidebar, the open company and the session stay as they are).
 * components/LeaveGuard.tsx decides when to refresh (asking first when typed work could be lost)
 * and sends PAGE_REFRESH_EVENT; this marks it handled.
 */
import * as React from 'react';
import { PAGE_REFRESH_EVENT } from '@/lib/shortcuts';

export default function PageRefresh({ children }: { children: React.ReactNode }) {
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    function onRefresh(e: Event) {
      e.preventDefault();
      setGeneration((g) => g + 1);
    }
    window.addEventListener(PAGE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(PAGE_REFRESH_EVENT, onRefresh);
  }, []);
  return <React.Fragment key={generation}>{children}</React.Fragment>;
}
