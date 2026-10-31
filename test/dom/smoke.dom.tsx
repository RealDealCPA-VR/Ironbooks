// The DOM test harness itself (test/domHarness.ts): real key presses type into fields and Tab
// moves the focus, the way a keyboard does.
import * as React from 'react';
import { domTest, mount, press, typeText, equal, runDomTests, $, focusedLabel, stubFetch } from './kit';

domTest('typing and Tab are real key presses', async () => {
  await mount(
    <div>
      <input aria-label="First" />
      <input aria-label="Second" />
    </div>,
  );
  $<HTMLInputElement>('input')!.focus();
  await typeText('ab');
  equal($<HTMLInputElement>('input')!.value, 'ab', 'typed text');
  await press('Tab');
  equal(focusedLabel(), 'Second', 'Tab moves to the next field');
  await press('Tab', { shift: true });
  equal(focusedLabel(), 'First', 'Shift+Tab moves back');
});

domTest('fetch can be answered by the test', async () => {
  const calls = stubFetch({ 'GET /api/thing': { ok: 1 } });
  const r = await fetch('/api/thing');
  equal(r.status, 200, 'stubbed status');
  equal(JSON.stringify(await r.json()), '{"ok":1}', 'stubbed body');
  const missing = await fetch('/api/other', { method: 'POST', body: '{}' });
  equal(missing.status, 404, 'an unstubbed route answers 404');
  equal(calls.map((c) => `${c.method} ${c.path}`).join(','), 'GET /api/thing,POST /api/other', 'calls are recorded');
});

void runDomTests();
