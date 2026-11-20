/**
 * Help & Glossary — plain-language answers for non-accountants.
 *
 * Linked from every <Help term> tooltip ("Learn more" -> /help#term-<key>) and from the
 * command palette's plain-language intents ("fix a mistake" -> /help#fix-a-mistake).
 * Static content: the glossary comes from lib/glossary.ts; the how-to guides come from the
 * product knowledge base (lib/kb/articles.ts), which also answers Ask AI and is published as
 * docs/guide. Add or change a guide there, not here.
 */
import { BookOpenCheck, LifeBuoy, Wrench } from 'lucide-react';
import { GLOSSARY, GLOSSARY_KEYS, glossaryAnchor, type GlossaryEntry } from '@/lib/glossary';
import HelpGuides from '@/components/HelpGuides';

export default function HelpPage() {
  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      {/* Server component: render the header inline (PageHeader is a client component and
          component-typed props like `icon` cannot cross the server/client boundary). */}
      <h1 className="mb-6 flex items-center gap-3 text-3xl font-bold text-navy">
        <LifeBuoy className="h-8 w-8 text-electric" aria-hidden="true" />
        Help &amp; Glossary
      </h1>
      <p className="-mt-3 mb-8 max-w-2xl text-sm text-navy/60">
        Plain-language answers to common questions. Tip: press <kbd className="rounded border border-slate-300 bg-white px-1">Ctrl</kbd>
        +<kbd className="rounded border border-slate-300 bg-white px-1">K</kbd> anywhere and type what you want to do — for
        example &ldquo;I got paid&rdquo; or &ldquo;pay a bill&rdquo;. Or click <strong>Ask AI</strong> in the top bar and ask in your
        own words: it answers from these same guides and links you to the right screen. Coming from QuickBooks Desktop? Its keys work here
        (Ctrl+W, Ctrl+I, Ctrl+J, Ctrl+A, Ctrl+E, Ctrl+D, the date keys…): press{' '}
        <kbd className="rounded border border-slate-300 bg-white px-1">?</kbd> on any page for the full list.
      </p>

      <section aria-labelledby="guides" className="mb-10">
        <h2 id="guides" className="mb-4 flex items-center gap-2 text-xl font-bold text-navy">
          <Wrench className="h-5 w-5 text-electric" aria-hidden="true" /> How do I…
        </h2>
        <HelpGuides />
      </section>

      <section aria-labelledby="glossary">
        <h2 id="glossary" className="mb-4 flex items-center gap-2 text-xl font-bold text-navy">
          <BookOpenCheck className="h-5 w-5 text-electric" aria-hidden="true" /> Glossary
        </h2>
        <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {GLOSSARY_KEYS.map((key) => {
            const e: GlossaryEntry = GLOSSARY[key];
            return (
              <div
                key={key}
                id={glossaryAnchor(key)}
                className="scroll-mt-6 rounded-xl border border-slate-100 bg-white p-5 shadow target:ring-2 target:ring-electric"
              >
                <dt className="font-bold text-navy">{e.term}</dt>
                <dd className="mt-1 text-sm text-navy/70">{e.short}</dd>
                {e.long && <dd className="mt-2 text-sm text-navy/50">{e.long}</dd>}
              </div>
            );
          })}
        </dl>
      </section>
    </main>
  );
}
