/**
 * Every PDF the app renders is stamped SANDBOX while the active company file is a sandbox /
 * training copy (lib/pdf/sandboxStamp.ts): not only checks and sales forms (covered in
 * lib/services/sandbox.test.ts) but also paystubs, W-2 / W-3 / 941 / 940, 1099-NEC, collection
 * letters, labels, envelopes, packing slips, pick lists, open-item statements and report PDFs.
 * Documents merged from stamped parts carry the SANDBOX keyword without a second stamp.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { SANDBOX_STAMP, stampSandbox, tagSandbox } from './sandboxStamp';
import { renderPaystubPdf } from './paystub';
import { render940Pdf, render941Pdf, renderW2Pdf, renderW3Pdf } from './payrollForms';
import { render1099NecPdf } from './form1099';
import { renderEnvelopesPdf, renderLabelsPdf, renderLettersPdf } from './letters';
import { renderPackingSlipPdf, type PackingSlipData } from './packingSlip';
import { renderPackingSlipsPdf, renderPickListPdf } from './pickList';
import { buildReportPdf } from '@/lib/export/reportPdf';
import { renderOpenItemStatementPdf } from '@/app/api/export/statements/openItemPdf';
import type { Form941Lines } from '@/lib/services/payrollReports';

const company = { name: 'Stamp Co', address: '1 Main St', ein: '12-3456789' };
const z = '0.00';

const lines941: Form941Lines = {
  line1: 1,
  line2: '1000.00',
  line3: '100.00',
  line4: false,
  line5aWages: '1000.00',
  line5aTax: '124.00',
  line5bWages: z,
  line5bTax: z,
  line5cWages: '1000.00',
  line5cTax: '29.00',
  line5dWages: z,
  line5dTax: z,
  line5e: '153.00',
  line5f: z,
  line6: '253.00',
  line7: z,
  line8: z,
  line9: z,
  line10: '253.00',
  line11: z,
  line12: '253.00',
  line13: '253.00',
  line14: z,
  line15: z,
};

const slip: PackingSlipData = {
  company: { name: 'Stamp Co' },
  customerName: 'Pat Buyer',
  shipToLines: ['2 Side St'],
  slip: { invoiceNumber: 1001, date: '2026-01-15' },
  lines: [{ itemName: 'Widget', description: 'Blue widget', quantity: '2' }],
};

/** One renderer per printed document type. */
const renderers: Array<[string, () => Promise<Uint8Array>]> = [
  [
    'paystub',
    () =>
      renderPaystubPdf({
        company,
        employee: { firstName: 'Ann', lastName: 'Lee' },
        paycheck: { payDate: '2026-01-15', grossPay: '1000.00', netPay: '800.00' },
        lines: [{ kind: 'earning', name: 'Salary', amount: '1000.00' }],
      }),
  ],
  [
    'W-2',
    () =>
      renderW2Pdf({
        company,
        employee: { firstName: 'Ann', lastName: 'Lee', ssn: '123-45-6789' },
        year: 2026,
        wages: '1000.00',
        federalWithheld: '100.00',
        socialSecurity: '62.00',
        medicare: '14.50',
      }),
  ],
  [
    'W-3',
    () =>
      renderW3Pdf({
        company,
        year: 2026,
        w2Count: 1,
        wages: '1000.00',
        federalWithheld: '100.00',
        ssWages: '1000.00',
        socialSecurity: '62.00',
        medicareWages: '1000.00',
        medicare: '14.50',
        stateWages: '1000.00',
        stateWithheld: '30.00',
      }),
  ],
  [
    '941',
    () =>
      render941Pdf({
        company,
        quarter: 1,
        year: 2026,
        lines: lines941,
        schedule: { kind: 'monthly', months: ['84.33', '84.33', '84.34'], total: '253.00', scheduleB: null },
      }),
  ],
  [
    '940',
    () =>
      render940Pdf({
        company,
        year: 2026,
        employeeCount: 1,
        totalPayments: '1000.00',
        exemptPayments: z,
        excessOver7000: z,
        subtotal: z,
        taxableFutaWages: '1000.00',
        futaTaxCalculated: '6.00',
        futaTaxAccrued: '6.00',
        quarters: [{ quarter: 1, futaLiability: '6.00' }],
        totalQuarterlyLiability: '6.00',
      }),
  ],
  ['1099-NEC', () => render1099NecPdf({ company, vendor: { name: 'Contractor LLC', taxId: '98-7654321' }, year: 2026, nonemployeeComp: '700.00' })],
  ['collection letter', () => renderLettersPdf([{ body: 'Dear Pat,\n\nYour account is past due.' }], { name: 'Stamp Co', addressLines: ['1 Main St'] })],
  ['labels', () => renderLabelsPdf([['Pat Buyer', '2 Side St']])],
  ['envelopes', () => renderEnvelopesPdf([['Pat Buyer', '2 Side St']], ['Stamp Co', '1 Main St'])],
  ['packing slip', () => renderPackingSlipPdf(slip)],
  [
    'pick list',
    () =>
      renderPickListPdf({
        company: { name: 'Stamp Co' },
        date: '2026-01-15',
        rows: [{ itemName: 'Widget', totalQuantity: '2', orders: [{ orderNumber: 7, customerName: 'Pat Buyer', quantity: '2' }] }],
      }),
  ],
  [
    'report',
    () =>
      buildReportPdf({
        title: 'Profit and Loss',
        company: 'Stamp Co',
        columns: [{ header: 'Account' }, { header: 'Amount', numeric: true }],
        rows: [['Sales', '1000.00']],
      }),
  ],
  [
    'open-item statement',
    () =>
      renderOpenItemStatementPdf(
        {
          customer: { id: 'c1', displayName: 'Pat Buyer', companyName: null, email: null },
          asOf: '2026-01-31',
          lines: [],
          aging: { current: z, days1_30: z, days31_60: z, days61_90: z, days90Plus: z },
          totalDue: z,
        },
        'Stamp Co',
      ),
  ],
];

async function keywords(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return (doc.getKeywords() ?? '').split(/\s+/).filter(Boolean);
}

describe('SANDBOX stamp on every printed document', () => {
  afterEach(() => {
    delete process.env.BKA_SANDBOX;
  });

  it.each(renderers)('stamps the %s only while in a sandbox', async (_name, render) => {
    delete process.env.BKA_SANDBOX;
    expect(await keywords(await render())).not.toContain(SANDBOX_STAMP);
    process.env.BKA_SANDBOX = '1';
    expect(await keywords(await render())).toContain(SANDBOX_STAMP);
  });

  it('merged documents keep the mark without stamping their pages twice', async () => {
    process.env.BKA_SANDBOX = '1';
    // Combined packing slips: each slip was stamped when rendered; the merge is tagged once.
    expect(await keywords(await renderPackingSlipsPdf([slip, slip]))).toEqual([SANDBOX_STAMP]);

    const doc = await PDFDocument.create();
    doc.addPage();
    tagSandbox(doc);
    tagSandbox(doc);
    expect(doc.getKeywords()).toBe(SANDBOX_STAMP);
    const before = (await doc.save()).length;
    // tagSandbox draws nothing; stampSandbox does.
    const stamped = await PDFDocument.create();
    stamped.addPage();
    await stampSandbox(stamped);
    expect((await stamped.save()).length).toBeGreaterThan(before);

    delete process.env.BKA_SANDBOX;
    const plain = await PDFDocument.create();
    tagSandbox(plain);
    expect(plain.getKeywords()).toBeUndefined();
  });
});
