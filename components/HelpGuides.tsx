'use client';

/**
 * The "How do I…" section of Help & Glossary: every article of the product knowledge base
 * (lib/kb), grouped by area, with a search box. The same articles answer Ask AI and are
 * published as docs/guide, so what you read here is what the assistant says.
 *
 * Each article keeps its id as the anchor (/help#fix-a-mistake), so links from the command
 * palette, tooltips and Ask AI land on it.
 */
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Search } from 'lucide-react';
import { KB_AREAS, KB_AREA_ORDER, KB_ARTICLES, menuPath, searchKb, type KbArticle } from '@/lib/kb';

function Article({ a }: { a: KbArticle }) {
  const where = a.go ? menuPath(a.go.href) : null;
  return (
    <article id={a.id} className="scroll-mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-xl target:ring-2 target:ring-electric">
      <h3 className="text-lg font-bold text-navy">{a.title}</h3>
      <p className="mt-1 text-sm text-navy/60">{a.summary}</p>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-navy/80">
        {a.steps.map((s, i) => (
          <li key={i}>
            {s.text}{' '}
            {s.link && (
              <Link href={s.link.href} className="font-semibold text-electric hover:underline">
                {s.link.label} →
              </Link>
            )}
          </li>
        ))}
      </ol>
      {a.notes?.length ? (
        <ul className="mt-3 space-y-1 text-xs text-navy/50">
          {a.notes.map((n, i) => (
            <li key={i}>Good to know: {n}</li>
          ))}
        </ul>
      ) : null}
      {a.go && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link
            href={a.go.href}
            className="inline-flex items-center gap-1 rounded-full bg-electric px-3 py-1 text-xs font-semibold text-white hover:bg-electric/90 outline-none focus-visible:ring-4 focus-visible:ring-electric/25"
          >
            Open {a.go.label} <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
          {where && <span className="text-[11px] text-navy/40">Menu: {where}</span>}
        </div>
      )}
    </article>
  );
}

export default function HelpGuides() {
  const [query, setQuery] = React.useState('');
  const q = query.trim();
  const found = React.useMemo(() => (q ? searchKb(q, { articleLimit: 8, screenLimit: 5 }) : null), [q]);

  return (
    <div>
      <label className="relative mb-6 block max-w-xl">
        <span className="sr-only">Search the guides</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/40" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What do you want to do? e.g. reconcile, pay a bill, back up"
          className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-navy outline-none focus:border-electric focus:ring-2 focus:ring-electric/30"
        />
      </label>

      {found ? (
        <div className="space-y-6">
          {found.terms.map((t) => (
            <p key={t.key} className="max-w-3xl rounded-xl border border-slate-100 bg-white p-4 text-sm text-navy/70 shadow">
              <span className="font-bold text-navy">{t.term}:</span> {t.short}{' '}
              <a href={t.href.slice('/help'.length)} className="font-semibold text-electric hover:underline">
                Glossary →
              </a>
            </p>
          ))}
          {found.screens.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-navy/50">Screens:</span>
              {found.screens.map((s) => (
                <Link key={s.href} href={s.href} title={s.what} className="rounded-full border border-electric/30 px-3 py-1 text-xs font-semibold text-electric hover:bg-electric/5">
                  {s.label} →
                </Link>
              ))}
            </div>
          )}
          {found.articles.length > 0 ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {found.articles.map(({ article }) => (
                <Article key={article.id} a={article} />
              ))}
            </div>
          ) : (
            found.screens.length === 0 &&
            found.terms.length === 0 && (
              <p className="text-sm text-navy/60">
                No guide matches that. Try other words, or click <span className="font-semibold">Ask AI</span> in the top bar and ask in your own words.
              </p>
            )
          )}
        </div>
      ) : (
        <>
          <nav aria-label="Guide topics" className="mb-8 flex flex-wrap gap-2">
            {KB_AREA_ORDER.map((area) => (
              <a key={area} href={`#guides-${area}`} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-navy/70 hover:border-electric/40 hover:text-electric">
                {KB_AREAS[area].title}
              </a>
            ))}
          </nav>
          {KB_AREA_ORDER.map((area) => {
            const list = KB_ARTICLES.filter((a) => a.area === area);
            if (!list.length) return null;
            return (
              <section key={area} id={`guides-${area}`} aria-labelledby={`guides-${area}-h`} className="mb-10 scroll-mt-6">
                <h3 id={`guides-${area}-h`} className="text-base font-bold text-navy">
                  {KB_AREAS[area].title}
                </h3>
                <p className="mb-4 text-xs text-navy/50">{KB_AREAS[area].blurb}</p>
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  {list.map((a) => (
                    <Article key={a.id} a={a} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
