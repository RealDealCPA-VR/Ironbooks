/**
 * Review round 5 (team uib): pages whose data could not be loaded.
 *
 *  - Privacy & Network, Multi-user and Users & Roles > Password rules showed their loading
 *    skeleton ("Loading password rules…") for ever when the first load failed (server restarting,
 *    the host connection dropped), with no way to retry short of reloading the window; Multi-user
 *    also raised the same error toast again every 30 seconds while it kept polling. They now say
 *    the page could not be loaded and offer Try again; Multi-user notes a failed refresh once,
 *    on the page.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LoadFailed from '@/components/LoadFailed';

const src = (f: string) => fs.readFileSync(f, 'utf8');

describe('LoadFailed', () => {
  it('says what failed and offers Try again', () => {
    const html = renderToStaticMarkup(createElement(LoadFailed, { message: 'The server is restarting.', onRetry: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('This page could not be loaded.');
    expect(html).toContain('The server is restarting.');
    expect(html).toContain('Try again');
  });
});

describe('pages show a failed load instead of loading for ever', () => {
  it('Privacy & Network', () => {
    const s = src('app/privacy/page.tsx');
    expect(s).toMatch(/loadError \? <LoadFailed[^>]*onRetry=\{\(\) => void load\(\)\}/);
    expect(s).toContain('else setLoadError(msg)');
  });

  it('Multi-user: no toast on every 30-second refresh; a failed first load offers Try again', () => {
    const s = src('app/multi-user/page.tsx');
    const load = s.slice(s.indexOf('const load = useCallback'), s.indexOf('const retry'));
    expect(load).not.toContain('toast(');
    expect(load).toContain('setLoadError(');
    expect(s).toMatch(/loadError \? <LoadFailed/);
  });

  it('Users & Roles > Password rules', () => {
    const s = src('app/users/PasswordPolicyEditor.tsx');
    expect(s).toMatch(/loadError \? \(\s*<LoadFailed/);
  });
});
