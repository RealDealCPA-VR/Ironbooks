/**
 * Form templates (QB Lists > Templates + Basic Customization / Layout Designer).
 *
 * Several named templates per form type (invoice, estimate, sales receipt, credit memo, sales
 * order, purchase order, statement); one per type may be the default. A template's design is
 * normalized on every write (lib/pdf/design.ts) so the renderer can trust it. Logos are stored
 * locally in the company data directory through the attachments store (entityType
 * 'form_template'), never fetched from anywhere.
 *
 * resolveFormTemplate() is what printing/emailing calls: an explicit template id, else the
 * form's default template, else the built-in standard layout.
 */
import { and, asc, eq } from 'drizzle-orm';
import { formTemplates } from '@/lib/db/schema';
import { defaultDesign, isFormType, normalizeDesign, type FormDesign, type FormType } from '@/lib/pdf/design';
import type { FormLogo } from '@/lib/pdf/template';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { deleteAttachment, getAttachmentFile, saveAttachment } from './attachments';

export type FormTemplateRow = typeof formTemplates.$inferSelect;

export interface FormTemplateView extends Omit<FormTemplateRow, 'design'> {
  design: FormDesign;
}

function view(row: FormTemplateRow): FormTemplateView {
  return { ...row, design: normalizeDesign(row.formType as FormType, row.design) };
}

function assertFormType(formType: unknown): asserts formType is FormType {
  if (!isFormType(formType)) throw validation('Unknown form type.');
}

export async function listFormTemplates(ctx: ServiceContext, formType?: string): Promise<FormTemplateView[]> {
  if (formType !== undefined) assertFormType(formType);
  const rows = await ctx.db
    .select()
    .from(formTemplates)
    .where(
      formType
        ? and(eq(formTemplates.companyId, ctx.companyId), eq(formTemplates.formType, formType))
        : eq(formTemplates.companyId, ctx.companyId),
    )
    .orderBy(asc(formTemplates.formType), asc(formTemplates.name));
  return rows.map(view);
}

async function loadRow(ctx: ServiceContext, id: string): Promise<FormTemplateRow> {
  const [row] = await ctx.db
    .select()
    .from(formTemplates)
    .where(and(eq(formTemplates.id, id), eq(formTemplates.companyId, ctx.companyId)));
  if (!row) throw notFound('Form template');
  return row;
}

export async function getFormTemplate(ctx: ServiceContext, id: string): Promise<FormTemplateView> {
  return view(await loadRow(ctx, id));
}

export interface CreateFormTemplateInput {
  formType: string;
  name: string;
  design?: unknown;
  isDefault?: boolean;
  /** Duplicate an existing template's design (and logo reference). */
  copyFromId?: string | null;
}

async function clearDefault(ctx: ServiceContext, formType: string): Promise<void> {
  await ctx.db
    .update(formTemplates)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(formTemplates.companyId, ctx.companyId),
        eq(formTemplates.formType, formType),
        eq(formTemplates.isDefault, true),
      ),
    );
}

async function assertUniqueName(ctx: ServiceContext, formType: string, name: string, exceptId?: string) {
  const rows = await ctx.db
    .select({ id: formTemplates.id, name: formTemplates.name })
    .from(formTemplates)
    .where(and(eq(formTemplates.companyId, ctx.companyId), eq(formTemplates.formType, formType)));
  if (rows.some((r) => r.id !== exceptId && r.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    throw validation(`A template named "${name}" already exists for this form.`);
  }
}

export async function createFormTemplate(
  ctx: ServiceContext,
  input: CreateFormTemplateInput,
): Promise<FormTemplateView> {
  assertFormType(input.formType);
  const name = input.name?.trim();
  if (!name) throw validation('Template name is required.');
  await assertUniqueName(ctx, input.formType, name);
  let design: FormDesign;
  let logoAttachmentId: string | null = null;
  if (input.copyFromId) {
    const src = await loadRow(ctx, input.copyFromId);
    if (src.formType !== input.formType) throw validation('Can only copy a template of the same form type.');
    design = normalizeDesign(input.formType, input.design ?? src.design);
    logoAttachmentId = src.logoAttachmentId;
  } else {
    design = input.design ? normalizeDesign(input.formType, input.design) : defaultDesign(input.formType);
  }
  if (input.isDefault) await clearDefault(ctx, input.formType);
  const [row] = await ctx.db
    .insert(formTemplates)
    .values({
      companyId: ctx.companyId,
      formType: input.formType,
      name,
      isDefault: Boolean(input.isDefault),
      design: design as unknown as Record<string, unknown>,
      logoAttachmentId,
    })
    .returning();
  await writeAudit(ctx, {
    action: 'create',
    entityType: 'form_template',
    entityId: row.id,
    newValues: { formType: row.formType, name: row.name, isDefault: row.isDefault },
  });
  return view(row);
}

export interface UpdateFormTemplateInput {
  name?: string;
  design?: unknown;
  isDefault?: boolean;
  isActive?: boolean;
}

export async function updateFormTemplate(
  ctx: ServiceContext,
  id: string,
  input: UpdateFormTemplateInput,
): Promise<FormTemplateView> {
  const before = await loadRow(ctx, id);
  const formType = before.formType as FormType;
  const patch: Partial<typeof formTemplates.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw validation('Template name is required.');
    await assertUniqueName(ctx, formType, name, id);
    patch.name = name;
  }
  if (input.design !== undefined) {
    patch.design = normalizeDesign(formType, input.design) as unknown as Record<string, unknown>;
  }
  if (input.isActive !== undefined) {
    patch.isActive = input.isActive;
    if (!input.isActive) patch.isDefault = false; // an inactive template can't be the default
  }
  if (input.isDefault === true) {
    if (input.isActive === false || (!before.isActive && input.isActive !== true)) {
      throw validation('Make the template active before making it the default.');
    }
    await clearDefault(ctx, formType);
    patch.isDefault = true;
  } else if (input.isDefault === false) {
    patch.isDefault = false;
  }
  const [row] = await ctx.db
    .update(formTemplates)
    .set(patch)
    .where(and(eq(formTemplates.id, id), eq(formTemplates.companyId, ctx.companyId)))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'form_template',
    entityId: id,
    oldValues: { name: before.name, isDefault: before.isDefault, isActive: before.isActive, design: before.design },
    newValues: { name: row.name, isDefault: row.isDefault, isActive: row.isActive, design: row.design },
  });
  return view(row);
}

/** Delete a template (the logo file goes too unless another template shares it). */
export async function deleteFormTemplate(ctx: ServiceContext, id: string): Promise<void> {
  const row = await loadRow(ctx, id);
  await ctx.db.delete(formTemplates).where(and(eq(formTemplates.id, id), eq(formTemplates.companyId, ctx.companyId)));
  await writeAudit(ctx, {
    action: 'delete',
    entityType: 'form_template',
    entityId: id,
    oldValues: { formType: row.formType, name: row.name },
  });
  if (row.logoAttachmentId) await releaseLogo(ctx, row.logoAttachmentId);
}

async function releaseLogo(ctx: ServiceContext, attachmentId: string): Promise<void> {
  const users = await ctx.db
    .select({ id: formTemplates.id })
    .from(formTemplates)
    .where(and(eq(formTemplates.companyId, ctx.companyId), eq(formTemplates.logoAttachmentId, attachmentId)));
  if (users.length === 0) {
    await deleteAttachment(ctx, attachmentId).catch(() => undefined);
  }
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Upload (or replace) a template's logo. PNG or JPEG, up to 2 MB, stored in the company file. */
export async function setFormTemplateLogo(
  ctx: ServiceContext,
  id: string,
  input: { filename: string; mimeType: string; base64: string },
): Promise<FormTemplateView> {
  const row = await loadRow(ctx, id);
  const mime = (input.mimeType || '').toLowerCase();
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/jpg') {
    throw validation('The logo must be a PNG or JPEG image.');
  }
  const bytes = Buffer.from(input.base64 || '', 'base64');
  if (bytes.length === 0) throw validation('The logo file is empty.');
  if (bytes.length > LOGO_MAX_BYTES) throw validation('The logo must be 2 MB or smaller.');
  const isPng = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpg) throw validation('The logo file is not a readable PNG or JPEG image.');
  const saved = await saveAttachment(ctx, {
    entityType: 'form_template',
    entityId: id,
    filename: input.filename || (isPng ? 'logo.png' : 'logo.jpg'),
    mimeType: isPng ? 'image/png' : 'image/jpeg',
    base64: input.base64,
  });
  const [updated] = await ctx.db
    .update(formTemplates)
    .set({ logoAttachmentId: saved.id, updatedAt: new Date() })
    .where(eq(formTemplates.id, id))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'form_template',
    entityId: id,
    oldValues: { logoAttachmentId: row.logoAttachmentId },
    newValues: { logoAttachmentId: saved.id },
  });
  if (row.logoAttachmentId) await releaseLogo(ctx, row.logoAttachmentId);
  return view(updated);
}

export async function removeFormTemplateLogo(ctx: ServiceContext, id: string): Promise<FormTemplateView> {
  const row = await loadRow(ctx, id);
  const [updated] = await ctx.db
    .update(formTemplates)
    .set({ logoAttachmentId: null, updatedAt: new Date() })
    .where(eq(formTemplates.id, id))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'form_template',
    entityId: id,
    oldValues: { logoAttachmentId: row.logoAttachmentId },
    newValues: { logoAttachmentId: null },
  });
  if (row.logoAttachmentId) await releaseLogo(ctx, row.logoAttachmentId);
  return view(updated);
}

export interface ResolvedFormTemplate {
  templateId: string | null;
  name: string;
  design: FormDesign;
  logo: FormLogo | null;
}

async function loadLogo(ctx: ServiceContext, attachmentId: string | null): Promise<FormLogo | null> {
  if (!attachmentId) return null;
  try {
    const f = await getAttachmentFile(ctx, attachmentId);
    return { bytes: new Uint8Array(f.buffer), mimeType: f.mimeType ?? 'image/png' };
  } catch {
    return null; // missing logo file: print without it
  }
}

/**
 * The template a form prints with: `templateId` when given (must be this company's template of
 * the same form type), else the form's default template, else the built-in standard layout.
 */
export async function resolveFormTemplate(
  ctx: ServiceContext,
  formType: FormType,
  templateId?: string | null,
): Promise<ResolvedFormTemplate> {
  let row: FormTemplateRow | undefined;
  if (templateId) {
    row = await loadRow(ctx, templateId);
    if (row.formType !== formType) throw validation('That template is for a different kind of form.');
  } else {
    [row] = await ctx.db
      .select()
      .from(formTemplates)
      .where(
        and(
          eq(formTemplates.companyId, ctx.companyId),
          eq(formTemplates.formType, formType),
          eq(formTemplates.isDefault, true),
          eq(formTemplates.isActive, true),
        ),
      );
  }
  if (!row) return { templateId: null, name: 'Standard', design: defaultDesign(formType), logo: null };
  return {
    templateId: row.id,
    name: row.name,
    design: normalizeDesign(formType, row.design),
    logo: await loadLogo(ctx, row.logoAttachmentId),
  };
}
