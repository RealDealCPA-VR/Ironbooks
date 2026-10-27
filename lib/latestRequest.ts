/**
 * "Only the latest answer counts" for requests a form re-sends as the user types (a live preview,
 * a lookup): each request takes a ticket when it starts, and its answer is applied only while no
 * later request has started (and the gate was not cancelled). A slower answer for earlier input —
 * or an earlier error — arriving late can then never replace the current one.
 *
 *   const gate = useRef(createLatestGate());
 *   const isLatest = gate.current.begin();
 *   api.post(...).then((p) => { if (isLatest()) setPreview(p); });
 *
 * Pure (no React), unit-tested in lib/ui.review5.test.ts.
 */
export interface LatestGate {
  /** Start a request; the returned check is true while it is still the latest one. */
  begin(): () => boolean;
  /** Drop every request started so far (their answers are ignored). */
  cancel(): void;
}

export function createLatestGate(): LatestGate {
  let seq = 0;
  return {
    begin() {
      const mine = ++seq;
      return () => mine === seq;
    },
    cancel() {
      seq++;
    },
  };
}
