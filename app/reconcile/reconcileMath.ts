/**
 * Reconcile window state helpers (pure, unit-tested in lib/ui.review5.test.ts). Whether Finish is
 * offered is the service's own rule: lib/reconcileRules.ts canFinishReconciliation.
 */

/**
 * A line's cleared mark after a toggle request answered. The request said which state it asked
 * for, so the line takes THAT state — flipping whatever the line shows now went wrong when a
 * line was clicked again before the first answer came back (the box ended unticked while the
 * server had it cleared).
 */
export function applyClearedAnswer<L extends { journalEntryLineId: string; isCleared: boolean }>(
  lines: L[],
  lineId: string,
  isCleared: boolean,
): L[] {
  return lines.map((l) => (l.journalEntryLineId === lineId ? { ...l, isCleared } : l));
}
