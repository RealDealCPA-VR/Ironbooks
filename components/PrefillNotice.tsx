/**
 * Banner on a transaction form that was filled in from the command bar (Ctrl+K): reminds the
 * user that nothing is saved until they review the values and click Save.
 */
export default function PrefillNotice({ note }: { note?: string | null }) {
  if (!note) return null;
  return (
    <div role="note" className="rounded-lg border border-electric/30 bg-electric/5 px-3 py-2 text-xs text-navy/70">
      {note}
    </div>
  );
}
