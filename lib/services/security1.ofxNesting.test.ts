/**
 * Security 1.4 — a bank file (OFX / QFX / QBO) with absurdly deep nesting (lib/services/import.ts).
 *
 * Every closing tag copied the whole stack of open tags to search it, so nesting was quadratic:
 * 20,000 levels took 0.9 s and 40,000 took 7.9 s, on the server that also hosts the database.
 * Real bank files nest under 10 levels; past 64 the file is refused with the importer's usual
 * "Failed to parse OFX/QBO content" message.
 */
import { describe, it, expect } from 'vitest';
import { OFX_MAX_DEPTH, parseOFX } from './import';

const STATEMENT = (inner = '') => `OFXHEADER:100
DATA:OFXSGML

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240105120000
<TRNAMT>1500.00
<FITID>TXN001
<NAME>ACME CORP PAYROLL
<SIC>
${inner}</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240110
<TRNAMT>-89.99
<FITID>TXN002
<NAME>AMAZON.COM
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

describe('deeply nested OFX', () => {
  it('200,000 nested tags are refused as not a bank file, well under a second', () => {
    const n = 200_000;
    const hostile = '<OFX>\n' + '<A>\n'.repeat(n) + '</A>\n'.repeat(n) + '</OFX>\n';
    const t0 = performance.now();
    expect(() => parseOFX(hostile)).toThrow(
      expect.objectContaining({ code: 'VALIDATION', message: expect.stringMatching(/^Failed to parse OFX\/QBO content: .*nested more than 64 levels/) }),
    );
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('thousands of unmatched closing tags at the deepest allowed level stay fast', () => {
    const doc = '<OFX>\n' + '<A>\n'.repeat(OFX_MAX_DEPTH - 1) + '</NOPE>\n'.repeat(200_000) + '</OFX>\n';
    const t0 = performance.now();
    expect(parseOFX(doc)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('nesting up to the limit is accepted; one level more is refused', () => {
    const nested = (levels: number) => '<OFX>\n' + '<A>\n'.repeat(levels - 1) + '</A>\n'.repeat(levels - 1) + '</OFX>\n';
    expect(parseOFX(nested(OFX_MAX_DEPTH))).toEqual([]);
    expect(() => parseOFX(nested(OFX_MAX_DEPTH + 1))).toThrow(/nested more than 64 levels/);
  });

  it('a normal statement (with an empty SGML leaf left open) still reads both transactions', () => {
    const rows = parseOFX(STATEMENT());
    expect(rows.map((r) => [r.fitId, r.amount, r.description])).toEqual([
      ['TXN001', '1500.00', 'ACME CORP PAYROLL'],
      ['TXN002', '-89.99', 'AMAZON.COM'],
    ]);
  });
});
