/**
 * Batch Enter Transactions — pure row resolution shared by the grid UI (live per-row checks while
 * typing or after a paste) and the service (lib/services/accountant/batchEnter.ts), so the screen
 * and the server always agree on what a row means. No DB imports.
 *
 *  - createBatchMatchers: turn the company's lists into name/number matchers (accounts by number,
 *    name or "number · name"; customers, vendors and classes by name), with "did you mean"
 *    suggestions for near misses.
 *  - resolveBatchRows: validate every row and resolve it into the document it will create
 *    (check, deposit, card charge/credit, invoice, credit memo, bill, bill credit or journal entry).
 */
import { Money } from '@/lib/money';
import { type BatchEnterRow, type BatchEnterType, normalizeAmount, normalizeDate } from './batchEnterParse';

export interface BatchAccountRef {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
}
export interface BatchNamedRef {
  id: string;
  name: string | null;
}
export interface BatchLookupLists {
  accounts: BatchAccountRef[];
  customers: BatchNamedRef[];
  vendors: BatchNamedRef[];
  classes: BatchNamedRef[];
}

export type MatchKind = 'account' | 'customer' | 'vendor' | 'class';

export interface BatchMatchers {
  account: (s: string) => string | null;
  accountLabel: (id: string) => string;
  /** 'ar' / 'ap' when the account is Accounts Receivable / Accounts Payable (needs a name). */
  controlSide: (accountId: string) => 'ar' | 'ap' | null;
  className: (s: string) => string | null;
  customer: (s: string) => string | null;
  vendor: (s: string) => string | null;
  /** Closest existing entry for a value that did not match (for "did you mean"), or null. */
  suggest: (kind: MatchKind, s: string) => string | null;
}

export const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Edit distance (Levenshtein). With `max`, gives up as soon as the distance must exceed it and
 * returns `max + 1` (exact whenever the true distance is <= max).
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Character counts in 37 buckets (a–z, 0–9, everything else) for a cheap edit-distance bound. */
function charBag(s: string): Uint16Array {
  const bag = new Uint16Array(37);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    bag[c >= 97 && c <= 122 ? c - 97 : c >= 48 && c <= 57 ? c - 22 : 36]++;
  }
  return bag;
}
/** Bag distance: a lower bound of the edit distance (each edit changes at most one count each way). */
function bagDistance(a: Uint16Array, b: Uint16Array): number {
  let more = 0;
  let less = 0;
  for (let i = 0; i < 37; i++) {
    const d = a[i] - b[i];
    if (d > 0) more += d;
    else less -= d;
  }
  return more > less ? more : less;
}

/**
 * A reusable "closest label" search over a fixed list: labels are normalized once, and the
 * near-miss pass skips labels that their length or letter counts already rule out, and stops each
 * comparison as soon as it can't beat the best so far — so a miss costs a quick scan of the list,
 * not a full Levenshtein per name.
 */
export function closestMatcher(labels: string[]): (query: string) => string | null {
  const norms = labels.map(normName);
  const bags = norms.map(charBag);
  return (query: string) => {
    const q = normName(query);
    if (!q) return null;
    let startHit = -1;
    let starts = 0;
    let containsHit = -1;
    let contains = 0;
    for (let i = 0; i < norms.length; i++) {
      if (norms[i].startsWith(q)) {
        if (starts++ === 0) startHit = i;
      }
      if (norms[i].includes(q)) {
        if (contains++ === 0) containsHit = i;
      }
    }
    if (starts === 1) return labels[startHit];
    if (contains === 1) return labels[containsHit];
    const limit = Math.max(2, Math.floor(q.length / 4));
    const qBag = charBag(q);
    let best = -1;
    let bestD = limit + 1; // only distances within the limit count
    for (let i = 0; i < norms.length && bestD > 0; i++) {
      if (Math.abs(norms[i].length - q.length) >= bestD) continue;
      if (bagDistance(qBag, bags[i]) >= bestD) continue;
      const d = editDistance(q, norms[i], bestD - 1);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? labels[best] : null;
  };
}

/** Best near match among labels: prefix/contains first, then a small edit distance. */
export function closestLabel(query: string, labels: string[]): string | null {
  return closestMatcher(labels)(query);
}

/**
 * Build the matchers for a company's lists. Every lookup (`account`, `customer`, `vendor`,
 * `className`, `suggest`) is memoized per input for the life of the matchers: the grid re-checks
 * every row on each keystroke and the "did you mean" search is O(list size), so without the cache
 * a pasted batch of one-time payees costs rows × list size per keystroke. With it, only the cell
 * that changed is matched again.
 */
export function createBatchMatchers(
  lists: BatchLookupLists,
  opts: { /** Called on every cache miss (tests use it to prove lookups are cached). */ onMiss?: (kind: string) => void } = {},
): BatchMatchers {
  const acct = lists.accounts;
  const memo = <R>(kind: string, fn: (s: string) => R, key: (s: string) => string = normName) => {
    const cache = new Map<string, R>();
    return (s: string): R => {
      const k = `${kind}|${key(s)}`;
      if (cache.has(k)) return cache.get(k) as R;
      opts.onMiss?.(kind);
      const v = fn(s);
      cache.set(k, v);
      return v;
    };
  };
  const byName = (rows: BatchNamedRef[]) => {
    const m = new Map<string, string | null>();
    for (const r of rows) {
      const k = normName(r.name ?? '');
      if (!k) continue;
      m.set(k, m.has(k) ? null : r.id); // ambiguous duplicate names resolve to null
    }
    return (s: string) => m.get(normName(s)) ?? null;
  };
  const labels = (rows: BatchNamedRef[]) => rows.map((r) => r.name ?? '').filter(Boolean);
  const accountLabel = (a: BatchAccountRef) => `${a.code} · ${a.name}`;
  const byId = new Map(acct.map((a) => [a.id, a]));
  const closestAcctName = closestMatcher(acct.map((a) => a.name));
  const closestAcctLabel = closestMatcher(acct.map(accountLabel));
  const closestCustomer = closestMatcher(labels(lists.customers));
  const closestVendor = closestMatcher(labels(lists.vendors));
  const closestClass = closestMatcher(labels(lists.classes));
  const suggesters: Record<MatchKind, (s: string) => string | null> = {
    account: memo('suggest-account', (s) => {
      // Compare against the bare names first ("Ofice Suplies"), then "number · name".
      const name = closestAcctName(s);
      const hit = name ? acct.find((a) => a.name === name) : undefined;
      return hit ? accountLabel(hit) : closestAcctLabel(s);
    }),
    customer: memo('suggest-customer', closestCustomer),
    vendor: memo('suggest-vendor', closestVendor),
    class: memo('suggest-class', closestClass),
  };
  // Account codes are compared exactly, so that cache is keyed by the trimmed text, not the
  // case-folded name.
  const matchAccount = (s: string) => {
    const t = s.trim();
    if (!t) return null;
    const code = t.split(/\s*[·:\-–]\s+|\s+/)[0];
    return (
      acct.find((a) => a.code === t)?.id ??
      acct.find((a) => normName(a.name) === normName(t))?.id ??
      acct.find((a) => normName(accountLabel(a)) === normName(t) || normName(`${a.code} ${a.name}`) === normName(t))?.id ??
      acct.find((a) => a.code === code && t.length > code.length && normName(t).endsWith(normName(a.name)))?.id ??
      null
    );
  };
  return {
    account: memo('account', matchAccount, (s) => s.trim()),
    accountLabel: (id: string) => {
      const a = byId.get(id);
      return a ? accountLabel(a) : '';
    },
    controlSide: (id: string) => {
      const a = byId.get(id);
      if (a?.type === 'asset' && a.subtype === 'accounts_receivable') return 'ar';
      if (a?.type === 'liability' && a.subtype === 'accounts_payable') return 'ap';
      return null;
    },
    className: memo('class', byName(lists.classes)),
    customer: memo('customer', byName(lists.customers)),
    vendor: memo('vendor', byName(lists.vendors)),
    suggest: (kind: MatchKind, s: string) => suggesters[kind](s),
  };
}

/** The document a valid row (or journal-entry group) will create. Amounts are decimal strings. */
export type ResolvedBatchDoc =
  | {
      kind: 'expense';
      type: 'check' | 'cc_charge' | 'cc_credit';
      date: string;
      vendorId: string | null;
      payeeName: string | null;
      ref: string | null;
      memo: string | null;
      accountId: string;
      amount: string;
      classId: string | null;
    }
  | { kind: 'deposit'; date: string; accountId: string; amount: string; description: string | null; memo: string | null }
  | {
      kind: 'invoice' | 'credit_memo';
      customerId: string;
      ref: string | null;
      date: string;
      memo: string | null;
      accountId: string;
      amount: string;
      classId: string | null;
    }
  | {
      kind: 'bill';
      vendorId: string;
      ref: string | null;
      date: string;
      dueDate: string | null;
      memo: string | null;
      accountId: string;
      amount: string;
      classId: string | null;
    }
  | { kind: 'bill_credit'; vendorId: string; ref: string | null; date: string; memo: string | null; accountId: string; amount: string }
  | {
      kind: 'journal';
      date: string;
      description: string;
      reference: string | null;
      lines: Array<{
        accountId: string;
        debit: string | null;
        credit: string | null;
        memo: string | null;
        classId: string | null;
        entityType?: 'customer' | 'vendor';
        entityId?: string;
      }>;
    };

export interface ResolvedBatchJob {
  /** 0-based row indexes this job covers (journal entries span several rows). */
  rows: number[];
  errors: string[];
  /** Not blocking (e.g. a one-time payee, a date on/before the closing date). */
  warnings: string[];
  /** Present when there are no errors. */
  doc?: ResolvedBatchDoc;
}

export interface ResolveBatchInput {
  type: BatchEnterType;
  bankAccountId?: string | null;
  rows: BatchEnterRow[];
}

export interface ResolveBatchOptions {
  /** Company closing date ('YYYY-MM-DD'): rows on/before it get a warning. */
  closingDate?: string | null;
  /**
   * 1-based row number to print in messages for the 0-based input row i (default i + 1). The
   * Batch Enter grid skips blank rows before resolving, so it maps back to the grid row number.
   */
  rowNumber?: (i: number) => number;
}

const didYouMean = (s: string | null) => (s ? ` Did you mean "${s}"?` : '');
/** More than 2 decimal places (e.g. "0.001") — money is kept to the cent, so such a row is refused. */
const subCent = (v: string | null) => v !== null && /\.\d{3,}$/.test(v);
const SUB_CENT = 'amounts can have at most 2 decimals.';

/** Validate and resolve every row into the document it will create (no writes). */
export function resolveBatchRows(input: ResolveBatchInput, M: BatchMatchers, opts: ResolveBatchOptions = {}): ResolvedBatchJob[] {
  const jobs: ResolvedBatchJob[] = [];
  const t = input.type;
  const needsBank = t === 'check' || t === 'deposit' || t === 'cc_charge' || t === 'cc_credit';
  const bank = input.bankAccountId ?? null;
  /** 1-based row number shown in messages for 0-based input row i. */
  const rn = opts.rowNumber ?? ((i: number) => i + 1);
  const closedWarning = (rowNo: number, date: string | null, warnings: string[]) => {
    if (date && opts.closingDate && date <= opts.closingDate) {
      warnings.push(`Row ${rowNo}: dated on or before the closing date (${opts.closingDate}) — saving needs the closing date password.`);
    }
  };
  const accountError = (n: string, raw: string | undefined) =>
    `${n}: account "${raw ?? ''}" was not found.${raw?.trim() ? didYouMean(M.suggest('account', raw)) : ''}`;

  if (t === 'journal') {
    // Consecutive rows with the same date + ref form one entry; a row with both blank continues
    // the entry above it (how split lines are usually pasted).
    const groups: Array<{ idx: number[]; key: string }> = [];
    input.rows.forEach((r, i) => {
      const date = r.date?.trim() ?? '';
      const ref = r.ref?.trim() ?? '';
      const key = `${date}|${ref}`;
      const last = groups[groups.length - 1];
      if (last && ((!date && !ref) || last.key === key)) last.idx.push(i);
      else groups.push({ idx: [i], key });
    });
    for (const g of groups) {
      const errors: string[] = [];
      const warnings: string[] = [];
      const first = input.rows[g.idx[0]];
      const date = normalizeDate(first.date);
      if (!date) errors.push(`Row ${rn(g.idx[0])}: date "${first.date ?? ''}" is not a valid date.`);
      closedWarning(rn(g.idx[0]), date, warnings);
      const lines = g.idx.map((i) => {
        const r = input.rows[i];
        const accountId = r.account ? M.account(r.account) : null;
        if (!accountId) errors.push(accountError(`Row ${rn(i)}`, r.account));
        const debit = normalizeAmount(r.debit);
        const credit = normalizeAmount(r.credit);
        if (r.debit && debit === null) errors.push(`Row ${rn(i)}: debit "${r.debit}" is not a number.`);
        if (r.credit && credit === null) errors.push(`Row ${rn(i)}: credit "${r.credit}" is not a number.`);
        if (subCent(debit) || subCent(credit)) errors.push(`Row ${rn(i)}: ${SUB_CENT}`);
        if (!debit && !credit) errors.push(`Row ${rn(i)}: enter a debit or a credit.`);
        const classId = r.className ? M.className(r.className) : null;
        if (r.className && !classId) errors.push(`Row ${rn(i)}: class "${r.className}" was not found.${didYouMean(M.suggest('class', r.className))}`);
        // QB "Name" column: A/R lines need a customer and A/P lines a vendor; on other lines a
        // name that matches exactly one customer or vendor is attached too.
        let entity: { entityType: 'customer' | 'vendor'; entityId: string } | null = null;
        const name = r.name?.trim() ?? '';
        const side = accountId ? M.controlSide(accountId) : null;
        if (name) {
          const cust = M.customer(name);
          const vend = M.vendor(name);
          if (side === 'ar') {
            if (cust) entity = { entityType: 'customer', entityId: cust };
            else errors.push(`Row ${rn(i)}: customer "${name}" was not found (an Accounts Receivable line needs a customer).${didYouMean(M.suggest('customer', name))}`);
          } else if (side === 'ap') {
            if (vend) entity = { entityType: 'vendor', entityId: vend };
            else errors.push(`Row ${rn(i)}: vendor "${name}" was not found (an Accounts Payable line needs a vendor).${didYouMean(M.suggest('vendor', name))}`);
          } else if (cust && !vend) entity = { entityType: 'customer', entityId: cust };
          else if (vend && !cust) entity = { entityType: 'vendor', entityId: vend };
        } else if (side) {
          errors.push(
            `Row ${rn(i)}: an Accounts ${side === 'ar' ? 'Receivable line needs a customer' : 'Payable line needs a vendor'} in the Name column.`,
          );
        }
        return {
          accountId: accountId ?? '',
          debit: debit ?? null,
          credit: credit ?? null,
          memo: r.memo || r.name || null,
          classId,
          ...(entity ?? {}),
        };
      });
      if (g.idx.length < 2) errors.push(`Row ${rn(g.idx[0])}: a journal entry needs at least two rows (use the same Ref on each row).`);
      const td = lines.reduce((s, l) => s.plus(Money.of(l.debit ?? 0)), Money.zero());
      const tc = lines.reduce((s, l) => s.plus(Money.of(l.credit ?? 0)), Money.zero());
      if (errors.length === 0 && !td.equals(tc)) {
        errors.push(`Rows ${rn(g.idx[0])}–${rn(g.idx[g.idx.length - 1])}: debits (${td.toFixed(2)}) and credits (${tc.toFixed(2)}) must be equal.`);
      }
      jobs.push({
        rows: g.idx,
        errors,
        warnings,
        doc: errors.length
          ? undefined
          : {
              kind: 'journal',
              date: date!,
              description: first.memo?.trim() || `Batch journal entry${first.ref ? ` ${first.ref}` : ''}`,
              reference: first.ref?.trim() || null,
              lines,
            },
      });
    }
    return jobs;
  }

  input.rows.forEach((r, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const n = `Row ${rn(i)}`;
    const date = normalizeDate(r.date);
    if (!date) errors.push(`${n}: date "${r.date ?? ''}" is not a valid date.`);
    closedWarning(rn(i), date, warnings);
    const accountId = r.account ? M.account(r.account) : null;
    if (!accountId) errors.push(accountError(n, r.account));
    else if (bank && accountId === bank) errors.push(`${n}: the account can't be the same as the ${t.startsWith('cc') ? 'credit card' : 'bank'} account.`);
    const amount = normalizeAmount(r.amount);
    if (amount === null) errors.push(`${n}: amount "${r.amount ?? ''}" is not a number.`);
    else if (subCent(amount)) errors.push(`${n}: ${SUB_CENT}`);
    else if (!Money.gt(amount, 0)) errors.push(`${n}: amount must be greater than zero.`);
    const classId = r.className ? M.className(r.className) : null;
    if (r.className && !classId) errors.push(`${n}: class "${r.className}" was not found.${didYouMean(M.suggest('class', r.className))}`);
    if (needsBank && !bank) errors.push(`${n}: choose the ${t.startsWith('cc') ? 'credit card' : 'bank'} account first.`);
    let customerId: string | null = null;
    let vendorId: string | null = null;
    if (t === 'invoice' || t === 'credit_memo') {
      customerId = r.name ? M.customer(r.name) : null;
      if (!customerId) {
        errors.push(`${n}: customer "${r.name ?? ''}" was not found (add it to the customer list first).${r.name ? didYouMean(M.suggest('customer', r.name)) : ''}`);
      }
    } else if (t === 'bill' || t === 'bill_credit') {
      vendorId = r.name ? M.vendor(r.name) : null;
      if (!vendorId) {
        errors.push(`${n}: vendor "${r.name ?? ''}" was not found (add it to the vendor list first).${r.name ? didYouMean(M.suggest('vendor', r.name)) : ''}`);
      }
    } else if (t === 'check' || t === 'cc_charge' || t === 'cc_credit') {
      vendorId = r.name ? M.vendor(r.name) : null;
      if (!r.name?.trim()) errors.push(`${n}: enter a payee name.`);
      else if (!vendorId) {
        const near = M.suggest('vendor', r.name);
        warnings.push(`${n}: "${r.name.trim()}" is not in your vendor list, so it is saved as a one-time payee.${didYouMean(near)}`);
      }
    }
    let dueDate: string | null = null;
    if (t === 'bill' && r.dueDate) {
      dueDate = normalizeDate(r.dueDate);
      if (!dueDate) errors.push(`${n}: due date "${r.dueDate}" is not a valid date.`);
      else if (date && dueDate < date) errors.push(`${n}: the due date is before the bill date.`);
    }
    if (errors.length) {
      jobs.push({ rows: [i], errors, warnings });
      return;
    }
    const memo = r.memo?.trim() || null;
    let doc: ResolvedBatchDoc;
    switch (t) {
      case 'check':
      case 'cc_charge':
      case 'cc_credit':
        doc = {
          kind: 'expense',
          type: t,
          date: date!,
          vendorId,
          payeeName: vendorId ? null : r.name!.trim(),
          ref: r.ref?.trim() || null,
          memo,
          accountId: accountId!,
          amount: amount!,
          classId,
        };
        break;
      case 'deposit':
        doc = {
          kind: 'deposit',
          date: date!,
          accountId: accountId!,
          amount: amount!,
          description: [r.name?.trim(), memo].filter(Boolean).join(' — ') || null,
          memo,
        };
        break;
      case 'invoice':
      case 'credit_memo':
        doc = { kind: t, customerId: customerId!, ref: r.ref?.trim() || null, date: date!, memo, accountId: accountId!, amount: amount!, classId };
        break;
      case 'bill':
        doc = { kind: 'bill', vendorId: vendorId!, ref: r.ref?.trim() || null, date: date!, dueDate, memo, accountId: accountId!, amount: amount!, classId };
        break;
      case 'bill_credit':
        doc = { kind: 'bill_credit', vendorId: vendorId!, ref: r.ref?.trim() || null, date: date!, memo, accountId: accountId!, amount: amount! };
        break;
    }
    jobs.push({ rows: [i], errors, warnings, doc });
  });
  return jobs;
}

/** Per-grid-row messages from resolved jobs (a journal job's messages go on each of its rows). */
export function messagesByRow(jobs: ResolvedBatchJob[]): Map<number, { errors: string[]; warnings: string[] }> {
  const out = new Map<number, { errors: string[]; warnings: string[] }>();
  for (const j of jobs) {
    for (const i of j.rows) out.set(i, { errors: j.errors, warnings: j.warnings });
  }
  return out;
}

/**
 * Rewrite the leading "Row N:" / "Rows N–M:" of a message using rowNumber (N is 1-based in the
 * message; rowNumber takes the 0-based input row). Used by the grid for server messages, which
 * number rows by their position among the rows sent (blank grid rows are not sent).
 */
export function renumberRowMessage(text: string, rowNumber: (i: number) => number): string {
  return text.replace(/^Rows? (\d+)(?:[–-](\d+))?:/, (_m, a: string, b: string | undefined) => {
    const from = rowNumber(Number(a) - 1);
    if (b === undefined) return `Row ${from}:`;
    return `Rows ${from}–${rowNumber(Number(b) - 1)}:`;
  });
}
