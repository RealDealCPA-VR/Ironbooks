/**
 * Keyboard behaviour of a small popup menu or picker list (WAI-ARIA menu button / listbox
 * patterns), kept pure so it can be tested without a DOM: which item gets focus for a key press,
 * or null when the key is not ours. Arrow keys wrap around; Home / End jump to the first / last
 * item; a letter jumps to the next item starting with it (QuickBooks / Windows first-letter
 * type-ahead), and more letters typed quickly spell the start of a name.
 */
import * as React from 'react';
import { TYPE_AHEAD_MS, typeAheadMatch } from './shortcuts';

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

/** A key as the picker logic needs it. */
export interface PickerKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * The item a key moves to in a list of `labels`: arrows / Home / End as nextMenuIndex, else
 * first-letter type-ahead (`typed` is what was typed just before, within TYPE_AHEAD_MS).
 * Returns the index and the type-ahead word so far, or null when the key is not the picker's.
 */
export function pickerKeyMove(
  e: PickerKey,
  current: number,
  labels: readonly string[],
  typed = '',
): { index: number; typed: string } | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const moved = nextMenuIndex(e.key, current, labels.length);
  if (moved !== null) return { index: moved, typed: '' };
  if (e.key.length !== 1 || (!typed && !/[\p{L}\p{N}]/u.test(e.key))) return null;
  const word = typed + e.key;
  const hit = typeAheadMatch(labels.map((l) => [l]), word, current);
  return hit >= 0 ? { index: hit, typed: word } : { index: current, typed: word };
}

const PICKER_ITEMS = '[role="option"], [role="menuitem"], [role="menuitemradio"], [data-picker-item]';

/**
 * Up / Down / Home / End and first-letter type-ahead for a picker or menu whose items take the
 * focus themselves (role="option" / "menuitem" buttons, or [data-picker-item]). Spread the
 * handler on the list container: `<div role="listbox" onKeyDown={picker.onKeyDown}>`.
 */
export function usePickerKeys<T extends HTMLElement = HTMLElement>(): { onKeyDown: React.KeyboardEventHandler<T> } {
  const typed = React.useRef({ text: '', at: 0 });
  const onKeyDown = React.useCallback<React.KeyboardEventHandler<T>>((e) => {
    if (e.defaultPrevented) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(PICKER_ITEMS)).filter(
      (el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
    );
    if (!items.length) return;
    const current = items.findIndex((el) => el === document.activeElement || el.contains(document.activeElement));
    const now = Date.now();
    const sofar = now - typed.current.at > TYPE_AHEAD_MS ? '' : typed.current.text;
    const move = pickerKeyMove(e, current, items.map((el) => el.getAttribute('data-picker-label') || el.textContent || ''), sofar);
    if (!move) return;
    e.preventDefault();
    typed.current = { text: move.typed, at: now };
    if (move.index >= 0) items[move.index]?.focus();
  }, []);
  return { onKeyDown };
}
