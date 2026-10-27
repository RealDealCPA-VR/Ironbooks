/**
 * Review round 5 (team uib): Preferences.
 *
 *  - Preferences > Sales & Customers showed "Next Invoice Number" as the largest integer invoice
 *    number + 1, computed by downloading every invoice in the company file. Invoice numbers carry
 *    letters and a starting number (Document Numbers, lib/services/docNumbers.ts), so after
 *    "INV-0099" it said "#100" instead of INV-0100, and after a starting number of INV-2000 it
 *    still said "#100". It now shows what the numbering service will hand out.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { incrementAlnum } from '@/lib/services/docNumbers';

const settingsSource = fs.readFileSync(path.resolve(process.cwd(), 'app/settings/page.tsx'), 'utf8');

describe('Preferences: next invoice number', () => {
  it('asks the numbering service for the next invoice number', () => {
    expect(settingsSource).toContain("'/api/doc-numbers?docType=invoice'");
  });

  it('does not download the whole invoice list to guess it', () => {
    expect(settingsSource).not.toMatch(/api\s*\.\s*get<[^>]*>\(\s*'\/api\/invoices'/);
    expect(settingsSource).not.toMatch(/Math\.max\(m, Number\(r\.invoiceNumber/);
  });

  it('the guess it replaced was wrong for lettered numbers', () => {
    // What the numbering service hands out after INV-0099 …
    expect(incrementAlnum('INV-0099')).toBe('INV-0100');
    // … versus the old "#<largest integer + 1>" display.
    expect(`#${99 + 1}`).not.toBe(incrementAlnum('INV-0099'));
  });
});
