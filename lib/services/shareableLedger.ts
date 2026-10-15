/**
 * Shareable ledger — a read-only copy of the books that opens WITHOUT Ironbooks
 * (for an accountant, auditor, lender or the next bookkeeper):
 *
 *  - an .xlsx workbook: Company Info, Chart of Accounts, Trial Balance, General Ledger
 *    (per account, with running balances), Journal (every entry and line, incl. voided ones
 *    flagged), Customers, Vendors, Items;
 *  - a PDF summary: company info + key counts, Trial Balance, Balance Sheet.
 *
 * Built from the same services the in-app reports use (trialBalance, generalLedger,
 * balanceSheet), so the shared numbers always tie to what the app shows.
 */
import { asc, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import {
  accounts,
  classes,
  companies,
  customers,
  items,
  journalEntries,
  journalEntryLines,
  vendors,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { buildXlsxWorkbook, type XlsxCell, type XlsxSheetInput } from '@/lib/export/xlsx';
import { buildReportPdf } from '@/lib/export/reportPdf';
import { notFound, type ServiceContext } from './_base';
import { balanceSheet, trialBalance } from './reports';
import { generalLedger } from './journal';

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
}

function addressLine(a: Record<string, string> | null | undefined): string {
  if (!a) return '';
  return [a.line1 ?? a.street, a.line2, a.city, a.state, a.zip ?? a.postalCode, a.country].filter(Boolean).join(', ');
}

interface LedgerData {
  company: { name: string; settings: Record<string, unknown> };
  exportedAt: Date;
  sheets: XlsxSheetInput[];
  tb: Awaited<ReturnType<typeof trialBalance>>;
  counts: Record<string, number>;
}

async function collect(ctx: ServiceContext): Promise<LedgerData> {
  const [company] = await ctx.db.select().from(companies).where(eq(companies.id, ctx.companyId));
  if (!company) throw notFound('Company');
  const settings = (company.settings ?? {}) as Record<string, unknown>;
  const exportedAt = new Date();

  const acctRows = await ctx.db
    .select()
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId))
    .orderBy(asc(accounts.code));
  const acctById = new Map(acctRows.map((a) => [a.id, a]));
  const classRows = await ctx.db.select().from(classes).where(eq(classes.companyId, ctx.companyId));
  const classById = new Map(classRows.map((c) => [c.id, c.name]));

  const tb = await trialBalance(ctx);
  const gl = await generalLedger(ctx);

  const entries = await ctx.db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.companyId, ctx.companyId))
    .orderBy(asc(journalEntries.date), asc(journalEntries.entryNumber));
  const lines = await ctx.db
    .select({ line: journalEntryLines })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(eq(journalEntries.companyId, ctx.companyId))
    .orderBy(asc(journalEntryLines.createdAt), asc(journalEntryLines.id));
  const linesByEntry = new Map<string, Array<typeof journalEntryLines.$inferSelect>>();
  for (const { line } of lines) {
    const list = linesByEntry.get(line.journalEntryId) ?? [];
    list.push(line);
    linesByEntry.set(line.journalEntryId, list);
  }

  const custRows = await ctx.db
    .select()
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId))
    .orderBy(asc(customers.displayName));
  const vendRows = await ctx.db
    .select()
    .from(vendors)
    .where(eq(vendors.companyId, ctx.companyId))
    .orderBy(asc(vendors.displayName));
  const itemRows = await ctx.db
    .select()
    .from(items)
    .where(eq(items.companyId, ctx.companyId))
    .orderBy(asc(items.name));

  const posted = entries.filter((e) => e.status === 'posted').length;
  const counts: Record<string, number> = {
    Accounts: acctRows.length,
    'Journal entries (posted)': posted,
    'Journal entries (voided)': entries.filter((e) => e.status === 'void').length,
    Customers: custRows.length,
    Vendors: vendRows.length,
    Items: itemRows.length,
  };

  const info: XlsxCell[][] = [
    ['Company', company.name],
    ['Legal name', String(settings.legalName ?? '')],
    ['EIN', String(settings.ein ?? '')],
    ['Address', String(settings.address ?? '')],
    ['Fiscal year end', String(settings.fiscalYearEnd ?? '')],
    ['Currency', String(settings.currency ?? 'USD')],
    ['Closing date', String(settings.closingDate ?? '')],
    ['Exported', exportedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
    ['Trial balance — total debits', tb.totalDebit],
    ['Trial balance — total credits', tb.totalCredit],
    ['Trial balance in balance', tb.balanced ? 'Yes' : 'NO — investigate'],
    ...Object.entries(counts).map(([k, v]) => [k, v] as XlsxCell[]),
    ['Note', 'Read-only copy exported from Ironbooks. Amounts are in the company currency.'],
  ];

  const sheets: XlsxSheetInput[] = [
    {
      sheetName: 'Company Info',
      title: company.name,
      subtitle: 'Shareable ledger',
      // Text column: identifiers such as an EIN '012345678' must keep their leading zeros.
      columns: [{ header: 'Field' }, { header: 'Value' }],
      rows: info,
    },
    {
      sheetName: 'Chart of Accounts',
      title: 'Chart of Accounts',
      columns: [
        { header: 'Code' }, { header: 'Name' }, { header: 'Type' }, { header: 'Detail type' },
        { header: 'Parent' }, { header: 'Active' }, { header: 'Balance', numeric: true }, { header: 'Description' },
      ],
      rows: acctRows.map((a) => [
        a.code, a.name, a.type, a.subtype.replace(/_/g, ' '),
        a.parentId ? (acctById.get(a.parentId)?.code ?? '') : '',
        a.isActive ? 'Yes' : 'No', Money.of(a.balance).toFixed(2), a.description ?? '',
      ]),
    },
    {
      sheetName: 'Trial Balance',
      title: 'Trial Balance',
      subtitle: `As of ${iso(exportedAt)}`,
      columns: [{ header: 'Code' }, { header: 'Account' }, { header: 'Type' }, { header: 'Debit', numeric: true }, { header: 'Credit', numeric: true }],
      rows: tb.rows.map((r) => [r.code, r.name, r.type, r.debit, r.credit]),
      totals: [['', 'TOTAL', '', tb.totalDebit, tb.totalCredit]],
    },
    {
      sheetName: 'General Ledger',
      title: 'General Ledger',
      subtitle: 'Posted entries, running balance per account (debit-normal for assets/expenses)',
      columns: [
        { header: 'Account' }, { header: 'Date' }, { header: 'Entry #' }, { header: 'Description' },
        { header: 'Reference' }, { header: 'Debit', numeric: true }, { header: 'Credit', numeric: true },
        { header: 'Balance', numeric: true },
      ],
      rows: gl.flatMap((acct) => {
        if (!acct.lines.length) return [];
        const label = `${acct.accountCode} · ${acct.accountName}`;
        return [
          [label, '', '', 'Opening balance', '', '', '', acct.openingBalance] as XlsxCell[],
          ...acct.lines.map((l) => [label, iso(l.date), l.entryNumber, l.description, l.reference ?? '', l.debit ?? '', l.credit ?? '', l.runningBalance] as XlsxCell[]),
          [label, '', '', 'Closing balance', '', '', '', acct.closingBalance] as XlsxCell[],
        ];
      }),
    },
    {
      sheetName: 'Journal',
      title: 'Journal',
      subtitle: 'Every entry and line (voided entries are marked and excluded from balances)',
      columns: [
        { header: 'Entry #' }, { header: 'Date' }, { header: 'Status' }, { header: 'Description' },
        { header: 'Reference' }, { header: 'Account code' }, { header: 'Account' },
        { header: 'Debit', numeric: true }, { header: 'Credit', numeric: true }, { header: 'Class' }, { header: 'Memo' },
      ],
      rows: entries.flatMap((e) =>
        (linesByEntry.get(e.id) ?? []).map((l) => {
          const a = acctById.get(l.accountId);
          return [
            e.entryNumber, iso(e.date), e.status, e.description, e.reference ?? '',
            a?.code ?? '', a?.name ?? '', l.debit ?? '', l.credit ?? '',
            l.classId ? (classById.get(l.classId) ?? '') : '', l.memo ?? '',
          ] as XlsxCell[];
        }),
      ),
    },
    {
      sheetName: 'Customers',
      title: 'Customers',
      columns: [
        { header: 'Name' }, { header: 'Company' }, { header: 'Email' }, { header: 'Phone' },
        { header: 'Billing address' }, { header: 'Terms' }, { header: 'Balance', numeric: true }, { header: 'Active' },
      ],
      rows: custRows.map((c) => [
        c.displayName, c.companyName ?? '', c.email ?? '', c.phone ?? '', addressLine(c.billingAddress),
        c.terms ?? '', Money.of(c.balance).toFixed(2), c.isActive ? 'Yes' : 'No',
      ]),
    },
    {
      sheetName: 'Vendors',
      title: 'Vendors',
      columns: [
        { header: 'Name' }, { header: 'Company' }, { header: 'Email' }, { header: 'Phone' },
        { header: 'Address' }, { header: 'Terms' }, { header: '1099' }, { header: 'Balance', numeric: true }, { header: 'Active' },
      ],
      // Tax ids are deliberately left out of a shareable copy.
      rows: vendRows.map((v) => [
        v.displayName, v.companyName ?? '', v.email ?? '', v.phone ?? '', addressLine(v.address),
        v.terms ?? '', v.is1099 ? 'Yes' : 'No', Money.of(v.balance).toFixed(2), v.isActive ? 'Yes' : 'No',
      ]),
    },
    {
      sheetName: 'Items',
      title: 'Items',
      columns: [
        { header: 'Name' }, { header: 'SKU' }, { header: 'Type' }, { header: 'Description' },
        { header: 'Sales price', numeric: true }, { header: 'Cost', numeric: true },
        { header: 'Income account' }, { header: 'Qty on hand', numeric: true }, { header: 'Active' },
      ],
      rows: itemRows.map((i) => [
        i.name, i.sku ?? '', i.type, i.description ?? '', i.salesPrice ?? '', i.purchaseCost ?? '',
        i.incomeAccountId ? (acctById.get(i.incomeAccountId)?.code ?? '') : '',
        i.quantityOnHand ?? '', i.isActive ? 'Yes' : 'No',
      ]),
    },
  ];

  return { company: { name: company.name, settings }, exportedAt, sheets, tb, counts };
}

export interface ShareableFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** The shareable ledger workbook (.xlsx). */
export async function buildShareableLedgerXlsx(ctx: ServiceContext): Promise<ShareableFile> {
  const data = await collect(ctx);
  return {
    buffer: buildXlsxWorkbook(data.sheets),
    filename: `${slug(data.company.name)}-ledger-${iso(data.exportedAt)}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

/** The shareable ledger PDF summary: company info + counts, Trial Balance, Balance Sheet. */
export async function buildShareableLedgerPdf(ctx: ServiceContext): Promise<ShareableFile> {
  const data = await collect(ctx);
  const bs = await balanceSheet(ctx);
  const subtitle = `Shareable ledger summary · exported ${iso(data.exportedAt)}`;

  const parts: Uint8Array[] = [];
  parts.push(
    await buildReportPdf({
      title: 'Company Summary',
      company: data.company.name,
      subtitle,
      columns: [{ header: 'Field' }, { header: 'Value' }],
      rows: data.sheets[0].rows.map((r) => [String(r[0] ?? ''), String(r[1] ?? '')]),
    }),
  );
  parts.push(
    await buildReportPdf({
      title: 'Trial Balance',
      company: data.company.name,
      subtitle: `As of ${iso(data.exportedAt)}${data.tb.balanced ? '' : ' — OUT OF BALANCE'}`,
      columns: [{ header: 'Code' }, { header: 'Account' }, { header: 'Type' }, { header: 'Debit', numeric: true }, { header: 'Credit', numeric: true }],
      rows: data.tb.rows.map((r) => [r.code, r.name, r.type, r.debit, r.credit]),
      totals: [['', 'TOTAL', '', data.tb.totalDebit, data.tb.totalCredit]],
    }),
  );
  const section = (label: string, rows: Array<{ code: string; name: string; amount: string }>, total: string) => [
    [label, '', ''],
    ...rows.map((r) => [`  ${r.code}`, r.name, r.amount]),
    ['', `Total ${label}`, total],
  ];
  parts.push(
    await buildReportPdf({
      title: 'Balance Sheet',
      company: data.company.name,
      subtitle: `As of ${iso(data.exportedAt)}${bs.balanced ? '' : ' — OUT OF BALANCE'}`,
      columns: [{ header: 'Code' }, { header: 'Account' }, { header: 'Amount', numeric: true }],
      rows: [
        ...section('Assets', bs.assets, bs.totalAssets),
        ...section('Liabilities', bs.liabilities, bs.totalLiabilities),
        ...section('Equity', bs.equity, bs.totalEquity),
        ['', 'Retained earnings (incl. current year)', bs.retainedEarnings],
      ],
      totals: [['', 'Total liabilities + equity', Money.add(bs.totalLiabilities, bs.totalEquity).toFixed(2)]],
    }),
  );

  const merged = await PDFDocument.create();
  merged.setTitle(`${data.company.name} — Ledger Summary`);
  merged.setProducer('Ironbooks');
  for (const bytes of parts) {
    const doc = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const p of pages) merged.addPage(p);
  }
  return {
    buffer: Buffer.from(await merged.save()),
    filename: `${slug(data.company.name)}-ledger-summary-${iso(data.exportedAt)}.pdf`,
    contentType: 'application/pdf',
  };
}
