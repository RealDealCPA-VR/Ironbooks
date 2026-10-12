/**
 * P1 setup: every new company (web and desktop) is routed through the setup interview, and the
 * interview can be run again from the menus. Source-level checks (the flows are page redirects
 * and Electron menu wiring, which have no service layer to call).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { navGroups } from './nav';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('new companies go through the setup interview', () => {
  it('sign-up lands on the interview, not the dashboard', () => {
    const src = read('app/signup/page.tsx');
    expect(src).toContain("window.location.href = '/onboarding?new=1'");
    expect(src).not.toContain("window.location.href = '/dashboard'");
  });

  it('New Company (/companies) opens the new company and runs the interview', () => {
    const src = read('app/companies/page.tsx');
    const create = src.slice(src.indexOf('async function create()'), src.indexOf('async function open_('));
    expect(create).toContain("api.post('/api/companies/select', { companyId: created.id })");
    expect(create).toContain("'/onboarding?new=1'");
  });

  it('the desktop File > New Company flow opens Create Account, which leads to the interview', () => {
    const src = read('electron/main.js');
    const flow = src.slice(src.indexOf('async function createCompanyFlow()'), src.indexOf('async function openCompanyFlow()'));
    expect(flow).toContain("saveConfig({ startRoute: '/signup' })");
    // createWindow consumes the one-shot start route.
    expect(src).toContain('saveConfig({ startRoute: null })');
    expect(src).toContain('url + startRoute');
  });

  it('the interview offers Skip and applies answers through the server API', () => {
    const src = read('app/onboarding/page.tsx');
    expect(src).toContain('Skip for now');
    expect(src).toContain("'/api/company/setup-interview', { skip: true }");
    expect(src).toContain("'/api/company/setup-interview',");
  });
});

describe('the interview can be run again from the menus', () => {
  it('desktop Help and Company menus', () => {
    expect(read('electron/main.js')).toContain("{ label: 'Run Setup Interview…', click: () => navigate('/onboarding') }");
    expect(read('electron/menuRoutes.js')).toContain("{ label: 'Setup Interview…', route: '/onboarding' }");
  });

  it('web sidebar (Setup) and command palette', () => {
    const links = navGroups.flatMap((g) => g.links);
    expect(links.some((l) => l.path === '/onboarding' && l.label === 'Setup Interview')).toBe(true);
  });
});
