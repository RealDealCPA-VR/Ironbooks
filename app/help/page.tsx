/**
 * Help & Glossary — plain-language answers for non-accountants.
 *
 * Linked from every <Help term> tooltip ("Learn more" -> /help#term-<key>) and from the
 * command palette's plain-language intents ("fix a mistake" -> /help#fix-a-mistake).
 * Static content: the glossary comes from lib/glossary.ts; the how-to guides live here.
 */
import Link from 'next/link';
import { BookOpenCheck, LifeBuoy, Wrench } from 'lucide-react';
import { GLOSSARY, GLOSSARY_KEYS, glossaryAnchor, type GlossaryEntry } from '@/lib/glossary';

interface Guide {
  id: string;
  title: string;
  intro: string;
  steps: { text: string; href?: string; linkText?: string }[];
}

const GUIDES: Guide[] = [
  {
    id: 'fix-a-mistake',
    title: 'How do I fix a mistake?',
    intro:
      'Your books keep a permanent history, so mistakes are corrected rather than erased. Pick the case that fits:',
    steps: [
      {
        text: 'Wrong amount, date, customer or account on an invoice, bill, check or receipt: open it from its list, change it and save. If it is linked to a payment or deposit, you may need to undo that first.',
      },
      {
        text: 'The transaction should never have happened: Void it. The amounts become zero but the record stays visible in the Audit Trail.',
        href: '/audit-trail',
        linkText: 'See the Audit Trail',
      },
      {
        text: 'A payment went to the wrong invoice: open Receive Payments, void the payment, then record it again against the right invoice.',
        href: '/payments',
        linkText: 'Open Receive Payments',
      },
      {
        text: 'Money is in the wrong category (account): open the transaction and change the account, or for many at once use a journal entry. The journal entry form will not save until debits equal credits.',
        href: '/journal',
        linkText: 'Open Journal Entries',
      },
      {
        text: 'The date is in a closed period: the books are locked for that date. Ask the owner for the closing-date password, or record the correction with today’s date.',
      },
      {
        text: 'Not sure what went wrong? The Data Integrity check and AI Review look for duplicates, out-of-balance entries and other common problems.',
        href: '/errors',
        linkText: 'Run AI Review',
      },
    ],
  },
  {
    id: 'got-paid',
    title: 'I got paid — what do I do?',
    intro: 'It depends on whether you sent an invoice first.',
    steps: [
      { text: 'You sent an invoice: use Receive Payments and pick the invoice it pays.', href: '/payments', linkText: 'Receive Payments' },
      { text: 'No invoice (paid on the spot): use a Sales Receipt.', href: '/sales-receipts', linkText: 'Sales Receipts' },
      {
        text: 'When you take the money to the bank, use Record Deposits so your books show the same deposit as your bank statement.',
        href: '/deposits',
        linkText: 'Record Deposits',
      },
    ],
  },
  {
    id: 'paying-bills',
    title: 'Paying vendors',
    intro: 'Two ways, depending on when you pay.',
    steps: [
      { text: 'Pay later: Enter Bills when the bill arrives, then Pay Bills when you pay it.', href: '/bills', linkText: 'Enter Bills' },
      { text: 'Pay now (check, debit card or cash): use Write Checks.', href: '/expenses', linkText: 'Write Checks' },
    ],
  },
  {
    id: 'reconcile-monthly',
    title: 'Checking against the bank every month',
    intro:
      'Reconciling catches mistakes and missing transactions early. Do it when each bank statement arrives.',
    steps: [
      { text: 'Open Reconcile, choose the account and enter the statement date and ending balance.', href: '/reconcile', linkText: 'Reconcile' },
      { text: 'Tick each transaction that appears on the statement. When the difference is 0.00, finish.' },
      { text: 'Something missing? Add it (or download it with Bank Feeds), then come back.', href: '/bank-feeds', linkText: 'Bank Feeds' },
    ],
  },
  {
    id: 'company-file',
    title: 'Your company file (like a QuickBooks .QBW)',
    intro:
      'Each company is one file, for example "Acme Plumbing.ironbooks". Keep it wherever you like: this computer, a USB drive or the office file server.',
    steps: [
      { text: 'Open it with File > Open or Restore Company (Ctrl+O), from File > Open Previous Company, or by double-clicking it.' },
      { text: 'Ironbooks saves your work into the file a few seconds after each change and when you close it. The title bar says Saved.' },
      { text: 'Everyone signs in with their own user name and password every time the file is opened. They are stored in the file, so they go wherever it goes.' },
      { text: 'Copy it, back it up or send it to your accountant like any other file, or use File > Save Copy As.', href: '/company-file', linkText: 'Company File' },
    ],
  },
  {
    id: 'file-server',
    title: 'Sharing the company file on a file server',
    intro:
      'Put the company file on a shared drive and open it from any computer. While someone is in it, it is locked to them, the way QuickBooks single-user mode works.',
    steps: [
      { text: 'If someone else has it open, Ironbooks tells you who and on which computer, and offers Ask to Come In.' },
      { text: 'They see your request and choose Let Them In (you both work at once, multi-user mode), Hand It Over (they close it and it opens for you) or Not Now.' },
      { text: 'To let people join without asking, the person in the file chooses File > Switch to Multi-user Mode. Each person still signs in with their own user name.' },
      { text: 'The first time a computer lets others in, Windows may ask whether Ironbooks can use the network: choose Allow on private networks.' },
      { text: 'Add a user name for each person under Company > Users and Roles.', href: '/users', linkText: 'Users and Roles' },
    ],
  },
  {
    id: 'try-it-on-a-copy',
    title: 'Can I try something without changing my real books?',
    intro:
      'Yes. "Try it on a copy" opens Ironbooks on a throwaway copy of your whole company file (the sandbox). An orange SANDBOX bar shows on every page and anything you print is stamped SANDBOX.',
    steps: [
      { text: 'Click "Try it on a copy". The copy opens straight away.', href: '/sandbox', linkText: 'Try it on a copy' },
      { text: 'Practise or test anything. Emails, bank feeds, scheduled reports and automatic backups are off in the sandbox, so nothing leaves the copy.' },
      { text: 'When you are done: Discard the sandbox (the copy is deleted) or Keep it as a training file with a name you choose. Nothing is ever copied back into your real books.' },
    ],
  },
];

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
        example &ldquo;I got paid&rdquo; or &ldquo;pay a bill&rdquo;. Coming from QuickBooks Desktop? Its keys work here
        (Ctrl+W, Ctrl+I, Ctrl+J, Ctrl+A, Ctrl+E, Ctrl+D, the date keys…): press{' '}
        <kbd className="rounded border border-slate-300 bg-white px-1">?</kbd> on any page for the full list.
      </p>

      <section aria-labelledby="guides" className="mb-10">
        <h2 id="guides" className="mb-4 flex items-center gap-2 text-xl font-bold text-navy">
          <Wrench className="h-5 w-5 text-electric" aria-hidden="true" /> How do I…
        </h2>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {GUIDES.map((g) => (
            <article key={g.id} id={g.id} className="scroll-mt-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-xl target:ring-2 target:ring-electric">
              <h3 className="text-lg font-bold text-navy">{g.title}</h3>
              <p className="mt-1 text-sm text-navy/60">{g.intro}</p>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-navy/80">
                {g.steps.map((s, i) => (
                  <li key={i}>
                    {s.text}{' '}
                    {s.href && (
                      <Link href={s.href} className="font-semibold text-electric hover:underline">
                        {s.linkText ?? 'Open'} →
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
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
