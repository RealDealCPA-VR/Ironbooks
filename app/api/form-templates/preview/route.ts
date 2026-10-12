/**
 * POST /api/form-templates/preview — live preview of a (possibly unsaved) design on sample data.
 *   Body: { formType, design?, templateId? }  (templateId reuses that template's saved logo)
 * Returns an inline PDF.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resolveFormTemplate } from '@/lib/services/formTemplates';
import { companyLetterhead } from '@/lib/pdf/forms';
import { renderFormPdf, sampleFormDocument } from '@/lib/pdf/template';
import { pdfResponse, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { previewFormTemplateSchema } from '@/lib/validation/prefs';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = previewFormTemplateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { formType, design, templateId } = parsed.data;
    const saved = templateId ? await resolveFormTemplate(ctx, formType, templateId) : null;
    const lh = await companyLetterhead(ctx);
    const doc = sampleFormDocument(formType, lh.name);
    if (lh.addressLines.length) doc.company.addressLines = lh.addressLines;
    if (lh.phone) doc.company.phone = lh.phone;
    if (lh.email) doc.company.email = lh.email;
    const bytes = await renderFormPdf(doc, design ?? saved?.design ?? null, saved?.logo ?? null);
    return pdfResponse(bytes, `${formType}-preview.pdf`);
  } catch (err) {
    return routeError(err, 'POST /api/form-templates/preview');
  }
}
