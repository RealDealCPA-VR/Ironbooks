/**
 * Smoke tests for the packing-slip PDF renderer (no DB dependency).
 * A packing slip must render valid PDF bytes and must never contain prices.
 */
import { describe, it, expect } from 'vitest';
import { renderPackingSlipPdf, type PackingSlipData } from './packingSlip';

const BASE: PackingSlipData = {
  company: { name: 'Ironbooks Test Co' },
  customerName: 'Acme Corp',
  shipToLines: ['123 Main St', 'Suite 4', 'Springfield, IL 62704'],
  slip: { invoiceNumber: 1042, date: '2026-06-09', orderNumber: 17 },
  lines: [
    { itemName: 'Widget', description: 'Blue widget, 3-pack', quantity: '2.0000' },
    { itemName: null, description: 'Hand-packed sampler', quantity: 1 },
    { itemName: 'Gadget', description: 'Gadget XL', quantity: '0.5000' },
  ],
};

describe('renderPackingSlipPdf', () => {
  it('renders a valid PDF document', async () => {
    const bytes = await renderPackingSlipPdf(BASE);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(500);
    // %PDF- magic header
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('renders without a ship-to address or order number', async () => {
    const bytes = await renderPackingSlipPdf({
      ...BASE,
      shipToLines: [],
      slip: { invoiceNumber: 7, date: '2026-01-01', orderNumber: null },
    });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('handles many lines (page-overflow guard) and empty descriptions', async () => {
    const bytes = await renderPackingSlipPdf({
      ...BASE,
      lines: Array.from({ length: 60 }, (_, i) => ({
        itemName: `Item ${i + 1}`,
        description: i % 5 === 0 ? '' : `Line ${i + 1}`,
        quantity: i + 1,
      })),
    });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });
});
