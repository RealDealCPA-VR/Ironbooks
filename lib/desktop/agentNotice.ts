/**
 * Agent full access: a desktop notice when an agent asks and the window is not in front (plan §7.2).
 *
 * The desktop shell's preload (electron/preload.js) puts `agentNotice` on window.bookkeeper; the
 * main process shows the notice only while the Ironbooks window is not focused, and clicking it
 * brings the window forward on the approval center (electron/agentShell.js showNotice). In a
 * browser, or an older desktop app without it, this does nothing.
 *
 * Title and body only, in plain words, built by the caller from the request's summary: never the
 * agent's own words (its reason), which the approval center shows labelled as the agent's.
 */

interface DesktopBridge {
  agentNotice?: (notice: { title: string; body: string; href: string }) => unknown;
}

/** Show the notice through the desktop shell; does nothing in a browser. Clicking it opens `href`. */
export function showAgentRequestNotice(notice: { title: string; body: string; href: string }): void {
  if (typeof window === 'undefined') return;
  const bridge = (window as unknown as { bookkeeper?: DesktopBridge }).bookkeeper;
  if (!bridge || typeof bridge.agentNotice !== 'function') return;
  const n = {
    title: String(notice?.title ?? ''),
    body: String(notice?.body ?? ''),
    href: String(notice?.href ?? '/agent-requests'),
  };
  if (!n.title.trim()) return;
  try {
    const shown = bridge.agentNotice(n);
    // A notice that could not be shown is not worth an error on the page.
    if (shown && typeof (shown as Promise<unknown>).catch === 'function') (shown as Promise<unknown>).catch(() => {});
  } catch {
    /* the window keeps working without the notice */
  }
}
