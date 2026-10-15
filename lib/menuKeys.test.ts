/**
 * Keyboard movement of the inbox's "Later" menu (components/AttentionInbox.tsx LaterMenu):
 * Up / Down wrap, Home / End jump, other keys are left alone.
 */
import { describe, expect, it } from 'vitest';
import { nextMenuIndex } from './menuKeys';

describe('nextMenuIndex', () => {
  it('moves down and up, wrapping around', () => {
    expect(nextMenuIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 1, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2);
  });

  it('jumps with Home / End', () => {
    expect(nextMenuIndex('Home', 2, 3)).toBe(0);
    expect(nextMenuIndex('End', 0, 3)).toBe(2);
  });

  it('starts at an end when nothing in the menu has focus', () => {
    expect(nextMenuIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', -1, 3)).toBe(2);
    expect(nextMenuIndex('ArrowDown', 7, 3)).toBe(0);
  });

  it('ignores other keys and empty menus', () => {
    expect(nextMenuIndex('Enter', 0, 3)).toBeNull();
    expect(nextMenuIndex('a', 0, 3)).toBeNull();
    expect(nextMenuIndex('ArrowDown', 0, 0)).toBeNull();
  });
});
