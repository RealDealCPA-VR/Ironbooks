import * as React from 'react';
import { domTest, mount, press, check, runDomTests, $, focusedLabel } from './kit';
import { Input } from '@/components/ui';

domTest('tab', async () => {
  await mount(
    <div>
      <Input aria-label="Before" />
      <Input type="date" aria-label="Date" defaultValue="2026-03-15" />
      <Input aria-label="After" />
    </div>,
  );
  $<HTMLInputElement>('input')!.focus();
  const seen: string[] = [focusedLabel()];
  for (let i = 0; i < 5; i++) {
    await press('Tab');
    seen.push(focusedLabel());
  }
  check(false, `seq: ${seen.join(' > ')} hasFocus=${document.hasFocus()}`);
});

void runDomTests();
