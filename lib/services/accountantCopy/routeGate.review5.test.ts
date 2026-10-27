/**
 * Review round 5 — Accountant's Copy route gate. Saves that never change the books must work in the
 * accountant's working copy (each path below was refused before the fix):
 *  - File > Save Company File from the title bar (POST /api/company-file/save);
 *  - the price lookup every sales form makes while lines are typed (POST /api/pricing/quote — a
 *    read-only quote; refused, the invoice silently showed the item's base price instead of the
 *    customer's price level);
 *  - the live preview of a form template (read-only);
 *  - to-dos added / ticked off from the Calendar (/api/calendar/todos is the same To Do list as
 *    /api/todos, which was already allowed);
 *  - switching to single-user mode (a session mode, like signing in);
 *  - asking the AI assistant a question (read-only report tools; proposals it makes still go
 *    through /api/ai/proposals, which stays refused);
 *  - a transaction typed into an account register (POST /api/registers/<account>): it is saved as
 *    a check, deposit, transfer, card charge / credit or General Journal entry — all carried by the
 *    changes file, exactly as when entered on those forms (which were allowed).
 */
import { describe, expect, it } from 'vitest';
import { accountantCopyAllowsApi } from './routeGate';

describe("Accountant's Copy gate allows housekeeping that never changes the books", () => {
  it('allows the read-only / housekeeping saves', () => {
    for (const p of [
      '/api/company-file/save',
      '/api/pricing/quote',
      '/api/form-templates/preview',
      '/api/calendar/todos',
      '/api/calendar/todos/abc',
      '/api/single-user',
      '/api/ai/assistant',
      '/api/registers/0b6c3f0e-3f7b-4b7e-9d1e-2b8a4f6c9d10',
    ]) {
      expect(accountantCopyAllowsApi(p), p).toBe(true);
    }
  });

  it('still refuses their neighbours that do change things', () => {
    for (const p of [
      '/api/company-file/save-as',
      '/api/company-file/close',
      '/api/pricing/rules',
      '/api/pricing/levels',
      '/api/form-templates',
      '/api/form-templates/abc',
      '/api/ai/proposals/abc',
      '/api/ai/settings',
      '/api/ai/bank-suggestions',
      '/api/company',
    ]) {
      expect(accountantCopyAllowsApi(p), p).toBe(false);
    }
  });
});
