'use client';
/**
 * Form Templates (QB Lists > Templates + Basic Customization / Layout Designer).
 *
 * Several templates per form (invoice, estimate, sales receipt, credit memo, sales order,
 * purchase order, statement). Each sets the title, font, colors, logo, which header fields and
 * line columns print (and what they're called), and the header/footer text. One template per
 * form can be the default: printing and emailing use it unless another is picked.
 * The preview renders a sample document with exactly the PDF renderer used for real forms.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, FileText, ImagePlus, Plus, Star, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Label,
  PageHeader,
  Select,
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { fileToBase64 } from '@/components/AttachmentPanel';
import {
  FORM_FIELDS,
  FORM_TYPES,
  FORM_TYPE_LABELS,
  defaultDesign,
  normalizeDesign,
  type FormDesign,
  type FormType,
} from '@/lib/pdf/design';

interface TemplateRow {
  id: string;
  formType: FormType;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  design: FormDesign;
  logoAttachmentId: string | null;
}

const BUILTIN_ID = 'builtin';

export default function TemplatesPage() {
  const [formType, setFormType] = useState<FormType>('invoice');
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>(BUILTIN_ID);
  const [name, setName] = useState('');
  const [design, setDesign] = useState<FormDesign>(defaultDesign('invoice'));
  const [saving, setSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const selected = useMemo(() => templates.find((t) => t.id === selectedId) ?? null, [templates, selectedId]);
  const forType = useMemo(() => templates.filter((t) => t.formType === formType), [templates, formType]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await api.get<TemplateRow[]>('/api/form-templates'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load templates', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Selecting a template (or the built-in standard layout) loads it into the editor.
  useEffect(() => {
    if (selected) {
      setName(selected.name);
      setDesign(normalizeDesign(selected.formType, selected.design));
    } else {
      setName('');
      setDesign(defaultDesign(formType));
    }
  }, [selected, formType]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function patch(p: Partial<FormDesign>) {
    setDesign((d) => ({ ...d, ...p }));
  }

  async function preview() {
    setPreviewing(true);
    try {
      const res = await fetch('/api/form-templates/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ formType, design, templateId: selected?.id ?? null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Preview failed');
      const blob = await res.blob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Preview failed', 'danger');
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      if (selected) {
        const updated = await api.patch<TemplateRow>(`/api/form-templates/${selected.id}`, { name, design });
        setTemplates((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
        toast('Template saved', 'success');
      } else {
        const trimmed = name.trim() || `My ${FORM_TYPE_LABELS[formType]}`;
        const created = await api.post<TemplateRow>('/api/form-templates', {
          formType,
          name: trimmed,
          design,
          isDefault: forType.length === 0,
        });
        setTemplates((ts) => [...ts, created]);
        setSelectedId(created.id);
        toast(
          created.isDefault ? `Saved "${created.name}" — it is now the default ${FORM_TYPE_LABELS[formType].toLowerCase()} template` : `Saved "${created.name}"`,
          'success',
        );
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the template', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function duplicate() {
    if (!selected) return;
    try {
      const created = await api.post<TemplateRow>('/api/form-templates', {
        formType,
        name: `${selected.name} (copy)`,
        copyFromId: selected.id,
        design,
      });
      setTemplates((ts) => [...ts, created]);
      setSelectedId(created.id);
      toast('Template copied', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not copy the template', 'danger');
    }
  }

  async function setFlag(body: { isDefault?: boolean; isActive?: boolean }) {
    if (!selected) return;
    try {
      await api.patch(`/api/form-templates/${selected.id}`, body);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update the template', 'danger');
    }
  }

  async function remove() {
    if (!selected) return;
    setDeleting(true);
    try {
      await api.del(`/api/form-templates/${selected.id}`);
      setDeleteOpen(false);
      setSelectedId(BUILTIN_ID);
      await load();
      toast('Template deleted', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete the template', 'danger');
    } finally {
      setDeleting(false);
    }
  }

  async function uploadLogo(file: File | undefined) {
    if (!file || !selected) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      toast('Pick a PNG or JPEG image for the logo.', 'danger');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast('The logo must be 2 MB or smaller.', 'danger');
      return;
    }
    try {
      const updated = await api.post<TemplateRow>(`/api/form-templates/${selected.id}/logo`, {
        filename: file.name,
        mimeType: file.type,
        base64: await fileToBase64(file),
      });
      setTemplates((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
      toast('Logo added', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add the logo', 'danger');
    }
  }

  async function removeLogo() {
    if (!selected) return;
    try {
      const updated = await api.del<TemplateRow>(`/api/form-templates/${selected.id}/logo`);
      setTemplates((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove the logo', 'danger');
    }
  }

  function moveColumn(i: number, dir: -1 | 1) {
    setDesign((d) => {
      const cols = [...d.columns];
      const j = i + dir;
      if (j < 0 || j >= cols.length) return d;
      [cols[i], cols[j]] = [cols[j], cols[i]];
      return { ...d, columns: cols };
    });
  }

  const fieldOrder = FORM_FIELDS[formType].map(([k]) => k);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Form Templates" icon={FileText} />
      <p className="mb-6 max-w-3xl text-sm text-navy/60">
        Choose how your forms look when you print or email them. Make as many templates as you like and pick
        one as the default for each kind of form. Logos stay inside your company file.
      </p>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Template list */}
        <Card className="w-full p-4 lg:w-72 lg:shrink-0">
          <Label htmlFor="tpl-form">Form</Label>
          <Select
            id="tpl-form"
            value={formType}
            onChange={(e) => {
              setFormType(e.target.value as FormType);
              setSelectedId(BUILTIN_ID);
            }}
          >
            {FORM_TYPES.map((f) => (
              <option key={f} value={f}>
                {FORM_TYPE_LABELS[f]}
              </option>
            ))}
          </Select>
          <div className="mt-4 flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setSelectedId(BUILTIN_ID)}
              className={`rounded-lg px-3 py-2 text-left text-sm ${selectedId === BUILTIN_ID ? 'bg-electric text-white' : 'text-navy hover:bg-electric/10'}`}
            >
              Standard (built in)
              {!forType.some((t) => t.isDefault && t.isActive) && <span className="ml-1 text-xs opacity-70">· default</span>}
            </button>
            {loading ? (
              <div className="flex justify-center py-3 text-electric">
                <Spinner className="h-4 w-4" />
              </div>
            ) : (
              forType.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${selectedId === t.id ? 'bg-electric text-white' : 'text-navy hover:bg-electric/10'} ${t.isActive ? '' : 'opacity-50'}`}
                >
                  <span className="truncate">{t.name}</span>
                  {t.isDefault && <Star className="h-3.5 w-3.5 shrink-0" aria-label="Default" />}
                </button>
              ))
            )}
          </div>
          <Button
            className="mt-4 w-full"
            variant="secondary"
            size="sm"
            onClick={() => {
              setSelectedId(BUILTIN_ID);
              setName(`My ${FORM_TYPE_LABELS[formType]}`);
              setDesign(defaultDesign(formType));
            }}
          >
            <Plus className="h-4 w-4" /> New template
          </Button>
        </Card>

        {/* Editor */}
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <Card className="p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {selected ? (
                <>
                  {selected.isDefault && <Badge tone="success">Default</Badge>}
                  {!selected.isActive && <Badge tone="neutral">Inactive</Badge>}
                  {!selected.isDefault && selected.isActive && (
                    <Button size="sm" variant="ghost" onClick={() => void setFlag({ isDefault: true })}>
                      <Star className="h-3.5 w-3.5" /> Make default
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void setFlag({ isActive: !selected.isActive })}>
                    {selected.isActive ? 'Make inactive' : 'Make active'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void duplicate()}>
                    <Copy className="h-3.5 w-3.5" /> Duplicate
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
                    <Trash2 className="h-3.5 w-3.5 text-red-500" /> Delete
                  </Button>
                </>
              ) : (
                <p className="text-sm text-navy/60">
                  Editing a copy of the standard layout. Save it to create your own template.
                </p>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="t-name">Template name</Label>
                <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`My ${FORM_TYPE_LABELS[formType]}`} />
              </div>
              <div>
                <Label htmlFor="t-title">Title printed on the form</Label>
                <Input id="t-title" value={design.title} onChange={(e) => patch({ title: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="t-font">Font</Label>
                <Select id="t-font" value={design.font} onChange={(e) => patch({ font: e.target.value as FormDesign['font'] })}>
                  <option value="helvetica">Helvetica (clean)</option>
                  <option value="times">Times (classic)</option>
                  <option value="courier">Courier (typewriter)</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="t-size">Text size</Label>
                <Select id="t-size" value={String(design.fontSize)} onChange={(e) => patch({ fontSize: Number(e.target.value) })}>
                  {[8, 9, 10, 11, 12].map((n) => (
                    <option key={n} value={n}>
                      {n} pt
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="t-accent">Accent color</Label>
                <input id="t-accent" type="color" value={design.accentColor} onChange={(e) => patch({ accentColor: e.target.value })} className="h-10 w-20 cursor-pointer rounded border border-slate-200" />
              </div>
              <div>
                <Label htmlFor="t-ink">Heading color</Label>
                <input id="t-ink" type="color" value={design.textColor} onChange={(e) => patch({ textColor: e.target.value })} className="h-10 w-20 cursor-pointer rounded border border-slate-200" />
              </div>
            </div>
          </Card>

          <Card className="p-6">
            <h2 className="mb-3 text-base font-bold text-navy">Company block &amp; logo</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {(
                [
                  ['showCompanyName', 'Company name'],
                  ['showCompanyAddress', 'Address'],
                  ['showCompanyPhone', 'Phone'],
                  ['showCompanyEmail', 'Email'],
                  ['showPageNumbers', 'Page numbers (multi-page forms)'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-sm text-navy">
                  <input type="checkbox" checked={design[k]} onChange={(e) => patch({ [k]: e.target.checked } as Partial<FormDesign>)} className="h-4 w-4" />
                  {label}
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Label htmlFor="t-logo-pos" className="mb-0">
                Logo and company on the
              </Label>
              <Select id="t-logo-pos" value={design.logoPosition} onChange={(e) => patch({ logoPosition: e.target.value as 'left' | 'right' })} className="w-32">
                <option value="left">Left</option>
                <option value="right">Right</option>
              </Select>
              {selected ? (
                <>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-slate-50">
                    <ImagePlus className="h-4 w-4" /> {selected.logoAttachmentId ? 'Replace logo' : 'Add logo'}
                    <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { void uploadLogo(e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                  {selected.logoAttachmentId && (
                    <Button size="sm" variant="ghost" onClick={() => void removeLogo()}>
                      Remove logo
                    </Button>
                  )}
                </>
              ) : (
                <span className="text-xs text-navy/50">Save the template first, then add a logo.</span>
              )}
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="t-header">Extra header text</Label>
                <textarea id="t-header" rows={2} spellCheck value={design.headerText} onChange={(e) => patch({ headerText: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="e.g. Contractor license #12345" />
              </div>
              <div>
                <Label htmlFor="t-footer">Footer text</Label>
                <textarea id="t-footer" rows={2} spellCheck value={design.footerText} onChange={(e) => patch({ footerText: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </div>
            </div>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="p-6">
              <h2 className="mb-3 text-base font-bold text-navy">Header fields</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-navy/50">
                    <th className="py-1">Print</th>
                    <th className="py-1">Label on the form</th>
                  </tr>
                </thead>
                <tbody>
                  {fieldOrder.map((k) => (
                    <tr key={k} className="border-t border-slate-100">
                      <td className="py-1.5 pr-3">
                        <input
                          type="checkbox"
                          aria-label={`Print ${design.fields[k]?.label ?? k}`}
                          checked={design.fields[k]?.show ?? false}
                          onChange={(e) => patch({ fields: { ...design.fields, [k]: { ...design.fields[k], show: e.target.checked } } })}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="py-1.5">
                        <Input
                          aria-label={`Label for ${k}`}
                          value={design.fields[k]?.label ?? ''}
                          onChange={(e) => patch({ fields: { ...design.fields, [k]: { ...design.fields[k], label: e.target.value } } })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card className="p-6">
              <h2 className="mb-3 text-base font-bold text-navy">Columns</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-navy/50">
                    <th className="py-1">Print</th>
                    <th className="py-1">Title</th>
                    <th className="py-1">Width</th>
                    <th className="py-1">Order</th>
                  </tr>
                </thead>
                <tbody>
                  {design.columns.map((c, i) => (
                    <tr key={c.key} className="border-t border-slate-100">
                      <td className="py-1.5 pr-2">
                        <input
                          type="checkbox"
                          aria-label={`Print column ${c.label}`}
                          checked={c.show}
                          onChange={(e) => setDesign((d) => ({ ...d, columns: d.columns.map((x) => (x.key === c.key ? { ...x, show: e.target.checked } : x)) }))}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <Input
                          aria-label={`Title for column ${c.key}`}
                          value={c.label}
                          onChange={(e) => setDesign((d) => ({ ...d, columns: d.columns.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)) }))}
                        />
                      </td>
                      <td className="w-20 py-1.5 pr-2">
                        <Input
                          aria-label={`Width for column ${c.label}`}
                          type="number"
                          min={0.5}
                          max={20}
                          step={0.5}
                          value={c.width}
                          onChange={(e) => setDesign((d) => ({ ...d, columns: d.columns.map((x) => (x.key === c.key ? { ...x, width: Math.min(20, Math.max(0.5, Number(e.target.value) || 1)) } : x)) }))}
                        />
                      </td>
                      <td className="whitespace-nowrap py-1.5">
                        <button type="button" aria-label="Move up" onClick={() => moveColumn(i, -1)} className="rounded p-1 text-navy/50 hover:bg-navy/5">
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" aria-label="Move down" onClick={() => moveColumn(i, 1)} className="rounded p-1 text-navy/50 hover:bg-navy/5">
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void save()} loading={saving}>
              {selected ? 'Save template' : 'Save as new template'}
            </Button>
            <Button variant="secondary" onClick={() => void preview()} loading={previewing}>
              <Eye className="h-4 w-4" /> Preview
            </Button>
          </div>

          {previewUrl && (
            <Card className="overflow-hidden p-0">
              <iframe title="Template preview" src={previewUrl} className="h-[800px] w-full" />
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete Template"
        message={<>Delete &quot;{selected?.name}&quot;? Forms will print with the default template instead.</>}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={() => void remove()}
        onClose={() => setDeleteOpen(false)}
      />
    </main>
  );
}
