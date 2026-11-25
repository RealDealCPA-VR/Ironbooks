// Switching to another client's company file by its company name (found by a live two-client
// trial: the agent could not see Recent Companies' paths, and its save folders were the wrong test).
import { describe, expect, it } from 'vitest';
import { operationById } from '@/lib/agent/operations/registry';
import { describeRequest } from '@/lib/agent/describe';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';

describe('shell.company.switch', () => {
  const op = () => {
    const o = operationById('shell.company.switch');
    if (!o) throw new Error('no shell.company.switch');
    return o;
  };

  it('takes the company name as Recent Companies shows it, or a full path, and neither is required alone', () => {
    const def = SHELL_OPERATIONS.find((d) => d.id === 'shell.company.switch')!;
    expect(def.input.company).toMatchObject({ type: 'string', required: false });
    expect(def.input.file).toMatchObject({ type: 'path', required: false });
    // The desktop shell admits only Recent Companies: the agent's save folders do not judge it.
    expect(def.recentCompaniesOnly).toBe(true);
  });

  it('the card line names the company or the file asked for', () => {
    expect(describeRequest(op(), { body: { company: 'Birch Books' } })).toBe('Switch to company file Birch Books');
    expect(describeRequest(op(), { body: { file: 'C:\\Books\\Birch\\Birch Books.ironbooks' } })).toMatch(/^Switch to company file .*Birch Books\.ironbooks$/);
  });
});
