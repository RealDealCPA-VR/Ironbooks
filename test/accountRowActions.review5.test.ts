/**
 * Round-5 review regression (Chart of Accounts): an account made inactive could never be made
 * active again from the Chart of Accounts — its row only offered Edit (which has no active
 * switch) and Deactivate showed for active accounts only. QuickBooks offers "Make Account Active"
 * on an inactive account; so does the row now. Rendered with react-dom/server (no DOM needed).
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AccountRowActions from '@/app/accounts/_components/AccountRowActions';

const noop = () => {};
const render = (isActive: boolean) =>
  renderToStaticMarkup(
    createElement(AccountRowActions, { name: 'Petty Cash', isActive, onEdit: noop, onDeactivate: noop, onReactivate: noop }),
  );

describe('Chart of Accounts row actions (review round 5)', () => {
  it('an inactive account can be made active again', () => {
    const html = render(false);
    expect(html).toContain('aria-label="Make Petty Cash active"');
    expect(html).not.toContain('aria-label="Make Petty Cash inactive"');
  });

  it('an active account can be made inactive, not active', () => {
    const html = render(true);
    expect(html).toContain('aria-label="Make Petty Cash inactive"');
    expect(html).not.toContain('aria-label="Make Petty Cash active"');
  });

  it('both offer Edit, named after the account for screen readers', () => {
    for (const active of [true, false]) expect(render(active)).toContain('aria-label="Edit Petty Cash"');
  });
});
