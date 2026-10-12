/**
 * Shown when a server-rendered page is outside the user's roles (getPageContext redirects here).
 */
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';

export default function ForbiddenPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="No access" iconNode={<ShieldAlert className="text-electric h-8 w-8" />} />
      <Card className="p-6 max-w-xl">
        <p className="text-navy/70 text-sm">
          Your role doesn&apos;t include access to that page. If you need it, ask your company
          file&apos;s administrator to update your roles in Users &amp; Roles.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-block text-sm font-semibold text-electric hover:underline"
        >
          Back to Home
        </Link>
      </Card>
    </main>
  );
}
