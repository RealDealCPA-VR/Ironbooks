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
import { ITEM_TYPES, type BatchEnterRow, type BatchEnterType, normalizeAmount, normalizeDate } from './batchEnterParse';

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
  /** Items (item lines), sales tax items (tax rates), Sales Tax Codes (name = the code) and jobs. */
  items?: BatchNamedRef[];
  taxRates?: BatchNamedRef[];
  taxCodes?: BatchNamedRef[];
  jobs?: Array<BatchNamedRef & { customerId: string | null }>;
}

export type MatchKind = 'account' | 'customer' | 'vendor' | 'class' | 'item' | 'taxRate';

/** A resolved "Customer" or "Customer:Job"; jobMissing = the job part named no job of that customer. */
export interface CustomerJobMatch {
  customerId: string;
  jobId: string | null;
  jobMissing?: string;
}

export interface BatchMatchers {
  account: (s: string) => string | null;
  accountLabel: (id: string) => string;
  /** 'ar' / 'ap' when the account is Accounts Receivable / Accounts Payable (needs a name). */
  controlSide: (accountId: string) => 'ar' | 'ap' | null;
  className: (s: string) => string | null;
  customer: (s: string) => string | null;
  vendor: (s: string) => string | null;
  item: (s: string) => string | null;
  taxRate: (s: string) => string | null;
  /** Sales Tax Code by its code ("Tax", "Non"). */
  taxCode: (s: string) => string | null;
  /** "Customer" or "Customer:Job" (QB's Customer:Job column). */
  customerJob: (s: string) => CustomerJobMatch | null;
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
  const closestItem = closestMatcher(labels(lists.items ?? []));
  const closestTaxRate = closestMatcher(labels(lists.taxRates ?? []));
  const customerByName = byName(lists.customers);
  const jobsByCustomer = new Map<string, Map<string, string | null>>();
  for (const j of lists.jobs ?? []) {
    if (!j.customerId || !j.name) continue;
    const m = jobsByCustomer.get(j.customerId) ?? jobsByCustomer.set(j.customerId, new Map()).get(j.customerId)!;
    const k = normName(j.name);
    m.set(k, m.has(k) ? null : j.id);
  }
  const matchCustomerJob = (s: string): CustomerJobMatch | null => {
    const whole = customerByName(s);
    if (whole) return { customerId: whole, jobId: null };
    const at = s.indexOf(':');
    if (at < 0) return null;
    const cust = customerByName(s.slice(0, at));
    if (!cust) return null;
    const jobName = s.slice(at + 1).trim();
    if (!jobName) return { customerId: cust, jobId: null };
    const jobId = jobsByCustomer.get(cust)?.get(normName(jobName)) ?? null;
    return jobId ? { customerId: cust, jobId } : { customerId: cust, jobId: null, jobMissing: jobName };
  };
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
    item: memo('suggest-item', closestItem),
    taxRate: memo('suggest-taxRate', closestTaxRate),
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
    customer: memo('customer', customerByName),
    vendor: memo('vendor', byName(lists.vendors)),
    item: memo('item', byName(lists.items ?? [])),
    taxRate: memo('taxRate', byName(lists.taxRates ?? [])),
    taxCode: memo('taxCode', byName(lists.taxCodes ?? [])),
    customerJob: memo('customerJob', matchCustomerJob),
    suggest: (kind: MatchKind, s: string) => suggesters[kind](s),
  };
}

/** One line of a resolved document. Amounts are decimal strings. */
export interface ResolvedBatchLine {
  /** GL account (account lines; an optional override on item lines). */
  accountId: string | null;
  itemId: string | null;
  /** Item lines: units (default 1). */
  quantity: string | null;
  /** Item lines: sales price (invoices, credit memos) or unit cost (purchases); null = from the item / amount. */
  rate: string | null;
  /** Line amount; null on an item line priced by quantity x rate. */
  amount: string | null;
  description: string | null;
  classId: string | null;
  /** Purchases: the line's billable Customer:Job. */
  customerId?: string | null;
  jobId?: string | null;
  /** Invoices / credit memos: Y / N, or the line's Sales Tax Code. Undefined = the item decides. */
  taxable?: boolean;
  salesTaxCodeId?: string | null;
  /** Deposits: the line's Received From name. */
  entityType?: 'customer' | 'vendor' | null;
  entityId?: string | null;
}

/** The document a valid row group (or journal-entry group) will create. */
export type ResolvedBatchDoc =
  | {
      kind: 'expense';
      type: 'check' | 'cc_charge' | 'cc_credit';
      date: string;
      vendorId: string | null;
      payeeName: string | null;
      ref: string | null;
      memo: string | null;
      lines: ResolvedBatchLine[];
    }
  | { kind: 'deposit'; date: string; memo: string | null; lines: ResolvedBatchLine[] }
  | {
      kind: 'invoice' | 'credit_memo';
      customerId: string;
      jobId: string | null;
      ref: string | null;
      date: string;
      memo: string | null;
      classId: string | null;
      /** Sales tax item; undefined = the customer's own (as the form does). */
      taxRateId?: string | null;
      lines: ResolvedBatchLine[];
    }
  | {
      kind: 'bill';
      vendorId: string;
      ref: string | null;
      date: string;
      dueDate: string | null;
      memo: string | null;
      classId: string | null;
      lines: ResolvedBatchLine[];
    }
  | { kind: 'bill_credit'; vendorId: string; ref: string | null; date: string; memo: string | null; lines: ResolvedBatchLine[] }
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

  // Documents: a row starts a new document, and the rows under it are its split lines when they
  // leave Date, Ref and Name blank (deposits: Date blank — Ref is each line's check number), or
  // repeat the same Date + Ref + Name with a Ref given (how a spreadsheet of split lines is usually
  // pasted).
  const groups: Array<{ idx: number[]; key: string }> = [];
  input.rows.forEach((r, i) => {
    const date = r.date?.trim() ?? '';
    const ref = r.ref?.trim() ?? '';
    const name = normName(r.name ?? '');
    const key = `${date}|${ref}|${name}`;
    const last = groups[groups.length - 1];
    const continues = t === 'deposit' ? !date : !date && !ref && !name;
    const same = t !== 'deposit' && ref !== '' && last?.key === key;
    if (last && (continues || same)) last.idx.push(i);
    else groups.push({ idx: [i], key });
  });
  const itemType = ITEM_TYPES.includes(t);
  const sales = t === 'invoice' || t === 'credit_memo';
  const purchase = t === 'check' || t === 'cc_charge' || t === 'cc_credit' || t === 'bill' || t === 'bill_credit';
  const classless = t === 'deposit' || t === 'credit_memo';

  for (const g of groups) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const first = input.rows[g.idx[0]];
    const n = `Row ${rn(g.idx[0])}`;
    const date = normalizeDate(first.date);
    if (!date) errors.push(`${n}: date "${first.date ?? ''}" is not a valid date.`);
    closedWarning(rn(g.idx[0]), date, warnings);
    if (needsBank && !bank) errors.push(`${n}: choose the ${t.startsWith('cc') ? 'credit card' : 'bank'} account first.`);

    // ---- the document's name ----
    let customerId: string | null = null;
    let jobId: string | null = null;
    let vendorId: string | null = null;
    if (sales) {
      const cj = first.name?.trim() ? M.customerJob(first.name) : null;
      customerId = cj?.customerId ?? null;
      jobId = cj?.jobId ?? null;
      if (!customerId) {
        errors.push(`${n}: customer "${first.name ?? ''}" was not found (add it to the customer list first).${first.name ? didYouMean(M.suggest('customer', first.name)) : ''}`);
      } else if (cj?.jobMissing) {
        errors.push(`${n}: job "${cj.jobMissing}" was not found for that customer.`);
      }
    } else if (t === 'bill' || t === 'bill_credit') {
      vendorId = first.name ? M.vendor(first.name) : null;
      if (!vendorId) {
        errors.push(`${n}: vendor "${first.name ?? ''}" was not found (add it to the vendor list first).${first.name ? didYouMean(M.suggest('vendor', first.name)) : ''}`);
      }
    } else if (t === 'check' || t === 'cc_charge' || t === 'cc_credit') {
      vendorId = first.name ? M.vendor(first.name) : null;
      if (!first.name?.trim()) errors.push(`${n}: enter a payee name.`);
      else if (!vendorId) {
        const near = M.suggest('vendor', first.name);
        warnings.push(`${n}: "${first.name.trim()}" is not in your vendor list, so it is saved as a one-time payee.${didYouMean(near)}`);
      }
    }
    let dueDate: string | null = null;
    if (t === 'bill' && first.dueDate) {
      dueDate = normalizeDate(first.dueDate);
      if (!dueDate) errors.push(`${n}: due date "${first.dueDate}" is not a valid date.`);
      else if (date && dueDate < date) errors.push(`${n}: the due date is before the bill date.`);
    }
    let taxRateId: string | null | undefined;
    if (sales && first.taxItem?.trim()) {
      taxRateId = M.taxRate(first.taxItem);
      if (!taxRateId) errors.push(`${n}: sales tax item "${first.taxItem}" was not found.${didYouMean(M.suggest('taxRate', first.taxItem))}`);
    }

    // ---- the lines ----
    const lines: ResolvedBatchLine[] = [];
    for (const i of g.idx) {
      const r = input.rows[i];
      const ln = `Row ${rn(i)}`;
      if (i !== g.idx[0]) {
        if (sales && r.taxItem?.trim() && r.taxItem.trim() !== (first.taxItem ?? '').trim()) {
          errors.push(`${ln}: one ${t === 'invoice' ? 'invoice' : 'credit memo'} has one sales tax item — put it on its first row.`);
        }
        if (t === 'bill' && r.dueDate?.trim() && r.dueDate.trim() !== (first.dueDate ?? '').trim()) {
          errors.push(`${ln}: one bill has one due date — put it on its first row.`);
        }
      }
      const itemId = itemType && r.item?.trim() ? M.item(r.item) : null;
      if (itemType && r.item?.trim() && !itemId) errors.push(`${ln}: item "${r.item}" was not found.${didYouMean(M.suggest('item', r.item))}`);
      if (!itemType && r.item?.trim()) errors.push(`${ln}: deposits have no item lines — clear the Item column.`);
      const accountId = r.account?.trim() ? M.account(r.account) : null;
      if (r.account?.trim() && !accountId) errors.push(accountError(ln, r.account));
      else if (!accountId && !(itemType && r.item?.trim())) errors.push(accountError(ln, r.account));
      else if (accountId && bank && accountId === bank) {
        errors.push(`${ln}: the account can't be the same as the ${t.startsWith('cc') ? 'credit card' : 'bank'} account.`);
      }
      const isItemLine = Boolean(r.item?.trim());

      const amount = r.amount?.trim() ? normalizeAmount(r.amount) : null;
      if (r.amount?.trim() && amount === null) errors.push(`${ln}: amount "${r.amount}" is not a number.`);
      else if (subCent(amount)) errors.push(`${ln}: ${SUB_CENT}`);
      else if (amount !== null && !Money.gt(amount, 0)) errors.push(`${ln}: amount must be greater than zero.`);
      else if (amount === null && !isItemLine) errors.push(`${ln}: amount "${r.amount ?? ''}" is not a number.`);

      let quantity: string | null = null;
      let rate: string | null = null;
      if (r.quantity?.trim() || r.rate?.trim()) {
        if (!isItemLine) errors.push(`${ln}: Qty and Rate go with an item — choose the item, or clear them.`);
      }
      if (isItemLine) {
        quantity = r.quantity?.trim() ? normalizeAmount(r.quantity) : '1';
        if (quantity === null) errors.push(`${ln}: quantity "${r.quantity}" is not a number.`);
        else if (!Money.gt(quantity, 0)) errors.push(`${ln}: quantity must be greater than zero.`);
        else if (/\.\d{5,}$/.test(quantity)) errors.push(`${ln}: quantity can have at most 4 decimals.`);
        rate = r.rate?.trim() ? normalizeAmount(r.rate) : null;
        if (r.rate?.trim() && rate === null) errors.push(`${ln}: rate "${r.rate}" is not a number.`);
        else if (rate !== null && Money.lt(rate, 0)) errors.push(`${ln}: rate can't be negative.`);
        else if (rate !== null && /\.\d{6,}$/.test(rate)) errors.push(`${ln}: rate can have at most 5 decimals.`);
        if (purchase && rate === null && amount === null) errors.push(`${ln}: enter the item's cost (Rate) or the Amount.`);
        if (sales && rate === null && amount !== null && quantity !== null && Money.gt(quantity, 0)) {
          // Amount without a rate: the rate is amount / quantity, when that is exact to 5 decimals.
          const q = Money.of(quantity);
          const per = Money.of(amount).div(q);
          if (per.decimalPlaces() > 5 || !per.times(q).equals(Money.of(amount))) {
            errors.push(`${ln}: ${amount} can't be split evenly over ${quantity} — enter the Rate.`);
          } else rate = per.toFixed(Math.max(2, per.decimalPlaces()));
        }
        if (rate !== null && amount !== null && quantity !== null && !errors.length) {
          const computed = Money.round2(Money.of(quantity).times(Money.of(rate)));
          if (!computed.equals(Money.of(amount))) {
            errors.push(`${ln}: Qty x Rate is ${computed.toFixed(2)}, not ${amount}. Fix one of them (or leave Amount blank).`);
          }
        }
      }

      const classId = r.className?.trim() && !classless ? M.className(r.className) : null;
      if (r.className?.trim() && classless) {
        errors.push(`${ln}: ${t === 'deposit' ? 'deposits' : 'credit memos'} don't keep a class on their lines — clear the Class column.`);
      } else if (r.className?.trim() && !classId) {
        errors.push(`${ln}: class "${r.className}" was not found.${didYouMean(M.suggest('class', r.className))}`);
      }

      const line: ResolvedBatchLine = {
        accountId,
        itemId,
        quantity,
        rate,
        amount,
        description: r.memo?.trim() || null,
        classId,
      };

      if (purchase && r.customerJob?.trim()) {
        const cj = M.customerJob(r.customerJob);
        if (!cj) errors.push(`${ln}: Customer:Job "${r.customerJob}" was not found.${didYouMean(M.suggest('customer', r.customerJob.split(':')[0]))}`);
        else if (cj.jobMissing) errors.push(`${ln}: job "${cj.jobMissing}" was not found for that customer.`);
        else {
          line.customerId = cj.customerId;
          line.jobId = cj.jobId;
        }
      } else if (!purchase && r.customerJob?.trim()) {
        errors.push(`${ln}: this type has no Customer:Job column on its lines.`);
      }

      if (sales) {
        const tc = r.taxCode?.trim() ?? '';
        if (tc) {
          const yes = /^(y|yes|true|t|taxable)$/i.test(tc);
          const no = /^(n|no|false|f|non|non-taxable|nontaxable)$/i.test(tc);
          const codeId = M.taxCode(tc);
          if (codeId) line.salesTaxCodeId = codeId;
          else if (yes) line.taxable = true;
          else if (no) line.taxable = false;
          else errors.push(`${ln}: tax code "${tc}" was not found (use a Sales Tax Code such as Tax / Non, or Y / N).`);
        } else if (!isItemLine) {
          // A plain account line with no tax code is not taxed (as before items were added).
          line.taxable = false;
        }
      } else if (r.taxCode?.trim() || r.taxItem?.trim()) {
        errors.push(`${ln}: only invoices and credit memos have sales tax columns.`);
      }

      if (t === 'deposit') {
        // QB "Received From": a name that is exactly one customer or vendor is kept as the line's
        // name; anything else stays in the line's description, as before.
        const name = r.name?.trim() ?? '';
        const cust = name ? M.customer(name) : null;
        const vend = name ? M.vendor(name) : null;
        if (cust && !vend) Object.assign(line, { entityType: 'customer', entityId: cust });
        else if (vend && !cust) Object.assign(line, { entityType: 'vendor', entityId: vend });
        const ref = r.ref?.trim();
        line.description =
          [line.entityId ? null : name || null, r.memo?.trim() || null, ref ? `Chk No. ${ref}` : null].filter(Boolean).join(' — ') || null;
      }
      lines.push(line);
    }

    if (errors.length) {
      jobs.push({ rows: g.idx, errors, warnings });
      continue;
    }
    const memo = first.memo?.trim() || null;
    const ref = first.ref?.trim() || null;
    const firstClass = lines[0]?.classId ?? null;
    let doc: ResolvedBatchDoc;
    switch (t) {
      case 'check':
      case 'cc_charge':
      case 'cc_credit':
        doc = { kind: 'expense', type: t, date: date!, vendorId, payeeName: vendorId ? null : first.name!.trim(), ref, memo, lines };
        break;
      case 'deposit':
        doc = { kind: 'deposit', date: date!, memo, lines };
        break;
      case 'invoice':
      case 'credit_memo':
        doc = {
          kind: t,
          customerId: customerId!,
          jobId,
          ref,
          date: date!,
          memo,
          classId: t === 'invoice' ? firstClass : null,
          ...(taxRateId !== undefined ? { taxRateId } : {}),
          lines,
        };
        break;
      case 'bill':
        doc = { kind: 'bill', vendorId: vendorId!, ref, date: date!, dueDate, memo, classId: firstClass, lines };
        break;
      default:
        doc = { kind: 'bill_credit', vendorId: vendorId!, ref, date: date!, memo, lines };
        break;
    }
    jobs.push({ rows: g.idx, errors, warnings, doc });
  }
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

/**
 * After a partial save the grid drops saved and blank rows, so the kept rows move up. Re-key the
 * per-row errors from old grid index to new index (keptOldIdx[k] is the old index of new row k) and
 * renumber the "Row N:" / "Rows N–M:" prefixes, which carry 1-based old grid row numbers, so each
 * message still names the row it sits on.
 */
export function compactRowErrors(errs: Map<number, string[]>, keptOldIdx: number[]): Map<number, string[]> {
  const oldToNew = new Map(keptOldIdx.map((oldIdx, k) => [oldIdx, k]));
  const rowNumber = (j: number) => (oldToNew.get(j) ?? j) + 1;
  const out = new Map<number, string[]>();
  keptOldIdx.forEach((oldIdx, k) => {
    const e = errs.get(oldIdx);
    if (e) out.set(k, e.map((m) => renumberRowMessage(m, rowNumber)));
  });
  return out;
}
