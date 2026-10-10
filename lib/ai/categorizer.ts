/**
 * Learned transaction categorizer (QuickBooks-style "learns from how you categorize").
 *
 * Pure TypeScript, fully local, no LLM. A multinomial naive Bayes over binary features:
 *   - payee identity ("p1:starbucks", "p2:shell oil") — the strongest signal
 *   - payee / memo / bank-description word tokens ("w:coffee")
 *   - amount magnitude bucket ("a:6" ≈ $64–$127) and exact amount ("x:2500.00", for rent etc.)
 *   - direction ("d:out" / "d:in")
 *
 * Three independent heads share the features: account, class, and customer:job.
 *
 * Confidence is CALIBRATED, not raw NB posterior (NB is notoriously over-confident because
 * features are not independent):
 *   1. Tempering — log-likelihoods are divided by sqrt(#features) before the softmax.
 *   2. Evidence shrinkage — multiplied by n/(n+1), n = how many times this payee was put in
 *      the predicted category, so a single observation can never exceed 50%.
 *   3. Online reliability bins — every incremental update first predicts, then records whether
 *      the prediction was right in a 10-bin reliability table; once a bin has data, the
 *      confidence is blended toward the empirical accuracy observed in that bin.
 *
 * State is plain JSON (persisted per company in ai_categorizer_models).
 */
import Decimal from 'decimal.js';

export type Head = 'account' | 'class' | 'customerJob';
export const HEADS: Head[] = ['account', 'class', 'customerJob'];

/** Label used by the class / customer:job heads for "leave blank". */
export const NONE = '';

export interface TrainingExample {
  payee?: string | null;
  memo?: string | null;
  /** Decimal string; sign is ignored (direction carries it). */
  amount: string | number;
  direction: 'in' | 'out';
  labels: Partial<Record<Head, string | null>>;
}

export type PredictInput = Omit<TrainingExample, 'labels'>;

interface HeadState {
  /** Documents per label. */
  docs: Record<string, number>;
  /** feature → count per label. */
  features: Record<string, Record<string, number>>;
  /** Total feature occurrences per label. */
  totals: Record<string, number>;
}

export interface CategorizerState {
  version: 1;
  /** Total training documents. */
  docs: number;
  /** Document frequency per feature (also the vocabulary). */
  vocab: Record<string, number>;
  heads: Record<Head, HeadState>;
  /** Reliability bins for the account head (index = floor(confidence*10)). */
  calibration: { n: number; correct: number }[];
  stats: { predictions: number; correct: number };
}

export interface Prediction {
  label: string;
  confidence: number;
  alternatives: { label: string; confidence: number }[];
  /** How many training examples with this payee went to `label`. */
  support: number;
}

const ALPHA = 1; // Laplace smoothing

export function emptyState(): CategorizerState {
  const head = (): HeadState => ({ docs: {}, features: {}, totals: {} });
  return {
    version: 1,
    docs: 0,
    vocab: {},
    heads: { account: head(), class: head(), customerJob: head() },
    calibration: Array.from({ length: 10 }, () => ({ n: 0, correct: 0 })),
    stats: { predictions: 0, correct: 0 },
  };
}

/** Defensive load of persisted JSON (unknown versions → fresh state). */
export function loadState(raw: unknown): CategorizerState {
  const s = raw as CategorizerState | null;
  if (!s || s.version !== 1 || !s.heads || !s.vocab) return emptyState();
  for (const h of HEADS) s.heads[h] ??= { docs: {}, features: {}, totals: {} };
  if (!Array.isArray(s.calibration) || s.calibration.length !== 10) {
    s.calibration = Array.from({ length: 10 }, () => ({ n: 0, correct: 0 }));
  }
  s.stats ??= { predictions: 0, correct: 0 };
  return s;
}

// ---------------------------------------------------------------------------
// Featurization
// ---------------------------------------------------------------------------

/** Bank-statement boilerplate that says nothing about the category. */
const NOISE = new Set([
  'pos', 'purchase', 'debit', 'credit', 'card', 'checkcard', 'visa', 'mastercard', 'mc', 'ach',
  'payment', 'pmt', 'online', 'transfer', 'xfer', 'withdrawal', 'deposit', 'recurring', 'web',
  'id', 'ref', 'trn', 'txn', 'auth', 'ppd', 'ccd', 'des', 'indn', 'co', 'inc', 'llc', 'ltd',
  'corp', 'the', 'and', 'for', 'of', 'to', 'from', 'on', 'at', 'in', 'with', 'via', 'www',
  'com', 'net', 'org', 'us', 'usa', 'pending', 'memo', 'check', 'chk', 'no', 'num',
]);

export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (let tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!tok) continue;
    if (/^\d+$/.test(tok)) continue; // store numbers, check numbers, dates
    tok = tok.replace(/\d+$/, ''); // "amzn12345" → "amzn"
    if (tok.length < 2 || NOISE.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

/** Normalized payee identity: first three meaningful tokens. */
export function payeeKey(payee: string | null | undefined): string | null {
  const toks = tokenize(payee);
  return toks.length ? toks.slice(0, 3).join(' ') : null;
}

export function amountBucket(amount: string | number): number {
  const a = new Decimal(amount || 0).abs();
  if (a.lessThan(1)) return 0;
  return Math.floor(Math.log2(a.toNumber())) + 1;
}

export function featurize(input: PredictInput): string[] {
  const feats = new Set<string>();
  // Payee identity at two granularities: bank lines append cities / store numbers
  // ("SHELL OIL 57444 HOUSTON TX") that the vendor record ("Shell Oil") lacks.
  const ptoks = tokenize(input.payee || input.memo);
  if (ptoks.length >= 1) feats.add(`p1:${ptoks[0]}`);
  if (ptoks.length >= 2) feats.add(`p2:${ptoks[0]} ${ptoks[1]}`);
  for (const t of tokenize(`${input.payee ?? ''} ${input.memo ?? ''}`)) feats.add(`w:${t}`);
  feats.add(`a:${amountBucket(input.amount)}`);
  feats.add(`x:${new Decimal(input.amount || 0).abs().toFixed(2)}`);
  feats.add(`d:${input.direction}`);
  return [...feats];
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

function scoreHead(
  state: CategorizerState,
  head: Head,
  feats: string[],
  allowed?: Set<string>,
): { label: string; posterior: number }[] {
  const hs = state.heads[head];
  const labels = Object.keys(hs.docs).filter((l) => !allowed || allowed.has(l));
  if (labels.length === 0) return [];
  const totalDocs = labels.reduce((a, l) => a + hs.docs[l], 0);
  const vocabSize = Math.max(1, Object.keys(state.vocab).length);
  const known = feats.filter((f) => state.vocab[f] !== undefined);
  const temper = Math.sqrt(Math.max(1, known.length));

  const scores = labels.map((l) => {
    const prior = Math.log(hs.docs[l] / totalDocs);
    const denom = (hs.totals[l] ?? 0) + ALPHA * vocabSize;
    let ll = 0;
    for (const f of known) ll += Math.log(((hs.features[f]?.[l] ?? 0) + ALPHA) / denom);
    return { label: l, score: prior + ll / temper };
  });
  const max = Math.max(...scores.map((s) => s.score));
  const exps = scores.map((s) => ({ label: s.label, e: Math.exp(s.score - max) }));
  const z = exps.reduce((a, s) => a + s.e, 0);
  return exps.map((s) => ({ label: s.label, posterior: s.e / z })).sort((a, b) => b.posterior - a.posterior);
}

function calibrate(state: CategorizerState, raw: number): number {
  const bin = state.calibration[Math.min(9, Math.floor(raw * 10))];
  if (!bin || bin.n < 5) return raw;
  const empirical = (bin.correct + 1) / (bin.n + 2);
  const w = bin.n / (bin.n + 30);
  return raw * (1 - w) + empirical * w;
}

/** Raw (pre-calibration) confidence for one head. */
function predictRaw(
  state: CategorizerState,
  head: Head,
  feats: string[],
  allowed?: Set<string>,
): Prediction | null {
  const ranked = scoreHead(state, head, feats, allowed);
  if (ranked.length === 0) return null;
  const hs = state.heads[head];
  // Most specific payee feature the model has seen (two-token, then first token).
  const pFeat =
    feats.find((f) => f.startsWith('p2:') && state.vocab[f] !== undefined) ??
    feats.find((f) => f.startsWith('p1:') && state.vocab[f] !== undefined);
  const evidence = (label: string) => {
    if (pFeat) return hs.features[pFeat]?.[label] ?? 0;
    // Unknown payee: weak token-level evidence only.
    let best = 0;
    for (const f of feats) if (f.startsWith('w:')) best = Math.max(best, hs.features[f]?.[label] ?? 0);
    return best * 0.5;
  };
  const withConf = ranked.map((r) => {
    const n = evidence(r.label);
    return { label: r.label, confidence: r.posterior * (n / (n + 1)), support: n };
  });
  withConf.sort((a, b) => b.confidence - a.confidence);
  const top = withConf[0];
  return {
    label: top.label,
    confidence: top.confidence,
    support: top.support,
    alternatives: withConf.slice(1, 4).map((a) => ({ label: a.label, confidence: a.confidence })),
  };
}

export interface PredictOptions {
  /** Restrict a head to these labels (e.g. active accounts only). */
  allowed?: Partial<Record<Head, Set<string>>>;
}

export function predict(
  state: CategorizerState,
  input: PredictInput,
  opts: PredictOptions = {},
): Record<Head, Prediction | null> {
  const feats = featurize(input);
  const out = {} as Record<Head, Prediction | null>;
  for (const h of HEADS) {
    const p = predictRaw(state, h, feats, opts.allowed?.[h]);
    if (p && h === 'account') {
      p.confidence = calibrate(state, p.confidence);
      p.alternatives = p.alternatives.map((a) => ({ ...a, confidence: calibrate(state, a.confidence) }));
    }
    out[h] = p;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

/**
 * Incrementally add one categorized example. With `track`, the account head first predicts
 * the example and records hit/miss in the reliability bins (online calibration) — use it
 * for genuinely new user decisions, not for bulk retraining.
 */
export function learn(state: CategorizerState, ex: TrainingExample, opts: { track?: boolean } = {}): void {
  const feats = featurize(ex);
  const acct = ex.labels.account;
  if (opts.track && acct && state.docs > 0) {
    const p = predictRaw(state, 'account', feats);
    if (p) {
      const bin = state.calibration[Math.min(9, Math.floor(p.confidence * 10))];
      bin.n += 1;
      state.stats.predictions += 1;
      if (p.label === acct) {
        bin.correct += 1;
        state.stats.correct += 1;
      }
    }
  }

  state.docs += 1;
  for (const f of feats) state.vocab[f] = (state.vocab[f] ?? 0) + 1;
  for (const h of HEADS) {
    const raw = ex.labels[h];
    if (raw === undefined) continue; // head not observed for this example
    if (h === 'account' && !raw) continue; // account is mandatory
    const label = raw ?? NONE;
    const hs = state.heads[h];
    hs.docs[label] = (hs.docs[label] ?? 0) + 1;
    hs.totals[label] = (hs.totals[label] ?? 0) + feats.length;
    for (const f of feats) {
      const row = (hs.features[f] ??= {});
      row[label] = (row[label] ?? 0) + 1;
    }
  }
}

/** Remove every trace of a label (e.g. an account that was deleted/merged). */
export function dropLabel(state: CategorizerState, head: Head, label: string): void {
  const hs = state.heads[head];
  delete hs.docs[label];
  delete hs.totals[label];
  for (const row of Object.values(hs.features)) delete row[label];
}

export function summary(state: CategorizerState) {
  return {
    docs: state.docs,
    vocabulary: Object.keys(state.vocab).length,
    accounts: Object.keys(state.heads.account.docs).length,
    onlineAccuracy: state.stats.predictions > 0 ? state.stats.correct / state.stats.predictions : null,
    onlinePredictions: state.stats.predictions,
  };
}
