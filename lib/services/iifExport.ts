/**
 * IIF export (QB Desktop "File > Utilities > Export > Lists to IIF Files" parity, plus a
 * general-journal transaction export).
 *
 * Writes QuickBooks' own IIF codes (ACCNTTYPE BANK/AR/OCASSET/…, INVITEMTYPE SERV/PART/…) so
 * QuickBooks Desktop can read the file, and everything our importer (qbImport.importIIF)
 * needs to rebuild the same lists — the round trip is covered by iifExport.test.ts:
 *   ACCNT (full "Parent:Sub" names), CLASS, CTYPE, VTYPE, SALESREP, CUSTNAMEDICT, CUST
 *   (bill-to / ship-to, terms, tax, limit, type, contacts, custom fields, inactive), VEND, EMP,
 *   INVITEM + INVITEMCOMP (group components / assembly BOMs), and TRNS/SPL/ENDTRNS general
 *   journal entries for a date range.
 *
 * Sensitive data: SSNs and vendor tax IDs are written only when the user may see them in full
 * (Users & Roles "sensitive payroll data"); otherwise the column is left blank, never masked.
 */
import { and, asc, eq, gte, inArray, isNull, like, lte, notLike, or } from 'drizzle-orm';
import {
  accounts,
  assemblyComponents,
  classes,
  customerTypes,
  customers,
  employees,
  inventoryLayers,
  items,
  journalEntries,
  journalEntryLines,
  otherNames,
  paymentTerms,
  priceLevels,
  salesReps,
  salesTaxCodes,
  taxRates,
  vendorTypes,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, validation } from './_base';
import { taxIdFor } from './access';
import { exportOtherListSections } from './qbIifLists';

// ---------------------------------------------------------------------------
// Low-level writer
// ---------------------------------------------------------------------------

/** IIF cells cannot contain tabs or line breaks; collapse them to spaces. */
export function iifCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\t\r\n]+/g, ' ').trim();
}

class IifWriter {
  private lines: string[] = [];
  section(name: string, cols: string[], rows: Array<Record<string, unknown>>) {
    if (!rows.length) return;
    this.lines.push(`!${name}\t${cols.join('\t')}`);
    for (const r of rows) this.lines.push([name, ...cols.map((c) => iifCell(r[c]))].join('\t'));
  }
  raw(line: string) {
    this.lines.push(line);
  }
  toString() {
    return this.lines.join('\r\n') + (this.lines.length ? '\r\n' : '');
  }
}

/** Date → QuickBooks M/D/YYYY. */
export function iifDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/** 'net_30' → 'Net 30', 'due_on_receipt' → 'Due on receipt'. */
export function displayTerms(key: string | null | undefined): string {
  if (!key) return '';
  if (key === 'due_on_receipt') return 'Due on receipt';
  const s = key.replace(/pct/g, '%').replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Our (type, subtype) → QuickBooks ACCNTTYPE. */
export function qbAccountType(type: string, subtype: string): string {
  // wave2 foundation QB account types (lib/accountTypes.ts): non-posting, other asset, long term
  // liability and other expense have their own QuickBooks codes.
  if (subtype === 'non_posting') return 'NONPOSTING';
  switch (type) {
    case 'asset':
      if (subtype === 'checking' || subtype === 'savings') return 'BANK';
      if (subtype === 'accounts_receivable') return 'AR';
      if (subtype === 'fixed_assets') return 'FIXASSET';
      if (subtype === 'other_asset') return 'OASSET';
      return 'OCASSET';
    case 'liability':
      if (subtype === 'accounts_payable') return 'AP';
      if (subtype === 'credit_card') return 'CCARD';
      if (subtype === 'long_term_liability') return 'LTLIAB';
      return 'OCLIAB';
    case 'equity':
      return 'EQUITY';
    case 'revenue':
      return subtype === 'other_income' ? 'EXINC' : 'INC';
    case 'expense':
      if (subtype === 'cost_of_goods_sold') return 'COGS';
      return subtype === 'other_expense' ? 'EXEXP' : 'EXP';
    default:
      return 'EXP';
  }
}

/** Our item type → QuickBooks INVITEMTYPE. */
export function qbItemType(type: string, hasBom: boolean): string {
  switch (type) {
    case 'service': return 'SERV';
    case 'inventory': return hasBom ? 'ASSEMBLY' : 'PART';
    case 'non_inventory': return 'NONINV';
    case 'other_charge': return 'OTHC';
    case 'discount': return 'DISC';
    case 'subtotal': return 'SUBT';
    case 'payment': return 'PMT';
    case 'sales_tax': return 'STAX';
    case 'bundle': return 'GRP';
    default: return 'NONINV';
  }
}

function pathResolver<T extends { id: string; name: string; parentId: string | null }>(rows: T[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (id: string | null | undefined): string => {
    if (!id) return '';
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(':');
  };
}

/** Address object → up to 5 QB address lines (street lines, "City, ST zip", country). */
function addressLines(addr: Record<string, unknown> | null | undefined): string[] {
  if (!addr) return [];
  const a = addr as Record<string, string | undefined>;
  const street = [a.line1 ?? a.street, a.line2].filter((x) => x && String(x).trim());
  const cityLine = [a.city ? `${a.city},` : '', a.state ?? '', a.zip ?? ''].filter(Boolean).join(' ').replace(/,$/, '').trim();
  return [...street, cityLine, a.country ?? ''].filter((x) => x && String(x).trim()).slice(0, 5) as string[];
}

const CONTACT_FIELDS: Record<string, string> = {
  Contact: 'CONT1',
  'Alt. Contact': 'CONT2',
  'Alt. Phone': 'PHONE2',
  Fax: 'FAXNUM',
  Salutation: 'SALUTATION',
  'First Name': 'FIRSTNAME',
  'M.I.': 'MIDINIT',
  'Last Name': 'LASTNAME',
  'Resale Number': 'RESALENUM',
  Rep: 'REP',
  'Print on Check As': 'PRINTAS',
};

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export type IifListName = 'accounts' | 'classes' | 'customers' | 'vendors' | 'items' | 'employees' | 'types' | 'reps' | 'other_lists';

/**
 * 'other_lists' = TERMS, OTHERNAME, SHIPMETH, PAYMETH, CUSTMSG, SALESTAXCODE, JOBTYPE, VEH,
 * PRICELEVEL and TODO (lib/services/qbIifLists.ts). Written before customers / vendors so a
 * re-import links their terms, tax codes and price levels.
 */
export const IIF_EXPORT_LISTS: IifListName[] = ['accounts', 'classes', 'types', 'reps', 'other_lists', 'customers', 'vendors', 'items', 'employees'];

/** Build an IIF document with the requested lists (default: all). */
export async function exportListsIif(ctx: ServiceContext, lists: IifListName[] = IIF_EXPORT_LISTS): Promise<string> {
  const w = new IifWriter();
  const want = new Set(lists);

  if (want.has('accounts')) {
    const rows = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId)).orderBy(asc(accounts.code));
    const pathOf = pathResolver(rows);
    const depth = (id: string) => pathOf(id).split(':').length;
    // OBAMOUNT: each account's opening balance entry (sourceRef "account:<id>"), debit-positive.
    const obRows = await ctx.db
      .select({ accountId: journalEntryLines.accountId, ref: journalEntries.sourceRef, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), like(journalEntries.sourceRef, 'account:%')));
    const obOf = new Map<string, ReturnType<typeof Money.zero>>();
    for (const r of obRows) {
      if (r.ref !== `account:${r.accountId}`) continue;
      obOf.set(r.accountId, (obOf.get(r.accountId) ?? Money.zero()).plus(Money.of(r.debit ?? 0)).minus(Money.of(r.credit ?? 0)));
    }
    w.section(
      'ACCNT',
      ['NAME', 'ACCNTTYPE', 'DESC', 'ACCNUM', 'OBAMOUNT', 'HIDDEN'],
      [...rows]
        .sort((a, b) => depth(a.id) - depth(b.id) || a.code.localeCompare(b.code))
        .map((a) => ({
          NAME: pathOf(a.id),
          ACCNTTYPE: qbAccountType(a.type, a.subtype),
          DESC: a.description,
          ACCNUM: a.code,
          OBAMOUNT: obOf.has(a.id) && !obOf.get(a.id)!.isZero() ? toAmountString(obOf.get(a.id)!) : '',
          HIDDEN: a.isActive ? 'N' : 'Y',
        })),
    );
  }

  if (want.has('classes')) {
    const rows = await ctx.db.select().from(classes).where(eq(classes.companyId, ctx.companyId));
    const pathOf = pathResolver(rows);
    w.section(
      'CLASS',
      ['NAME', 'HIDDEN'],
      rows
        .map((c) => ({ NAME: pathOf(c.id), HIDDEN: c.isActive ? 'N' : 'Y' }))
        .sort((a, b) => a.NAME.split(':').length - b.NAME.split(':').length || a.NAME.localeCompare(b.NAME)),
    );
  }

  const ctypeRows = await ctx.db.select().from(customerTypes).where(eq(customerTypes.companyId, ctx.companyId));
  const vtypeRows = await ctx.db.select().from(vendorTypes).where(eq(vendorTypes.companyId, ctx.companyId));
  const ctypePath = pathResolver(ctypeRows);
  const vtypePath = pathResolver(vtypeRows);
  if (want.has('types')) {
    w.section('CTYPE', ['NAME', 'HIDDEN'], ctypeRows.map((t) => ({ NAME: ctypePath(t.id), HIDDEN: t.isActive ? 'N' : 'Y' })));
    w.section('VTYPE', ['NAME', 'HIDDEN'], vtypeRows.map((t) => ({ NAME: vtypePath(t.id), HIDDEN: t.isActive ? 'N' : 'Y' })));
  }
  if (want.has('reps')) {
    const reps = await ctx.db.select().from(salesReps).where(eq(salesReps.companyId, ctx.companyId));
    w.section(
      'SALESREP',
      ['INITIALS', 'ASSOCIATEDNAME', 'NAMETYPE', 'HIDDEN'],
      reps.map((r) => ({
        INITIALS: r.name.split(/\s+/).map((p) => p[0] ?? '').join('').toUpperCase().slice(0, 5),
        ASSOCIATEDNAME: r.name,
        NAMETYPE: 'OTHERNAME',
        HIDDEN: r.isActive ? 'N' : 'Y',
      })),
    );
  }

  if (want.has('other_lists')) {
    for (const sec of await exportOtherListSections(ctx)) w.section(sec.name, sec.cols, sec.rows);
  }
  // Terms / sales tax code / price level names for the CUST and VEND rows.
  const termRows = await ctx.db
    .select({ id: paymentTerms.id, name: paymentTerms.name })
    .from(paymentTerms)
    .where(eq(paymentTerms.companyId, ctx.companyId));
  const termName = new Map(termRows.map((r) => [r.id, r.name]));
  const codeRows = await ctx.db
    .select({ id: salesTaxCodes.id, code: salesTaxCodes.code })
    .from(salesTaxCodes)
    .where(eq(salesTaxCodes.companyId, ctx.companyId));
  const codeName = new Map(codeRows.map((r) => [r.id, r.code]));
  const levelRows = await ctx.db
    .select({ id: priceLevels.id, name: priceLevels.name })
    .from(priceLevels)
    .where(eq(priceLevels.companyId, ctx.companyId));
  const levelName = new Map(levelRows.map((r) => [r.id, r.name]));

  // Custom-field labels shared by customers and vendors (CUSTNAMEDICT), max 15 like QB.
  const custRows = want.has('customers')
    ? await ctx.db.select().from(customers).where(eq(customers.companyId, ctx.companyId))
    : [];
  const vendRows = want.has('vendors')
    ? await ctx.db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId))
    : [];
  const labelSet = new Set<string>();
  for (const r of [...custRows, ...vendRows]) {
    for (const k of Object.keys(r.customFields ?? {})) if (!CONTACT_FIELDS[k]) labelSet.add(k);
  }
  const labels = [...labelSet].sort().slice(0, 15);
  const custLabels = new Set<string>();
  const vendLabels = new Set<string>();
  for (const r of custRows) for (const k of Object.keys(r.customFields ?? {})) custLabels.add(k);
  for (const r of vendRows) for (const k of Object.keys(r.customFields ?? {})) vendLabels.add(k);
  if (labels.length) {
    w.section(
      'CUSTNAMEDICT',
      ['INDEX', 'LABEL', 'CUSTOMER', 'VENDOR', 'EMPLOYEE'],
      labels.map((l, i) => ({
        INDEX: i,
        LABEL: l,
        CUSTOMER: custLabels.has(l) ? 'Y' : 'N',
        VENDOR: vendLabels.has(l) ? 'Y' : 'N',
        EMPLOYEE: 'N',
      })),
    );
  }
  const custFldCols = labels.map((_, i) => `CUSTFLD${i + 1}`);
  const customFieldCells = (cf: Record<string, string> | null) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cf ?? {})) {
      const contact = CONTACT_FIELDS[k];
      if (contact) out[contact] = v;
      const i = labels.indexOf(k);
      if (i >= 0) out[`CUSTFLD${i + 1}`] = v;
    }
    return out;
  };

  if (want.has('customers') && custRows.length) {
    const byId = new Map(custRows.map((c) => [c.id, c]));
    const fullName = (c: (typeof custRows)[number]): string => {
      if (!c.parentId || c.displayName.includes(':')) return c.displayName;
      const p = byId.get(c.parentId);
      return p ? `${fullName(p)}:${c.displayName}` : c.displayName;
    };
    const rateRows = await ctx.db
      .select({ id: taxRates.id, name: taxRates.name })
      .from(taxRates)
      .where(eq(taxRates.companyId, ctx.companyId));
    const rateName = new Map(rateRows.map((r) => [r.id, r.name]));
    w.section(
      'CUST',
      [
        'NAME', 'COMPANYNAME', 'BADDR1', 'BADDR2', 'BADDR3', 'BADDR4', 'BADDR5',
        'SADDR1', 'SADDR2', 'SADDR3', 'SADDR4', 'SADDR5', 'PHONE1', 'PHONE2', 'FAXNUM', 'EMAIL',
        'CONT1', 'CONT2', 'CTYPE', 'TERMS', 'TAXABLE', 'TAXITEM', 'SALESTAXCODE', 'PRICELEVEL', 'LIMIT', 'RESALENUM', 'REP',
        'SALUTATION', 'FIRSTNAME', 'MIDINIT', 'LASTNAME', 'NOTE', 'HIDDEN', ...custFldCols,
      ],
      [...custRows]
        .sort((a, b) => fullName(a).split(':').length - fullName(b).split(':').length || fullName(a).localeCompare(fullName(b)))
        .map((c) => {
          const b = addressLines(c.billingAddress);
          const s = addressLines(c.shippingAddress);
          return {
            NAME: fullName(c),
            COMPANYNAME: c.companyName,
            BADDR1: b[0], BADDR2: b[1], BADDR3: b[2], BADDR4: b[3], BADDR5: b[4],
            SADDR1: s[0], SADDR2: s[1], SADDR3: s[2], SADDR4: s[3], SADDR5: s[4],
            PHONE1: c.phone,
            EMAIL: c.email,
            CTYPE: c.customerTypeId ? ctypePath(c.customerTypeId) : '',
            TERMS: (c.termsId && termName.get(c.termsId)) || displayTerms(c.terms),
            TAXABLE: c.taxable ? 'Y' : 'N',
            TAXITEM: c.taxRateId ? rateName.get(c.taxRateId) ?? '' : '',
            SALESTAXCODE: c.salesTaxCodeId ? codeName.get(c.salesTaxCodeId) ?? '' : '',
            PRICELEVEL: c.priceLevelId ? levelName.get(c.priceLevelId) ?? '' : '',
            LIMIT: c.creditLimit ? toAmountString(c.creditLimit) : '',
            NOTE: c.notes,
            HIDDEN: c.isActive ? 'N' : 'Y',
            ...customFieldCells(c.customFields ?? null),
          };
        }),
    );
  }

  if (want.has('vendors') && vendRows.length) {
    w.section(
      'VEND',
      [
        'NAME', 'COMPANYNAME', 'ADDR1', 'ADDR2', 'ADDR3', 'ADDR4', 'ADDR5', 'VTYPE', 'CONT1', 'CONT2',
        'PHONE1', 'PHONE2', 'FAXNUM', 'EMAIL', 'TERMS', 'TAXID', '1099', 'PRINTAS',
        'SALUTATION', 'FIRSTNAME', 'MIDINIT', 'LASTNAME', 'NOTE', 'HIDDEN', ...custFldCols,
      ],
      [...vendRows]
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((v) => {
          const a = addressLines(v.address);
          const tin = taxIdFor(ctx, v.taxId ?? null);
          return {
            NAME: v.displayName,
            COMPANYNAME: v.companyName,
            ADDR1: a[0], ADDR2: a[1], ADDR3: a[2], ADDR4: a[3], ADDR5: a[4],
            VTYPE: v.vendorTypeId ? vtypePath(v.vendorTypeId) : '',
            PHONE1: v.phone,
            EMAIL: v.email,
            TERMS: (v.termsId && termName.get(v.termsId)) || displayTerms(v.terms),
            // Never write a masked value: blank when the user may not see the full TIN.
            TAXID: tin && !/[*•]/.test(tin) ? tin : '',
            '1099': v.is1099 ? 'Y' : 'N',
            NOTE: v.notes,
            HIDDEN: v.isActive ? 'N' : 'Y',
            ...customFieldCells(v.customFields ?? null),
          };
        }),
    );
  }

  if (want.has('items')) {
    const rows = await ctx.db.select().from(items).where(eq(items.companyId, ctx.companyId)).orderBy(asc(items.name));
    const acctRows = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    const acctPath = pathResolver(acctRows);
    const bom = await ctx.db.select().from(assemblyComponents).where(eq(assemblyComponents.companyId, ctx.companyId));
    const nameOf = new Map(rows.map((i) => [i.id, i.name]));
    const hasBom = new Set(bom.map((b) => b.assemblyItemId));
    // Quantity on hand + its value (QB INVITEM QNTY / VALUE): without them a re-import brings the
    // inventory asset balance (journal / OBAMOUNT) but no stock behind it. FIFO items are valued
    // at their remaining layers, average-cost items at quantity x average cost (the same figures
    // as Inventory Valuation).
    const layerValue = new Map<string, ReturnType<typeof Money.zero>>();
    for (const l of await ctx.db
      .select({ itemId: inventoryLayers.itemId, qty: inventoryLayers.quantityRemaining, cost: inventoryLayers.unitCost })
      .from(inventoryLayers)
      .where(eq(inventoryLayers.companyId, ctx.companyId))) {
      layerValue.set(l.itemId, (layerValue.get(l.itemId) ?? Money.zero()).plus(Money.of(l.qty).times(Money.of(l.cost))));
    }
    const stockOf = (i: (typeof rows)[number]) => {
      const qty = Money.of(i.quantityOnHand ?? '0');
      if (i.type !== 'inventory' || qty.isZero()) return { QNTY: '', VALUE: '' };
      const value = layerValue.get(i.id) ?? qty.times(Money.of(i.averageCost ?? '0'));
      return { QNTY: qty.toString(), VALUE: toAmountString(Money.round2(value)) };
    };
    // Item custom fields: labels in CUSTITEMDICT (QB's item counterpart of CUSTNAMEDICT), values
    // in INVITEM CUSTFLD1..n.
    const itemLabels = [...new Set(rows.flatMap((i) => Object.keys(i.customFields ?? {})))].sort().slice(0, 15);
    w.section(
      'CUSTITEMDICT',
      ['INDEX', 'LABEL', 'INUSE'],
      itemLabels.map((l, n) => ({ INDEX: n, LABEL: l, INUSE: 'Y' })),
    );
    const itemFieldCells = (cf: Record<string, string> | null) =>
      Object.fromEntries(itemLabels.map((l, n) => [`CUSTFLD${n + 1}`, cf?.[l] ?? '']));
    w.section(
      'INVITEM',
      [
        'NAME', 'INVITEMTYPE', 'DESC', 'ACCNT', 'ASSETACCNT', 'COGSACCNT', 'PRICE', 'COST', 'TAXABLE', 'REORDERPOINT', 'HIDDEN', 'QNTY', 'VALUE',
        ...itemLabels.map((_, n) => `CUSTFLD${n + 1}`),
      ],
      rows.map((i) => ({
        ...stockOf(i),
        ...itemFieldCells(i.customFields ?? null),
        NAME: i.name,
        INVITEMTYPE: qbItemType(i.type, hasBom.has(i.id) && i.type === 'inventory'),
        DESC: i.description,
        ACCNT: acctPath(i.incomeAccountId),
        ASSETACCNT: acctPath(i.assetAccountId),
        COGSACCNT: acctPath(i.expenseAccountId),
        PRICE: i.salesPrice ? (i.type === 'sales_tax' ? `${Money.of(i.salesPrice).toString()}%` : toAmountString(i.salesPrice)) : '',
        COST: i.purchaseCost ? toAmountString(i.purchaseCost) : '',
        TAXABLE: i.taxable ? 'Y' : 'N',
        REORDERPOINT: i.reorderPoint ?? '',
        HIDDEN: i.isActive ? 'N' : 'Y',
      })),
    );
    w.section(
      'INVITEMCOMP',
      ['PARENT', 'COMPONENT', 'QNTY'],
      bom
        .filter((b) => nameOf.has(b.assemblyItemId) && nameOf.has(b.componentItemId))
        .map((b) => ({ PARENT: nameOf.get(b.assemblyItemId), COMPONENT: nameOf.get(b.componentItemId), QNTY: Money.of(b.quantity).toString() })),
    );
  }

  if (want.has('employees')) {
    const rows = await ctx.db
      .select()
      .from(employees)
      .where(eq(employees.companyId, ctx.companyId))
      .orderBy(asc(employees.lastName), asc(employees.firstName));
    w.section(
      'EMP',
      [
        'NAME', 'FIRSTNAME', 'LASTNAME', 'ADDR1', 'ADDR2', 'CITY', 'STATE', 'ZIP', 'PHONE1', 'EMAIL',
        'SSNO', 'HIREDATE', 'RELEASEDATE', 'PAYTYPE', 'PAYRATE', 'FILINGSTATUS', 'ALLOWANCES',
        'EXTRAWH', 'STATEWH', 'HIDDEN',
      ],
      rows.map((e) => {
        const addr = (e.address ?? {}) as Record<string, string | undefined>;
        const w4 = (e.w4 ?? {}) as Record<string, unknown>;
        const ssn = taxIdFor(ctx, e.ssn ?? null);
        const fs = String(w4.filingStatus ?? '');
        return {
          NAME: `${e.lastName}, ${e.firstName}`,
          FIRSTNAME: e.firstName,
          LASTNAME: e.lastName,
          ADDR1: addr.line1,
          ADDR2: addr.line2,
          CITY: addr.city,
          STATE: addr.state,
          ZIP: addr.zip,
          PHONE1: e.phone,
          EMAIL: e.email,
          SSNO: ssn && !/[*•]/.test(ssn) ? ssn : '',
          HIREDATE: iifDate(e.hireDate),
          RELEASEDATE: iifDate(e.releaseDate),
          PAYTYPE: e.payType === 'salary' ? 'Salary' : e.payType === 'commission' ? 'Commission' : 'Hourly',
          PAYRATE: toAmountString(e.payRate),
          FILINGSTATUS: fs === 'married' ? 'Married' : fs === 'head_of_household' ? 'Head of Household' : fs ? 'Single' : '',
          ALLOWANCES: w4.allowances ?? '',
          EXTRAWH: w4.extraWithholding ?? '',
          STATEWH: w4.state ?? '',
          HIDDEN: e.isActive ? 'N' : 'Y',
        };
      }),
    );
  }

  return w.toString();
}

// ---------------------------------------------------------------------------
// Transactions — general journal TRNS/SPL blocks
// ---------------------------------------------------------------------------

/**
 * Every POSTED journal entry dated in [from, to] as a GENERAL JOURNAL TRNS/SPL block (first
 * line on the TRNS row, the rest SPL) — except account opening balances, which the list export
 * writes as ACCNT OBAMOUNT. Amounts are signed (debit +, credit −), accounts are
 * full "Parent:Sub" names, classes full paths.
 */
export async function exportJournalIif(ctx: ServiceContext, range: { from: Date; to: Date }): Promise<string> {
  if (!(range.from instanceof Date) || isNaN(range.from.getTime()) || !(range.to instanceof Date) || isNaN(range.to.getTime())) {
    throw validation('Choose a valid date range.');
  }
  if (range.from > range.to) throw validation('The start date must be on or before the end date.');
  const acctRows = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
  const acctPath = pathResolver(acctRows);
  const classRows = await ctx.db.select().from(classes).where(eq(classes.companyId, ctx.companyId));
  const classPath = pathResolver(classRows);

  // QB "Name" column: every named line (customer / vendor / employee / other name) writes the
  // name exactly as the list export spells it, so QuickBooks accepts A/R and A/P lines (it
  // rejects them without a name) and a re-import restores per-name detail.
  const nameOf = await journalNameResolver(ctx);

  const entries = await ctx.db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        gte(journalEntries.date, range.from),
        lte(journalEntries.date, range.to),
        // Account opening balances travel as ACCNT OBAMOUNT in the list export (QB's own
        // convention); writing them here too would double them on import.
        or(isNull(journalEntries.sourceRef), notLike(journalEntries.sourceRef, 'account:%')),
      ),
    )
    .orderBy(asc(journalEntries.date), asc(journalEntries.entryNumber));

  const w = new IifWriter();
  const cols = ['TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'CLASS', 'AMOUNT', 'DOCNUM', 'MEMO'];
  w.raw(`!TRNS\t${cols.join('\t')}`);
  w.raw(`!SPL\tSPLID\t${cols.slice(1).join('\t')}`);
  w.raw('!ENDTRNS');
  // One query for every line of the range (not one per entry).
  const linesByEntry = new Map<string, Array<typeof journalEntryLines.$inferSelect>>();
  const ids = entries.map((e) => e.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = await ctx.db
      .select()
      .from(journalEntryLines)
      .where(inArray(journalEntryLines.journalEntryId, ids.slice(i, i + 500)))
      .orderBy(asc(journalEntryLines.createdAt), asc(journalEntryLines.id));
    for (const l of chunk) {
      const arr = linesByEntry.get(l.journalEntryId) ?? [];
      arr.push(l);
      linesByEntry.set(l.journalEntryId, arr);
    }
  }
  for (const e of entries) {
    const lines = linesByEntry.get(e.id) ?? [];
    if (lines.length < 2) continue;
    lines.forEach((l, i) => {
      const signed = Money.of(l.debit ?? 0).minus(Money.of(l.credit ?? 0));
      const cells = [
        '',
        'GENERAL JOURNAL',
        iifDate(e.date),
        acctPath(l.accountId),
        nameOf(l.entityType, l.entityId),
        classPath(l.classId),
        toAmountString(signed),
        e.reference ?? String(e.entryNumber),
        i === 0 ? e.description : l.memo ?? '',
      ].map(iifCell);
      w.raw([i === 0 ? 'TRNS' : 'SPL', ...cells].join('\t'));
    });
    w.raw('ENDTRNS');
  }
  return w.toString();
}

/**
 * (entityType, entityId) → the QB name the list export writes for it: customers as their full
 * "Customer:Job" path, vendors and other names by display name, employees "Last, First".
 * Unknown / missing ids resolve to ''.
 */
async function journalNameResolver(
  ctx: ServiceContext,
): Promise<(type: string | null | undefined, id: string | null | undefined) => string> {
  const custRows = await ctx.db
    .select({ id: customers.id, displayName: customers.displayName, parentId: customers.parentId })
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId));
  const custById = new Map(custRows.map((c) => [c.id, c]));
  const custName = (id: string, seen = new Set<string>()): string => {
    const c = custById.get(id);
    if (!c) return '';
    if (!c.parentId || c.displayName.includes(':') || seen.has(id)) return c.displayName;
    seen.add(id);
    const parent = custName(c.parentId, seen);
    return parent ? `${parent}:${c.displayName}` : c.displayName;
  };
  const vendRows = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(eq(vendors.companyId, ctx.companyId));
  const vendName = new Map(vendRows.map((v) => [v.id, v.name]));
  const empRows = await ctx.db
    .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName })
    .from(employees)
    .where(eq(employees.companyId, ctx.companyId));
  const empName = new Map(empRows.map((e) => [e.id, `${e.lastName}, ${e.firstName}`]));
  const otherRows = await ctx.db
    .select({ id: otherNames.id, name: otherNames.name })
    .from(otherNames)
    .where(eq(otherNames.companyId, ctx.companyId));
  const otherName = new Map(otherRows.map((o) => [o.id, o.name]));
  return (type, id) => {
    if (!type || !id) return '';
    switch (type) {
      case 'customer': return custName(id);
      case 'vendor': return vendName.get(id) ?? '';
      case 'employee': return empName.get(id) ?? '';
      case 'other': return otherName.get(id) ?? '';
      default: return '';
    }
  };
}
