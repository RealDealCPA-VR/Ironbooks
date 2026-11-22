/**
 * POST /api/invoices/batch — Batch Invoicing (wave2 sales C6): the same lines billed to many
 * customers. Body: { customerIds, date, dueDate?, lines, taxRateId?, useCustomerTaxRate?, memo?,
 * classId?, toBePrinted?, toBeEmailed?, overrideCreditLimit? }. Returns { created, skipped }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createBatchInvoices } from '@/lib/services/batchInvoicing';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { batchInvoicesSchema } from '@/lib/validation/invoices';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = batchInvoicesSchema.safeParse(await req.json().catch(() => ({})));
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
