/**
 * Assess Finance Charges helpers (pure, unit-tested in lib/ui.review5.test.ts).
 *
 * The charges on screen were worked out for one assessment date (the preview's asOf). The page
 * shows and assesses a preview only while it is for the date now in the field: a new date needs a
 * new preview, and a preview for an earlier date that answers late is not shown. The assessment
 * is sent for the preview's own date, so what is assessed is what the user reviewed and ticked —
 * the page used to send the date in the field, typed after the preview was worked out.
 */
export interface DatedPreview {
  /** YYYY-MM-DD the charges were worked out for. */
  asOf: string;
}

/** The preview for the date in the field, or null (none yet, or it was for another date). */
export function previewForDate<P extends DatedPreview>(preview: P | null, asOf: string): P | null {
  return preview && preview.asOf === asOf ? preview : null;
}

/** Body of POST /api/finance-charges for the ticked customers of a preview. */
export function assessBody(preview: DatedPreview, selected: Iterable<string>): { asOf: string; customerIds: string[] } {
  return { asOf: preview.asOf, customerIds: [...selected] };
}
