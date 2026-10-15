'use client';

/**
 * "Bring over your history" — the QuickBooks General Ledger migration wizard (step 2 of the
 * Migrate from QuickBooks page). Talks to POST /api/qb-import/gl.
 *
 *   Upload → Preview → Account types → Dry run → Import → Proof
 *
 * Files are read in the browser (or the Electron window) and sent as base64; nothing leaves
 * this computer. Every step re-sends the files plus the user's choices, so the server stays
 * stateless and the dry run checks exactly what the import will do.
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  ListChecks,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Badge, Button, Card, Input, Label, Select, Table, Td, Th, Tr, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import type { GlImportResult, GlPreview, GlPreviewAccount, GlProof } from '@/lib/services/qbGlImport';
import type { GlReviewItem } from '@/lib/services/qbGlParse';

type Step = 'upload' | 'preview' | 'types' | 'dryrun' | 'done';
interface Upload {
  name: string;
  data: string;
  size: number;
}
type Choices = Record<string, { qbType?: string; mapTo?: string }>;

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'upload', label: 'Upload' },
  { id: 'preview', label: 'Preview' },
  { id: 'types', label: 'Account types' },
  { id: 'dryrun', label: 'Dry run' },
  { id: 'done', label: 'Proof' },
];

/** Read a File as base64 (chunked so large reports don't blow the call stack). */
async function fileToUpload(file: File): Promise<Upload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { name: file.name, data: btoa(binary), size: file.size };
}

/** Debit-positive amount shown the way accountants read it: "1,234.00 Dr" / "560.00 Cr". */
function drCr(amount: string): string {
  const n = Number(amount);
  if (!n) return formatCurrency(0);
  return `${formatCurrency(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`;
}

const isZero = (s: string | null | undefined) => !s || Number(s) === 0;

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}

export function GlWizard() {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<Upload | null>(null);
  const [refs, setRefs] = useState<Upload[]>([]);
  const [preview, setPreview] = useState<GlPreview | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [dry, setDry] = useState<GlImportResult | null>(null);
  const [done, setDone] = useState<GlImportResult | null>(null);
  const [acceptVariance, setAcceptVariance] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyCheck, setOnlyCheck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body = (action: 'preview' | 'dry-run' | 'import', extra: Record<string, unknown> = {}) => ({
    action,
    file: file && { name: file.name, data: file.data },
    references: refs.map((r) => ({ name: r.name, data: r.data })),
    periodStart: periodStart || null,
    periodEnd: periodEnd || null,
    accounts: choices,
    acceptVariance,
    ...extra,
  });

  async function runPreview(next: Step = 'preview') {
    if (!file) return;
    setBusy('Reading your report…');
    setError(null);
    try {
      const p = await api.post<GlPreview>('/api/qb-import/gl', body('preview'));
      setPreview(p);
      if (!periodStart && p.meta.periodStart) setPeriodStart(p.meta.periodStart);
      if (!periodEnd && p.meta.periodEnd) setPeriodEnd(p.meta.periodEnd);
      setDry(null);
      setStep(next);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function runDry(accept = acceptVariance) {
    setBusy('Doing a practice import and checking every account…');
    setError(null);
    try {
      const r = await api.post<GlImportResult>('/api/qb-import/gl', body('dry-run', { acceptVariance: accept }));
      setDry(r);
      setStep('dryrun');
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    setBusy('Importing and proving every balance…');
    setError(null);
    try {
      const r = await api.post<GlImportResult>('/api/qb-import/gl', body('import'));
      if (r.ok) {
        setDone(r);
        setStep('done');
        toast('Your QuickBooks history is in. Every account matches.', 'success');
      } else {
        setDry(r);
        setStep('dryrun');
        toast('Nothing was saved — see the differences below.', 'danger');
      }
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function startOver() {
    setStep('upload');
    setFile(null);
    setRefs([]);
    setPreview(null);
    setChoices({});
    setPeriodStart('');
    setPeriodEnd('');
    setDry(null);
    setDone(null);
    setAcceptVariance(false);
    setError(null);
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="space-y-6">
      {/* ---- Stepper ---- */}
      <ol className="flex flex-wrap gap-2" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            className={`flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${
              i === stepIndex
                ? 'bg-electric text-white'
                : i < stepIndex
                  ? 'bg-emerald/15 text-emerald'
                  : 'bg-slate-100 text-navy/50'
            }`}
            aria-current={i === stepIndex ? 'step' : undefined}
          >
            <span>{i + 1}</span>
            {s.label}
          </li>
        ))}
      </ol>

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 text-red-700 text-sm flex gap-2" role="alert">
          <XCircle className="h-5 w-5 shrink-0" />
          <span>{error}</span>
        </Card>
      )}
      {busy && (
        <Card className="p-4 text-sm text-navy/70" role="status">
          {busy}
        </Card>
      )}

      {step === 'upload' && (
        <UploadStep
          file={file}
          refs={refs}
          setFile={setFile}
          setRefs={setRefs}
          onNext={() => runPreview('preview')}
          busy={!!busy}
        />
      )}

      {step === 'preview' && preview && (
        <PreviewStep
          preview={preview}
          periodStart={periodStart}
          periodEnd={periodEnd}
          setPeriodStart={setPeriodStart}
          setPeriodEnd={setPeriodEnd}
          onRecheck={() => runPreview('preview')}
          onBack={() => setStep('upload')}
          onNext={() => setStep('types')}
          busy={!!busy}
        />
      )}

      {step === 'types' && preview && (
        <TypesStep
          preview={preview}
          choices={choices}
          setChoices={setChoices}
          onlyCheck={onlyCheck}
          setOnlyCheck={setOnlyCheck}
          onBack={() => setStep('preview')}
          onRecheck={() => runPreview('types')}
          onNext={() => runDry()}
          busy={!!busy}
        />
      )}

      {step === 'dryrun' && dry && (
        <DryRunStep
          result={dry}
          acceptVariance={acceptVariance}
          setAcceptVariance={(v) => {
            setAcceptVariance(v);
            void runDry(v);
          }}
          onBack={() => setStep('types')}
          onImport={runImport}
          busy={!!busy}
        />
      )}

      {step === 'done' && done && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-8 w-8 text-emerald" />
            <div>
              <h2 className="text-xl font-bold text-navy">Import complete</h2>
              <p className="text-sm text-navy/70">{done.message}</p>
            </div>
          </div>
          <Counts result={done} />
          <ProofView proof={done.proof} />
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => window.location.assign('/reports')}>
              Open reports
            </Button>
            <Button variant="secondary" onClick={() => window.location.assign('/accounts')}>
              See chart of accounts
            </Button>
            <Button variant="ghost" onClick={startOver}>
              Import another report
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function UploadStep({
  file,
  refs,
  setFile,
  setRefs,
  onNext,
  busy,
}: {
  file: Upload | null;
  refs: Upload[];
  setFile: (f: Upload | null) => void;
  setRefs: (r: Upload[]) => void;
  onNext: () => void;
  busy: boolean;
}) {
  async function pickGl(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      setFile(await fileToUpload(f));
    } catch {
      toast('Could not read that file.', 'danger');
    }
  }
  async function pickRefs(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []).slice(0, 4);
    try {
      setRefs(await Promise.all(list.map(fileToUpload)));
    } catch {
      toast('Could not read that file.', 'danger');
    }
  }
  return (
    <Card className="p-6 space-y-5">
      <div>
        <h2 className="text-lg font-bold text-navy">Upload your QuickBooks General Ledger</h2>
        <p className="text-sm text-navy/70 mt-1">
          In QuickBooks Desktop open <b>Reports → Accountant &amp; Taxes → General Ledger</b>, set the dates you
          want to bring over (for example <i>All</i> or <i>Last Fiscal Year</i>), then choose{' '}
          <b>Excel → Create New Worksheet</b>, <b>Excel → Create .CSV file</b>, or <b>File → Save as PDF</b>. Don’t
          filter the report — every account is needed so the books balance.
        </p>
      </div>
      <div>
        <Label htmlFor="gl-file">General Ledger report (.xlsx, .csv or .pdf)</Label>
        <Input id="gl-file" type="file" accept=".xlsx,.csv,.txt,.pdf" onChange={pickGl} />
        {file && (
          <p className="mt-1 text-xs text-navy/60 flex items-center gap-1">
            <FileSpreadsheet className="h-3.5 w-3.5" /> {file.name} ({Math.ceil(file.size / 1024)} KB)
          </p>
        )}
      </div>
      <div>
        <Label htmlFor="ref-files">Optional: Account Listing and/or Trial Balance (.xlsx, .csv, .pdf or .iif)</Label>
        <Input id="ref-files" type="file" multiple accept=".xlsx,.csv,.txt,.pdf,.iif" onChange={pickRefs} />
        <p className="mt-1 text-xs text-navy/60">
          The <b>Account Listing</b> (Reports → List → Account Listing) tells us each account’s exact type. A{' '}
          <b>Trial Balance</b> for the last day of the period gives a second check of every balance. Your IIF chart
          of accounts works too.
        </p>
        {refs.map((r) => (
          <p key={r.name} className="mt-1 text-xs text-navy/60 flex items-center gap-1">
            <FileText className="h-3.5 w-3.5" /> {r.name}
          </p>
        ))}
      </div>
      <div className="flex justify-end">
        <Button onClick={onNext} disabled={!file} loading={busy}>
          Read my report <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

function PreviewStep({
  preview,
  periodStart,
  periodEnd,
  setPeriodStart,
  setPeriodEnd,
  onRecheck,
  onBack,
  onNext,
  busy,
}: {
  preview: GlPreview;
  periodStart: string;
  periodEnd: string;
  setPeriodStart: (s: string) => void;
  setPeriodEnd: (s: string) => void;
  onRecheck: () => void;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
}) {
  const p = preview;
  const datesChanged = (periodStart || null) !== p.meta.periodStart || (periodEnd || null) !== p.meta.periodEnd;
  return (
    <Card className="p-6 space-y-5">
      <h2 className="text-lg font-bold text-navy">Here’s what we found</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Company" value={p.meta.companyName || '—'} />
        <Tile label="Accounts" value={String(p.accounts.length)} />
        <Tile label="Transactions" value={String(p.stats.transactions)} />
        <Tile
          label="Dates"
          value={p.meta.firstDate ? `${p.meta.firstDate} → ${p.meta.lastDate}` : 'No transactions'}
        />
        <Tile label="Total debits" value={formatCurrency(p.totals.lineDebits)} />
        <Tile label="Total credits" value={formatCurrency(p.totals.lineCredits)} />
        <Tile label="Need review" value={String(p.stats.reviewItems)} tone={p.stats.reviewItems ? 'warning' : 'success'} />
        <Tile
          label="People & companies"
          value={`${p.names.customers} customers · ${p.names.vendors} vendors · ${p.names.employees} employees`}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        <div>
          <Label htmlFor="ps">Period starts</Label>
          <Input id="ps" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pe">Period ends</Label>
          <Input id="pe" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </div>
        <p className="text-xs text-navy/60">
          Balances from before the start date come in as one opening entry dated the day before.
        </p>
      </div>

      {p.reference && (
        <p className="text-sm text-navy/70">
          {p.reference.kind === 'trial-balance' ? 'Trial Balance' : 'Account list'} matched {p.reference.matched}{' '}
          account(s).
          {p.reference.unmatched.length > 0 && ` Not found in the ledger: ${p.reference.unmatched.slice(0, 5).join(', ')}.`}
        </p>
      )}
      {p.alreadyImported > 0 && (
        <p className="text-sm text-navy/70">
          {p.alreadyImported} of these transactions were imported before and will be skipped.
        </p>
      )}

      <Problems errors={p.errors} warnings={p.warnings} />
      {p.review.length > 0 && <ReviewList review={p.review} />}

      <div className="flex flex-wrap justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="flex gap-3">
          {datesChanged && (
            <Button variant="secondary" onClick={onRecheck} loading={busy}>
              Use these dates
            </Button>
          )}
          {/* Problems that mention account types can be fixed on the next step; the practice
              run refuses to proceed while any problem remains. */}
          <Button onClick={onNext} disabled={datesChanged}>
            Next: account types <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

const CONFIDENCE: Record<string, { label: string; tone: 'success' | 'info' | 'warning' }> = {
  exact: { label: 'Exact', tone: 'success' },
  high: { label: 'Likely', tone: 'info' },
  medium: { label: 'Probably', tone: 'info' },
  low: { label: 'Please check', tone: 'warning' },
};

function TypesStep({
  preview,
  choices,
  setChoices,
  onlyCheck,
  setOnlyCheck,
  onBack,
  onRecheck,
  onNext,
  busy,
}: {
  preview: GlPreview;
  choices: Choices;
  setChoices: (c: Choices) => void;
  onlyCheck: boolean;
  setOnlyCheck: (v: boolean) => void;
  onBack: () => void;
  onRecheck: () => void;
  onNext: () => void;
  busy: boolean;
}) {
  const [dirty, setDirty] = useState(false);
  const existing = useMemo(
    () => [...preview.existingAccounts].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    [preview.existingAccounts],
  );
  const rows = preview.accounts.filter(
    (a) => !onlyCheck || a.confidence === 'low' || a.confidence === 'medium' || choices[a.key],
  );
  const set = (a: GlPreviewAccount, patch: { qbType?: string; mapTo?: string }) => {
    setChoices({ ...choices, [a.key]: { ...choices[a.key], ...patch } });
    setDirty(true);
  };
  const toCheck = preview.accounts.filter((a) => a.confidence === 'low').length;

  return (
    <Card className="p-6 space-y-4">
      <div>
        <h2 className="text-lg font-bold text-navy">Check each account’s type</h2>
        <p className="text-sm text-navy/70 mt-1">
          A General Ledger doesn’t say what kind each account is, so we worked it out from its number, its name, and
          how it’s used. {toCheck > 0 ? `${toCheck} need a quick look.` : 'Everything looks clear.'} If an account
          already exists in Ironbooks, its money goes there instead of creating a duplicate.
        </p>
      </div>
      {preview.errors.length > 0 && <Problems errors={preview.errors} warnings={[]} />}
      <label className="flex items-center gap-2 text-sm text-navy">
        <input type="checkbox" checked={onlyCheck} onChange={(e) => setOnlyCheck(e.target.checked)} />
        Only show accounts to check
      </label>
      <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-slate-100">
        <Table>
          <thead>
            <tr>
              <Th>QuickBooks account</Th>
              <Th>Type</Th>
              <Th>Put it in</Th>
              <Th numeric>Ending balance</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const c = CONFIDENCE[a.confidence];
              const mapTo = choices[a.key]?.mapTo ?? a.mapTo;
              return (
                <Tr key={a.key}>
                  <Td>
                    <div style={{ paddingLeft: `${a.depth * 1.25}rem` }}>
                      <div className="font-medium">
                        {a.number ? `${a.number} · ` : ''}
                        {a.name}
                      </div>
                      <div className="text-xs text-navy/50">{a.typeReason}</div>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Select
                        aria-label={`Type of ${a.fullName}`}
                        value={choices[a.key]?.qbType ?? a.qbType}
                        onChange={(e) => set(a, { qbType: e.target.value })}
                        className="min-w-[12rem]"
                      >
                        {preview.qbTypes.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Select>
                      {!choices[a.key]?.qbType && <Badge tone={c.tone}>{c.label}</Badge>}
                    </div>
                  </Td>
                  <Td>
                    <Select
                      aria-label={`Where ${a.fullName} goes`}
                      value={mapTo}
                      onChange={(e) => set(a, { mapTo: e.target.value })}
                      className="min-w-[14rem]"
                    >
                      <option value="new">Create new account</option>
                      {existing.map((e) => (
                        <option key={e.id} value={e.id}>
                          Existing: {e.code} {e.name}
                        </option>
                      ))}
                    </Select>
                  </Td>
                  <Td numeric>{drCr(a.ending)}</Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </div>
      <div className="flex flex-wrap justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="flex gap-3">
          {dirty && (
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => {
                setDirty(false);
                onRecheck();
              }}
            >
              Re-check with my changes
            </Button>
          )}
          <Button onClick={onNext} loading={busy} disabled={dirty || preview.errors.length > 0}>
            Do a practice run <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function DryRunStep({
  result,
  acceptVariance,
  setAcceptVariance,
  onBack,
  onImport,
  busy,
}: {
  result: GlImportResult;
  acceptVariance: boolean;
  setAcceptVariance: (v: boolean) => void;
  onBack: () => void;
  onImport: () => void;
  busy: boolean;
}) {
  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-start gap-3">
        {result.ok ? (
          <ShieldCheck className="h-8 w-8 text-emerald shrink-0" />
        ) : (
          <AlertTriangle className="h-8 w-8 text-yellow-600 shrink-0" />
        )}
        <div>
          <h2 className="text-lg font-bold text-navy">
            {result.ok ? 'Practice run passed' : 'Practice run found differences'}
          </h2>
          <p className="text-sm text-navy/70">{result.message}</p>
        </div>
      </div>
      <Counts result={result} />
      <ProofView proof={result.proof} />
      {result.review.length > 0 && <ReviewList review={result.review} />}
      {result.warnings.length > 0 && <Problems errors={[]} warnings={result.warnings} />}

      {/* A Trial Balance difference can't be moved to suspense — only General Ledger differences can. */}
      {(!result.proof.allMatch || acceptVariance) && (
        <label className="flex items-start gap-2 rounded-lg border border-gold/40 bg-gold/10 p-3 text-sm text-navy">
          <input
            type="checkbox"
            className="mt-1"
            checked={acceptVariance}
            onChange={(e) => setAcceptVariance(e.target.checked)}
          />
          <span>
            Import anyway and put the difference in a <b>“QB Import Suspense”</b> account so I (or my accountant)
            can sort it out later. Everything else still has to match exactly.
          </span>
        </label>
      )}

      <div className="flex flex-wrap justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={onImport} disabled={!result.ok} loading={busy}>
          Import now
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-navy/50">{label}</div>
      <div
        className={`mt-1 text-sm font-bold ${
          tone === 'warning' ? 'text-yellow-700' : tone === 'success' ? 'text-emerald' : 'text-navy'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Problems({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  if (!errors.length && !warnings.length) return null;
  return (
    <div className="space-y-2">
      {errors.map((e, i) => (
        <div key={`e${i}`} className="flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <XCircle className="h-4 w-4 shrink-0 mt-0.5" /> <span>{e}</span>
        </div>
      ))}
      {warnings.map((w, i) => (
        <div key={`w${i}`} className="flex gap-2 rounded-lg bg-gold/10 p-3 text-sm text-yellow-800">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> <span>{w}</span>
        </div>
      ))}
    </div>
  );
}

function ReviewList({ review }: { review: GlReviewItem[] }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-bold text-navy flex items-center gap-2">
        <ListChecks className="h-4 w-4" /> Transactions that need review ({review.length})
      </h3>
      <p className="text-xs text-navy/60">
        We couldn’t match these lines into a complete, balanced transaction, so they will not be posted. This usually
        means the report was filtered or a page is missing.
      </p>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-100">
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Type</Th>
              <Th>Num</Th>
              <Th>Account</Th>
              <Th>Name</Th>
              <Th numeric>Debit</Th>
              <Th numeric>Credit</Th>
            </tr>
          </thead>
          <tbody>
            {review.flatMap((r) =>
              r.lines.map((l, i) => (
                <Tr key={`${r.id}-${i}`}>
                  <Td>{i === 0 ? r.date : ''}</Td>
                  <Td>{i === 0 ? r.type : ''}</Td>
                  <Td>{i === 0 ? r.num : ''}</Td>
                  <Td>{l.accountName}</Td>
                  <Td>{l.name}</Td>
                  <Td numeric>{isZero(l.debit) ? '' : formatCurrency(l.debit)}</Td>
                  <Td numeric>{isZero(l.credit) ? '' : formatCurrency(l.credit)}</Td>
                </Tr>
              )),
            )}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

function Counts({ result }: { result: GlImportResult }) {
  const c = result.counts;
  const items: Array<[string, number]> = [
    ['Accounts created', c.accountsCreated],
    ['Accounts reused', c.accountsMapped],
    ['Transactions', c.entriesPosted],
    ['Already imported', c.entriesAlreadyImported],
    ['Classes', c.classesCreated],
    ['Customers', c.customersCreated],
    ['Vendors', c.vendorsCreated],
    ['Employees', c.employeesCreated],
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items
        .filter(([, n]) => n > 0)
        .map(([label, n]) => (
          <Badge key={label} tone="info">
            {n} {label.toLowerCase()}
          </Badge>
        ))}
      {c.openingEntryPosted && <Badge tone="info">opening balances</Badge>}
      {result.variancePosted && <Badge tone="warning">{formatCurrency(result.variancePosted)} to suspense</Badge>}
    </div>
  );
}

function ProofView({ proof }: { proof: GlProof }) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? proof.rows : proof.rows.filter((r) => !isZero(r.difference) || !isZero(r.trialBalanceDifference));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <ProofCheck
          ok={proof.allMatch}
          title={
            proof.allMatch
              ? `All ${proof.rows.length} accounts match ✓`
              : `${proof.mismatches} of ${proof.rows.length} accounts differ`
          }
          detail={`Ending balances as of ${proof.asOf} compared with the QuickBooks report.`}
        />
        <ProofCheck
          ok={proof.ledger.balanced}
          title={proof.ledger.balanced ? 'Debits = credits ✓' : 'Debits ≠ credits'}
          detail={`${formatCurrency(proof.ledger.debits)} debits · ${formatCurrency(proof.ledger.credits)} credits`}
        />
        {proof.trialBalanceCompared ? (
          <ProofCheck
            ok={proof.trialBalanceMatches}
            title={proof.trialBalanceMatches ? 'Matches your Trial Balance ✓' : 'Differs from your Trial Balance'}
            detail="Second check against the QuickBooks Trial Balance you uploaded."
          />
        ) : (
          <ProofCheck ok title="Trial Balance not supplied" detail="Optional — upload one for a second check." muted />
        )}
      </div>
      {proof.suspense !== null && !isZero(proof.suspense) && (
        <p className="text-sm text-yellow-800">
          QB Import Suspense holds {drCr(proof.suspense)} — review and move it to the right accounts.
        </p>
      )}
      {proof.tbUnmatched.length > 0 && (
        <p className="text-sm text-yellow-800">
          Trial Balance accounts not in the ledger: {proof.tbUnmatched.map((t) => t.label).join(', ')}.
        </p>
      )}
      <label className="flex items-center gap-2 text-sm text-navy">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Show every account
      </label>
      {rows.length > 0 && (
        <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-100">
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th numeric>QuickBooks</Th>
                <Th numeric>Ironbooks</Th>
                <Th numeric>Difference</Th>
                {proof.trialBalanceCompared && <Th numeric>Trial Balance</Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.accountId}>
                  <Td>
                    <div className="font-medium">
                      {r.code} {r.name}
                    </div>
                    {r.qbAccounts.length > 1 && <div className="text-xs text-navy/50">{r.qbAccounts.join(', ')}</div>}
                  </Td>
                  <Td numeric>{drCr(r.expected)}</Td>
                  <Td numeric>{drCr(r.actual)}</Td>
                  <Td numeric>
                    {isZero(r.difference) ? (
                      <span className="text-emerald font-semibold">✓</span>
                    ) : (
                      <span className="text-red-600 font-semibold">{drCr(r.difference)}</span>
                    )}
                  </Td>
                  {proof.trialBalanceCompared && (
                    <Td numeric>
                      {r.trialBalance === null ? '—' : drCr(r.trialBalance)}
                      {!isZero(r.trialBalanceDifference) && <span className="ml-1 text-red-600">✗</span>}
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}

function ProofCheck({ ok, title, detail, muted }: { ok: boolean; title: string; detail: string; muted?: boolean }) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        muted ? 'border-slate-100 bg-slate-50' : ok ? 'border-emerald/30 bg-emerald/10' : 'border-red-200 bg-red-50'
      }`}
    >
      <div className={`text-sm font-bold ${muted ? 'text-navy/60' : ok ? 'text-emerald' : 'text-red-700'}`}>{title}</div>
      <div className="text-xs text-navy/60 mt-1">{detail}</div>
    </div>
  );
}
