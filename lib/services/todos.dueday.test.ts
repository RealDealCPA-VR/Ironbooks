import { describe, expect, it } from 'vitest';
import { parseTodoBody } from './todos';

describe('legacy ISO due dates keep the day and time as written', () => {
  it('does not shift the day when the time carries an offset', () => {
    expect(parseTodoBody({ title: 'x', dueDate: '2026-03-01T00:30:00+01:00' })).toMatchObject({ dueDate: '2026-03-01', dueTime: '00:30' });
    expect(parseTodoBody({ title: 'x', dueDate: '2026-03-01T23:15:00-08:00' })).toMatchObject({ dueDate: '2026-03-01', dueTime: '23:15' });
    expect(parseTodoBody({ title: 'x', dueDate: '2026-06-10T15:45:00.000Z' })).toMatchObject({ dueDate: '2026-06-10', dueTime: '15:45' });
    expect(parseTodoBody({ title: 'x', dueDate: '2026-06-10T09:05' })).toMatchObject({ dueDate: '2026-06-10', dueTime: '09:05' });
  });
  it('midnight sets no time', () => {
    expect(parseTodoBody({ title: 'x', dueDate: '2026-06-10T00:00:00.000Z' }).dueTime).toBeUndefined();
  });
  it('refuses impossible times instead of rolling into the next day', () => {
    for (const bad of ['2026-02-28T24:00:00Z', '2026-02-28T12:60:00Z', '2026-02-28Tnoon', '2026-02-28T']) {
      expect(() => parseTodoBody({ title: 'x', dueDate: bad }), bad).toThrow(/real date/);
    }
  });
});
