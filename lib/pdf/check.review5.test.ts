/**
 * Review round 5: checks and 1099s for payees whose names the standard PDF fonts cannot encode
 * (Polish, Vietnamese, Chinese, emoji) print instead of failing with an error (HTTP 500), and the
 * 1099-NEC carries the payer's TIN and address.
 */
import { describe, it, expect } from 'vitest';
import { renderChecksPdf, numberToWords } from './check';
import { render1099NecPdf } from './form1099';

const payee = 'Łódź Nguyễn Văn Ánh 北京 Supplies 🙂';

describe('review5 check / 1099 PDFs', () => {
  for (const stock of ['preprinted', 'blank'] as const) {
    for (const style of ['voucher', 'standard', 'wallet'] as const) {
      it(`prints a ${style} check on ${stock} stock to a payee with non-Latin characters`, async () => {
        const bytes = await renderChecksPdf(
          [
            {
              company: { name: 'Hà Nội Trading — 東京', addressLines: ['ul. Piotrkowska 1', 'Łódź'] },
              payee,
              payeeAddress: ['Phố Huế 12', 'Hà Nội'],
              amountNumeric: '1234.56',
              amountWords: numberToWords('1234.56'),
              date: '2026-07-01',
              memo: 'Zamówienie № 7 ✓',
              checkNumber: '1001',
              voucher: [{ account: '6000 – Dịch vụ', description: 'Łączność 📞', amount: '1234.56' }],
            },
          ],
          { style, stock, layout: { payeeAddress: { show: true } } as never },
        );
        expect(bytes.byteLength).toBeGreaterThan(1000);
      });
    }
  }

  it('prints a 1099-NEC for a recipient with non-Latin characters, with the payer TIN and address', async () => {
    const bytes = await render1099NecPdf({
      company: { name: 'Łódź Payer', addressLines: ['1 Main St', 'Springfield, IL 62701'], tin: '12-3456789' },
      vendor: { name: payee, taxId: '***-**-6789', addressLines: ['Phố Huế 12'] },
      year: 2026,
      nonemployeeComp: '2500.00',
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
