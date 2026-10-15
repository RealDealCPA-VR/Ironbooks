/**
 * Renderer side of "Keep as a training file" (lib/sandboxClient.ts):
 *  - when the server left the sandbox but could not move the copy (200 with trainingDir null and a
 *    warning), the warning is shown and the desktop shell is STILL told it left (no training file),
 *    so it clears its sandbox flag instead of relaunching into the copy;
 *  - a normal keep hands the training folder to the shell and shows no warning;
 *  - the help text says how the training file / real file is opened, desktop vs browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const post = vi.fn();
vi.mock('@/lib/client', () => ({ api: { post: (...args: unknown[]) => post(...args) } }));

import { isDesktopApp, keepSandbox, keepTrainingHelp, leaveTrainingHelp } from './sandboxClient';

const g = globalThis as unknown as { window?: unknown };

describe('keepSandbox hand-off', () => {
  let left: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    post.mockReset();
    left = vi.fn(async () => true);
    g.window = { bookkeeper: { isDesktop: true, sandbox: { entered: vi.fn(async () => true), left } } };
  });
  afterEach(() => {
    delete g.window;
  });

  it('a failed move still tells the shell it left (no training file), after showing the warning', async () => {
    post.mockResolvedValue({ realDir: '/real', trainingDir: null, name: 'Busy', warning: 'could not be moved' });
    const order: string[] = [];
    left.mockImplementation(async () => {
      order.push('left');
      return true;
    });
    const onWarning = vi.fn(async () => {
      order.push('warning');
    });
    const r = await keepSandbox('Busy', { onWarning });
    expect(post).toHaveBeenCalledWith('/api/sandbox/keep', { name: 'Busy' });
    expect(onWarning).toHaveBeenCalledWith('could not be moved');
    expect(left).toHaveBeenCalledWith({ trainingDir: null });
    expect(order).toEqual(['warning', 'left']);
    expect(r).toEqual({ name: 'Busy', trainingDir: null, warning: 'could not be moved' });
  });

  it('a normal keep hands the training folder to the shell without a warning', async () => {
    post.mockResolvedValue({ realDir: '/real', trainingDir: '/Practice.ironbooks', name: 'Practice' });
    const onWarning = vi.fn();
    const r = await keepSandbox('Practice', { onWarning });
    expect(onWarning).not.toHaveBeenCalled();
    expect(left).toHaveBeenCalledWith({ trainingDir: '/Practice.ironbooks' });
    expect(r).toEqual({ name: 'Practice', trainingDir: '/Practice.ironbooks', warning: null });
  });
});

describe('training-file help text', () => {
  afterEach(() => {
    delete g.window;
  });

  it('detects the desktop app from the bridge', () => {
    expect(isDesktopApp()).toBe(false);
    g.window = { bookkeeper: { isDesktop: true } };
    expect(isDesktopApp()).toBe(true);
    g.window = {};
    expect(isDesktopApp()).toBe(false);
  });

  it('desktop points at File > Open Company; the browser version at BKA_DATA_DIR', () => {
    expect(keepTrainingHelp(true)).toMatch(/File > Open Company/);
    expect(keepTrainingHelp(true)).not.toMatch(/BKA_DATA_DIR/);
    expect(keepTrainingHelp(false)).toMatch(/browser version/);
    expect(keepTrainingHelp(false)).toMatch(/BKA_DATA_DIR/);
    expect(keepTrainingHelp(false)).not.toMatch(/File > Open Company/);
    expect(leaveTrainingHelp(true)).toMatch(/File > Open Company/);
    expect(leaveTrainingHelp(false)).toMatch(/BKA_DATA_DIR/);
  });
});
