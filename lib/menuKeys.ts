/**
 * Keyboard behaviour of a small popup menu (WAI-ARIA menu button pattern), kept pure so it can be
 * tested without a DOM: which item gets focus for a key press, or null when the key is not ours.
 * Arrow keys wrap around; Home / End jump to the first / last item.
 */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  const at = current >= 0 && current < count ? current : -1;
  switch (key) {
    case 'ArrowDown':
      return at < 0 ? 0 : (at + 1) % count;
    case 'ArrowUp':
      return at < 0 ? count - 1 : (at - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
