'use client';
/**
 * Inline field message (lib/fieldValidation.ts). Render right under the input and point the input
 * at it: aria-invalid + aria-describedby={fieldErrorId(formId, key)} — see `fieldA11y`.
 */
import * as React from 'react';
import { fieldErrorId, type FieldErrors } from '@/lib/fieldValidation';

export function FieldError({ formId, name, errors }: { formId: string; name: string; errors: FieldErrors }) {
  const msg = errors[name];
  if (!msg) return null;
  return (
    <p id={fieldErrorId(formId, name)} className="mt-1 text-xs font-medium text-red-600">
      {msg}
    </p>
  );
}

/** Props that mark an input invalid and link it to its FieldError. */
export function fieldA11y(formId: string, name: string, errors: FieldErrors) {
  return errors[name]
    ? ({ 'aria-invalid': true, 'aria-describedby': fieldErrorId(formId, name) } as const)
    : ({} as const);
}

/** Move focus to the first invalid field (inputs carry aria-describedby = its error id). */
export function focusFirstError(formId: string, errors: FieldErrors): void {
  if (typeof document === 'undefined') return;
  const first = Object.keys(errors)[0];
  if (!first) return;
  const el = document.querySelector<HTMLElement>(`[aria-describedby="${fieldErrorId(formId, first)}"]`);
  el?.focus();
}
