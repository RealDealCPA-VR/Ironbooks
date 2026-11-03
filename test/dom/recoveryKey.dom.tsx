// The recovery key's "Print…" (filecrypto): printed from the page itself with window.print() — the
// desktop app refuses blank pop-up windows (electron/security.js), so the old window.open('') did
// nothing there. While printing, only the recovery key sheet is on the page; afterwards it is gone.
// "Save to a File…" keeps working (window.bookkeeper.saveBytes on the desktop).
import * as React from 'react';
import { RECOVERY_PRINT_ID, RecoveryKeyPanel } from '@/components/FileProtection';
import { $, button, check, click, domTest, equal, mount, runDomTests, settle, textOf, unmount } from './kit';

const KEY = '7K3Q-9XHD-M2PA-4TZB-HV8C-1N6R';

domTest('Print… prints the recovery key from this page, never through a pop-up window', async () => {
  const opened: unknown[] = [];
  const printed: Array<{ sheet: string; bodyHidden: boolean; css: string }> = [];
  const realOpen = window.open;
  const realPrint = window.print;
  window.open = ((...args: unknown[]) => {
    opened.push(args);
    return null; // what the desktop app answers for about:blank
  }) as typeof window.open;
  window.print = () => {
    const sheet = document.getElementById(RECOVERY_PRINT_ID);
    printed.push({
      sheet: sheet ? textOf(sheet) : '',
      bodyHidden: document.body.classList.contains('ib-printing-recovery-key') && sheet?.parentElement === document.body,
      css: sheet?.querySelector('style')?.textContent ?? '',
    });
  };
  try {
    await mount(<RecoveryKeyPanel recoveryKey={KEY} companyName="Copper Kettle" onDone={() => undefined} />);
    const done = button('Continue');
    check(done?.disabled, 'Continue waits until the key was printed or saved');
    await click(button(/Print/), 'Print…');
    equal(opened.length, 0, 'no pop-up window is opened');
    equal(printed.length, 1, 'window.print() ran once');
    check(printed[0].sheet.includes(KEY), `the printed sheet shows the key: ${printed[0].sheet}`);
    check(printed[0].sheet.includes('Copper Kettle'), 'the printed sheet names the company file');
    check(printed[0].sheet.includes('ONLY way back in'), 'the printed sheet says it is the only way back in');
    check(printed[0].bodyHidden, 'the rest of the page is hidden while printing');
    check(/@media print/.test(printed[0].css) && /display:none!important/.test(printed[0].css), 'print rules hide everything but the sheet');
    // After printing the sheet goes away again.
    window.dispatchEvent(new Event('afterprint'));
    await settle();
    equal(document.getElementById(RECOVERY_PRINT_ID), null, 'the print sheet is removed after printing');
    check(!document.body.classList.contains('ib-printing-recovery-key'), 'the page is visible again');
    check(!button('Continue')?.disabled, 'printing counts as keeping the key');
  } finally {
    window.open = realOpen;
    window.print = realPrint;
    await unmount();
  }
});

domTest('Save to a File… still saves the key as a text file through the desktop bridge', async () => {
  const saved: Array<{ defaultName: string; text: string }> = [];
  const w = window as unknown as { bookkeeper?: unknown };
  const before = w.bookkeeper;
  w.bookkeeper = {
    saveBytes: async (o: { defaultName: string; data: ArrayBuffer }) => {
      saved.push({ defaultName: o.defaultName, text: new TextDecoder().decode(o.data) });
      return 'C:\\keys\\key.txt';
    },
  };
  try {
    await mount(<RecoveryKeyPanel recoveryKey={KEY} companyName="Copper Kettle" onDone={() => undefined} />);
    await click(button(/Save to a File/), 'Save to a File…');
    await settle(50);
    equal(saved.length, 1, 'saved once');
    equal(saved[0].defaultName, 'Copper Kettle - recovery key.txt', 'file name');
    check(saved[0].text.includes(KEY), 'the file holds the key');
    check(!button('Continue')?.disabled, 'saving counts as keeping the key');
    check($(`#${RECOVERY_PRINT_ID}`) === null, 'saving prints nothing');
  } finally {
    w.bookkeeper = before;
    await unmount();
  }
});

void runDomTests();
