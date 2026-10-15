/**
 * Home page tabs (team home): "Needs attention" (the inbox) and "Overview" (the QuickBooks-style
 * workflow, reminders and snapshot). Simple mode lands on Needs attention; All menus lands on the
 * Overview people already know, with Needs attention one click away as the first tab.
 */
export type HomeTab = 'attention' | 'overview';

export function homeTabFor(param: string | string[] | undefined, navMode: 'simple' | 'advanced'): HomeTab {
  const p = Array.isArray(param) ? param[0] : param;
  if (p === 'attention' || p === 'overview') return p;
  return navMode === 'simple' ? 'attention' : 'overview';
}

export const HOME_TAB_HREF: Record<HomeTab, string> = {
  attention: '/dashboard?tab=attention',
  overview: '/dashboard?tab=overview',
};
