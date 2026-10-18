/**
 * Root route loading state. Server-rendered pages (dashboard, reports) previously
 * showed a blank screen while their queries ran; this renders a neutral skeleton
 * that matches the app's card design system instead.
 */
export default function RootLoading() {
  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <div className="h-9 w-72 rounded-lg bg-navy/10 animate-pulse mb-8" />
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-2xl p-6 bg-white border border-slate-200/70 shadow-xl">
            <div className="h-7 w-7 rounded bg-electric/20 animate-pulse mb-3" />
            <div className="h-7 w-28 rounded bg-navy/10 animate-pulse" />
            <div className="mt-2 h-4 w-36 rounded bg-navy/5 animate-pulse" />
          </div>
        ))}
      </div>
      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-2xl p-6 bg-white shadow-xl border border-slate-200/70">
            <div className="h-4 w-40 rounded bg-navy/10 animate-pulse" />
            <div className="mt-4 h-16 rounded bg-navy/5 animate-pulse" />
            <div className="mt-3 h-4 w-full rounded bg-navy/5 animate-pulse" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </main>
  );
}
