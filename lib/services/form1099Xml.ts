/**
 * 1099-NEC e-file XML generation.
 *
 * generate1099NecFile — builds a well-formed XML document containing Form1099NEC records
 * for every is_1099 vendor with $600 or more of NEC box 1 (per the 1099 account mapping) in the
 * requested calendar year.
 *
 * The XML is suitable for review and submission to the IRS FIRE (Filing Information
 * Returns Electronically) system, but transmission itself is out of scope for this
 * function. Callers are responsible for uploading the resulting file via the IRS FIRE
 * portal at https://fire.irs.gov.
 *
 * XML structure:
 *   <Form1099NECFile>
 *     <TaxYear>YYYY</TaxYear>
 *     <Payer>
 *       <BusinessName>…</BusinessName>
 *     </Payer>
 *     <Form1099NEC> (one per eligible vendor)
 *       <PayerInfo>…</PayerInfo>
 *       <PayeeInfo>…</PayeeInfo>
 *       <NonemployeeCompensation>…</NonemployeeCompensation>
 *     </Form1099NEC>
 *   </Form1099NECFile>
 */
import { and, eq, inArray } from 'drizzle-orm';
import { vendors as vendorsTable } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { getCompany } from '@/lib/services/company';
import { vendor1099Worksheet } from '@/lib/services/statements';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { hasFlag } from './access';

/** One 1099-NEC recipient: box 1 (nonemployee compensation) for the year. */
export interface Nec1099Recipient {
  vendorId: string;
  vendorName: string;
  taxId: string | null;
  /** Box 1 — nonemployee compensation (2dp). */
  total: string;
}

/**
 * The vendors that get a 1099-NEC for `year`, with their box 1 amount: the 1099 worksheet's NEC
 * box 1 (it follows the 1099 account mapping, as QB's 1099 wizard does — rent mapped to MISC box 1
 * and payments on unmapped accounts are not nonemployee compensation), $600 or more. With no
 * mapping every eligible payment counts toward box 1 (same as the worksheet). The e-file, the
 * NEC PDF and the e-file page all use this list, so they agree with the 1099 worksheet.
 */
export async function nec1099Recipients(ctx: ServiceContext, year: number): Promise<Nec1099Recipient[]> {
  const ws = await vendor1099Worksheet(ctx, { year });
  return ws.rows
    .filter((r) => r.necEligible)
    .map((r) => ({ vendorId: r.vendorId, vendorName: r.vendorName, taxId: r.taxId, total: r.nec1 }))
    .sort((a, b) => Money.of(b.total).comparedTo(Money.of(a.total)) || a.vendorName.localeCompare(b.vendorName));
}

/** Address jsonb ({ line1, line2, city, state, zip, … }) → printable lines (as lib/pdf/forms.ts). */
function addressToLines(addr: unknown): string[] {
  if (!addr || typeof addr !== 'object' || Array.isArray(addr)) return [];
  const a = addr as Record<string, unknown>;
  const g = (...keys: string[]) =>
    keys.map((k) => a[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim() ?? '';
  const cityLine = [g('city'), [g('state', 'region'), g('zip', 'postalCode', 'postal_code')].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [g('line1', 'street', 'address1', 'addressLine1'), g('line2', 'address2', 'addressLine2'), cityLine, g('country')].filter(Boolean);
}

/**
 * The payer block of a 1099 (QB prints it from My Company): legal name (else the company name),
 * the payer's TIN (EIN) and address / phone from the company information. A 1099 without the
 * payer's TIN and address cannot be filed or mailed.
 */
export async function payer1099Info(ctx: ServiceContext): Promise<{
  name: string;
  tin: string | null;
  addressLines: string[];
  phone: string | null;
} | null> {
  const company = await getCompany(ctx);
  if (!company) return null;
  const s = (company.settings ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).trim() : '');
  const cityLine = [str('city'), [str('state'), str('zip')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const addressLines = [str('addressLine1'), str('addressLine2'), cityLine].filter(Boolean);
  if (addressLines.length === 0 && str('address')) addressLines.push(str('address'));
  return {
    name: str('legalName') || company.name,
    tin: str('ein') || null,
    addressLines,
    phone: str('phone') || null,
  };
}

/** Recipients' mailing addresses (vendor address) by vendor id. */
export async function recipient1099Addresses(ctx: ServiceContext, vendorIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (vendorIds.length === 0) return out;
  const rows = await ctx.db
    .select({ id: vendorsTable.id, address: vendorsTable.address })
    .from(vendorsTable)
    .where(and(eq(vendorsTable.companyId, ctx.companyId), inArray(vendorsTable.id, vendorIds)));
  for (const r of rows) out.set(r.id, addressToLines(r.address));
  return out;
}

/** Escape XML special characters in a string value. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Wrap text in a tag, applying XML escaping. Omits the element if value is null/undefined. */
function tag(name: string, value: string | null | undefined): string {
  if (value == null || value === '') return `<${name}/>`;
  return `<${name}>${escapeXml(value)}</${name}>`;
}

export interface Generate1099NecFileOptions {
  /** 4-digit calendar year, e.g. 2025. */
  year: number;
}

/**
 * Generate a 1099-NEC XML e-file string for all eligible vendors in the given year.
 *
 * Uses nec1099Recipients (the 1099 worksheet's NEC box 1, $600 or more) to pick the payees.
 * Payer details are pulled from the active company record.
 *
 * Returns the XML as a UTF-8 string. To submit, upload this file to the IRS FIRE system
 * at https://fire.irs.gov using your TCC (Transmitter Control Code).
 *
 * @throws {ServiceError} VALIDATION — if year is out of range.
 * @throws {ServiceError} NOT_FOUND  — if the company record is missing.
 */
export async function generate1099NecFile(
  ctx: ServiceContext,
  { year }: Generate1099NecFileOptions,
): Promise<string> {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new ServiceError('VALIDATION', `Invalid year: ${year}`);
  }
  // The e-file is the IRS copy: every recipient's FULL tax ID. A user whose role hides SSNs / tax
  // IDs got a file with "***-**-6789" in it — a filing the IRS rejects. Refuse instead.
  if (!hasFlag(ctx, 'sensitivePayroll')) {
    throw new ServiceError(
      'FORBIDDEN',
      "Creating the 1099-NEC e-file needs the \"View sensitive payroll data (full SSNs)\" permission: the file must carry each recipient's full tax ID. Ask your administrator to create it, or to add that permission to your role.",
    );
  }

  // Resolve payer info from the company record.
  const payer = await payer1099Info(ctx);
  if (!payer) {
    throw new ServiceError('NOT_FOUND', 'Company not found');
  }

  // NEC box 1 per the 1099 account mapping (the 1099 worksheet), $600 or more.
  const vendors = await nec1099Recipients(ctx, year);
  const addresses = await recipient1099Addresses(ctx, vendors.map((v) => v.vendorId));
  const payerXml = (indent: string) => [
    `${indent}${tag('BusinessName', payer.name)}`,
    `${indent}${tag('TIN', payer.tin)}`,
    ...payer.addressLines.map((l) => `${indent}${tag('AddressLine', l)}`),
    `${indent}${tag('Phone', payer.phone)}`,
  ];

  // Build the XML document.
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!-- 1099-NEC e-file data file for IRS FIRE submission -->');
  lines.push('<!-- IMPORTANT: Transmission to IRS FIRE is external. Upload this file via https://fire.irs.gov -->');
  lines.push('<Form1099NECFile>');
  lines.push(`  ${tag('TaxYear', String(year))}`);
  lines.push(`  ${tag('GeneratedAt', new Date().toISOString())}`);

  // Payer block
  lines.push('  <Payer>');
  lines.push(...payerXml('    '));
  lines.push('  </Payer>');

  // One Form1099NEC record per eligible vendor
  for (const vendor of vendors) {
    lines.push('  <Form1099NEC>');

    // Payer info (duplicated per record to make each element self-contained)
    lines.push('    <PayerInfo>');
    lines.push(...payerXml('      '));
    lines.push('    </PayerInfo>');

    // Payee info
    lines.push('    <PayeeInfo>');
    lines.push(`      ${tag('Name', vendor.vendorName)}`);
    lines.push(`      ${tag('TaxId', vendor.taxId)}`);
    for (const l of addresses.get(vendor.vendorId) ?? []) lines.push(`      ${tag('AddressLine', l)}`);
    lines.push('    </PayeeInfo>');

    // Box 1 — Nonemployee compensation
    lines.push(`    ${tag('NonemployeeCompensation', vendor.total)}`);

    lines.push('  </Form1099NEC>');
  }

  lines.push('</Form1099NECFile>');

  return lines.join('\n');
}
