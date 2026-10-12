/**
 * GET /api/invoices/custom-fields — company-defined custom field definitions
 * for invoices ([{ name }]), read from companies.settings.customFields.invoice.
 * The invoice modal renders an input per definition and persists the values to
 * invoices.custom_fields.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getInvoiceCustomFieldDefs } from '@/lib/services/invoices';
import { ServiceError } from '@/lib/services/_base';

export async function GET() {
  try {
    const ctx = await getServerContext();
    const fields = await getInvoiceCustomFieldDefs(ctx);
    return NextResponse.json({ fields });
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === 'FORBIDDEN' ? 403 : 400 },
      );
    }
    console.error('[GET /api/invoices/custom-fields]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
