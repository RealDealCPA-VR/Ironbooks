/**
 * POST /api/invoices/batch — Batch Invoicing (wave2 sales C6): the same lines billed to many
 * customers. Body: { customerIds, date, dueDate?, lines, taxRateId?, useCustomerTaxRate?, memo?,
 * classId?, toBePrinted?, toBeEmailed?, overrideCreditLimit? }. Returns { created, skipped }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { createBatchInvoices } from '@/lib/services/batchInvoicing';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { zDate, zLines, zUuid, zodErrorBody } from '@/lib/validation/helpers';
import { invoiceLineSchema } from '@/lib/validation/invoices';

const schema = z.object({
  customerIds: z.array(zUuid).min(1, 'pick at least one customer'),
  date: zDate,
  dueDate: zDate.nullish(),
  lines: zLines(invoiceLineSchema),
  taxRateId: zUuid.nullish(),
  useCustomerTaxRate: z.boolean().optional(),
  memo: z.string().nullish(),
  classId: zUuid.nullish(),
  toBePrinted: z.boolean().optional(),
  toBeEmailed: z.boolean().optional(),
  overrideCreditLimit: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { taxRateId, ...rest } = parsed.data;
    const result = await createBatchInvoices(ctx, {
      ...rest,
      // An explicit tax rate (or explicit null with useCustomerTaxRate=false) overrides each customer.
      ...(rest.useCustomerTaxRate === false ? { taxRateId: taxRateId ?? null } : {}),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return routeErrorWithWarnings(err, 'POST /api/invoices/batch');
  }
}
