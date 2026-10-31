// QuickBooks keys in fields and on forms, pressed as a keyboard would (test/keyboardDom.test.ts):
// date keys on every date field, one Tab stop per date, Ctrl+Z after a QuickBooks key, + / - on
// form numbers, Esc on a changed form asks QuickBooks' "record your changes?", Enter records,
// Ctrl+Alt+Y / Ctrl+Alt+V copy and paste a line, and QuickBooks' Tab order on transaction forms.
import * as React from 'react';
import { domTest, mount, press, typeText, equal, check, until, runDomTests, $, $$, button, focusedLabel, settle } from './kit';
import KeyboardBase from '@/components/KeyboardBase';
import FormShortcuts from '@/components/FormShortcuts';
import LeaveGuard from '@/components/LeaveGuard';
import { DateInput, DocNumberInput, Input, Modal, Button } from '@/components/ui';
import { setDateKeyToday, useGridKeys } from '@/lib/shortcuts';

const val = (label: string) => $<HTMLInputElement>(`[aria-label="${label}"]`)!.value;
const focusOn = async (label: string) => {
  const el = $<HTMLElement>(`[aria-label="${label}"]`) ?? $<HTMLElement>(`#${label}`);
  check(el, `no field ${label}`);
  el.focus();
  await settle();
};

// ---------------------------------------------------------------------------
// Date fields
// ---------------------------------------------------------------------------

domTest('a date field is one Tab stop (not month, day, year and the calendar button)', async () => {
  await mount(
    <div>
      <KeyboardBase />
      <input aria-label="Before" />
      <input type="date" aria-label="Plain date" defaultValue="2026-03-15" />
      <DateInput aria-label="Kit date" defaultValue="2026-03-15" />
      <input aria-label="After" />
    </div>,
  );
  await focusOn('Before');
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    await press('Tab');
    seen.push(focusedLabel());
  }
  equal(seen.join(' > '), 'Plain date > Kit date > After', 'Tab');
  await press('Tab', { shift: true });
  await press('Tab', { shift: true });
  equal(focusedLabel(), 'Plain date', 'Shift+Tab goes back one field at a time');
});

domTest('every QuickBooks date key works in a plain date field and in the kit date field', async () => {
  setDateKeyToday(() => '2026-03-15');
  try {
    await mount(
      <div>
        <KeyboardBase />
        <input type="date" aria-label="Plain date" defaultValue="2026-01-02" />
        <DateInput aria-label="Kit date" defaultValue="2026-01-02" />
      </div>,
    );
    for (const label of ['Plain date', 'Kit date']) {
      await focusOn(label);
      const steps: [string, string][] = [
        ['t', '2026-03-15'],
        ['+', '2026-03-16'],
        ['-', '2026-03-15'],
        ['k', '2026-03-21'],
        ['w', '2026-03-15'],
        ['h', '2026-03-31'],
        ['m', '2026-03-01'],
        [']', '2026-03-08'],
        ['[', '2026-03-01'],
        ["'", '2026-04-01'],
        [';', '2026-03-01'],
        ['r', '2026-12-31'],
        ['y', '2026-01-01'],
      ];
      for (const [key, want] of steps) {
        await press(key);
        equal(val(label), want, `${label}: ${key}`);
      }
    }
  } finally {
    setDateKeyToday(null);
  }
});

domTest('T in an empty date field is the company\'s today, not the computer\'s', async () => {
  setDateKeyToday(() => '2031-07-04');
  try {
    await mount(
      <div>
        <KeyboardBase />
        <input type="date" aria-label="Plain date" />
      </div>,
    );
    await focusOn('Plain date');
    await press('t');
    equal(val('Plain date'), '2031-07-04', 'T');
  } finally {
    setDateKeyToday(null);
  }
});

domTest('Ctrl+Z undoes a date key (a date field has no undo of its own)', async () => {
  await mount(
    <div>
      <KeyboardBase />
      <input type="date" aria-label="Plain date" defaultValue="2026-03-15" />
    </div>,
  );
  await focusOn('Plain date');
  await press('h');
  await press('+');
  equal(val('Plain date'), '2026-04-01', 'after H and +');
  await press('z', { ctrl: true });
  equal(val('Plain date'), '2026-03-31', 'Ctrl+Z once');
  await press('z', { ctrl: true });
  equal(val('Plain date'), '2026-03-15', 'Ctrl+Z twice');
});

domTest('Alt+Down opens the calendar of any date field', async () => {
  const opened: string[] = [];
  const proto = HTMLInputElement.prototype as unknown as { showPicker?: () => void };
  const real = proto.showPicker;
  proto.showPicker = function (this: HTMLInputElement) {
    opened.push(this.getAttribute('aria-label') ?? '');
  };
  try {
    await mount(
      <div>
        <KeyboardBase />
        <input type="date" aria-label="Plain date" defaultValue="2026-03-15" />
        <DateInput aria-label="Kit date" defaultValue="2026-03-15" />
      </div>,
    );
    await focusOn('Plain date');
    await press('ArrowDown', { alt: true });
    await focusOn('Kit date');
    await press('ArrowDown', { alt: true });
    equal(opened.join(','), 'Plain date,Kit date', 'calendars opened');
  } finally {
    proto.showPicker = real;
  }
});

// ---------------------------------------------------------------------------
// Form numbers
// ---------------------------------------------------------------------------

domTest('+ / - step a check or form number; - after letters still types', async () => {
  await mount(
    <div>
      <KeyboardBase />
      <DocNumberInput aria-label="Invoice #" defaultValue="INV-0099" />
      <DocNumberInput aria-label="Check No." defaultValue="" />
    </div>,
  );
  await focusOn('Invoice #');
  await press('+');
  equal(val('Invoice #'), 'INV-0100', '+');
  await press('-');
  await press('-');
  equal(val('Invoice #'), 'INV-0098', '- -');
  await press('z', { ctrl: true });
  equal(val('Invoice #'), 'INV-0099', 'Ctrl+Z undoes the last step');
  await focusOn('Check No.');
  await typeText('CHK-');
  equal(val('Check No.'), 'CHK-', '- after letters types');
  await typeText('1001');
  await press('+');
  equal(val('Check No.'), 'CHK-1002', '+ after the digits steps');
});

// ---------------------------------------------------------------------------
// Esc on a changed form: QuickBooks' "Do you want to record your changes?"
// ---------------------------------------------------------------------------

function DialogForm({ onSave }: { onSave: (memo: string) => void }) {
  const [open, setOpen] = React.useState(true);
  const [memo, setMemo] = React.useState('');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMemo('');
          setOpen(true);
        }}
      >
        Open form
      </button>
      <span data-state>{open ? 'open' : 'closed'}</span>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create Invoices"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onSave(memo);
                setOpen(false);
              }}
            >
              Save &amp; Close
            </Button>
          </>
        }
      >
        <Input aria-label="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </Modal>
    </>
  );
}

const state = () => $('[data-state]')?.textContent;
const prompt = () => $$('[role="dialog"] h2').find((h) => /Record your changes/.test(h.textContent ?? '')) ?? null;

domTest('Esc on an unchanged form closes it at once', async () => {
  const saved: string[] = [];
  await mount(
    <>
      <KeyboardBase />
      <FormShortcuts />
      <DialogForm onSave={(m) => saved.push(m)} />
    </>,
  );
  await focusOn('Memo');
  await press('Escape');
  equal(state(), 'closed', 'closed');
  check(!prompt(), 'no question');
});

domTest('Esc on a changed form asks; No closes without saving, Yes records, Cancel stays', async () => {
  const saved: string[] = [];
  await mount(
    <>
      <KeyboardBase />
      <FormShortcuts />
      <DialogForm onSave={(m) => saved.push(m)} />
    </>,
  );
  await focusOn('Memo');
  await typeText('Rush job');
  await press('Escape');
  await until(prompt, 'the record-your-changes question');
  equal(state(), 'open', 'the form stays open while asking');
  // Cancel (Esc on the question): back to the form, nothing lost.
  await press('Escape');
  await until(() => !prompt(), 'the question closes');
  equal(state(), 'open', 'Cancel keeps the form');
  equal(val('Memo'), 'Rush job', 'typed work kept');
  // No: closes without recording.
  await press('Escape');
  await until(prompt, 'asked again');
  await press('n');
  await until(() => state() === 'closed', 'No closes the form');
  equal(saved.length, 0, 'No records nothing');
  // Yes: records.
  button('Open form')!.click();
  await settle(80);
  await focusOn('Memo');
  await typeText('Second');
  await press('Escape');
  await until(prompt, 'asked on the reopened form');
  await press('y');
  await until(() => saved.length === 1, 'Yes records the form');
  equal(saved[0], 'Second', 'what was recorded');
});

domTest('Enter in a form field records it (Save & Close)', async () => {
  const saved: string[] = [];
  await mount(
    <>
      <KeyboardBase />
      <FormShortcuts />
      <DialogForm onSave={(m) => saved.push(m)} />
    </>,
  );
  await focusOn('Memo');
  await typeText('By Enter');
  await press('Enter');
  await until(() => saved.length === 1, 'Enter records');
  equal(saved[0], 'By Enter', 'recorded memo');
});

domTest('Esc on a changed page form (Write Checks) asks before its Cancel', async () => {
  const pressed: string[] = [];
  await mount(
    <main>
      <LeaveGuard />
      <KeyboardBase />
      <FormShortcuts />
      <div data-shortcut-scope>
        <h2>Write Checks</h2>
        <Input aria-label="Pay to the Order of" />
        <Button variant="secondary" onClick={() => pressed.push('cancel')}>
          Cancel
        </Button>
        <Button onClick={() => pressed.push('save')}>Save &amp; Close</Button>
      </div>
    </main>,
  );
  await focusOn('Pay to the Order of');
  await typeText('Acme');
  await press('Escape');
  await until(prompt, 'the question on a page form');
  check(/Write Checks/.test($$('[role="dialog"]').pop()?.textContent ?? ''), 'it names the form');
  await press('n');
  await until(() => pressed.includes('cancel'), 'No presses Cancel');
  equal(pressed.join(','), 'cancel', 'nothing saved');
});

// ---------------------------------------------------------------------------
// Ctrl+Alt+Y / Ctrl+Alt+V: copy and paste a transaction line
// ---------------------------------------------------------------------------

function Lines() {
  const [rows, setRows] = React.useState([
    { item: 'Widget', qty: '2' },
    { item: '', qty: '' },
  ]);
  const grid = useGridKeys({
    addRow: () => setRows((r) => [...r, { item: '', qty: '' }]),
    removeRow: (i) => setRows((r) => r.filter((_, k) => k !== i)),
    insertRow: (i) => setRows((r) => [...r.slice(0, i), { item: '', qty: '' }, ...r.slice(i)]),
  });
  const set = (i: number, k: 'item' | 'qty', v: string) => setRows((r) => r.map((row, j) => (j === i ? { ...row, [k]: v } : row)));
  return (
    <div onKeyDown={grid.onKeyDown}>
      {rows.map((row, i) => (
        <div key={i} data-grid-row>
          <input aria-label={`Item ${i + 1}`} value={row.item} onChange={(e) => set(i, 'item', e.target.value)} />
          <input aria-label={`Qty ${i + 1}`} value={row.qty} onChange={(e) => set(i, 'qty', e.target.value)} />
        </div>
      ))}
    </div>
  );
}

domTest('Ctrl+Alt+Y copies a line; Ctrl+Alt+V pastes it into a blank line, or above a filled one', async () => {
  await mount(<Lines />);
  await focusOn('Item 1');
  await press('y', { ctrl: true, alt: true });
  await focusOn('Item 2');
  await press('v', { ctrl: true, alt: true });
  await until(() => val('Item 2') === 'Widget' && val('Qty 2') === '2', 'pasted into the blank line');
  // On a filled line: a new line above it gets the copy.
  await focusOn('Qty 1');
  await press('v', { ctrl: true, alt: true });
  await until(() => $$('[data-grid-row]').length === 3, 'a line inserted');
  await until(() => val('Item 1') === 'Widget' && val('Qty 1') === '2' && val('Item 2') === 'Widget', 'pasted above');
});

// ---------------------------------------------------------------------------
// QuickBooks' Tab order on a transaction form
// ---------------------------------------------------------------------------

function InvoiceLike() {
  return (
    <>
      <KeyboardBase />
      <Modal
        open
        onClose={() => {}}
        title="Create Invoices"
        footer={
          <>
            <Button variant="secondary">Memorize</Button>
            <Button variant="secondary">Cancel</Button>
            <Button>Create Invoice</Button>
          </>
        }
      >
        <div data-qb-tab-order="">
          <Button variant="secondary">Previous</Button>
          <label htmlFor="c">Customer</label>
          <select id="c">
            <option>Acme</option>
          </select>
          <label htmlFor="n">Invoice #</label>
          <DocNumberInput id="n" defaultValue="1001" />
          <label htmlFor="d">Invoice Date</label>
          <DateInput id="d" defaultValue="2026-03-15" />
          <label htmlFor="due">Due Date</label>
          <DateInput id="due" defaultValue="2026-04-15" />
          <label htmlFor="po">P.O. No.</label>
          <input id="po" />
          <label htmlFor="cl">
            Class <span>(optional)</span>
          </label>
          <select id="cl">
            <option>East</option>
          </select>
          <div data-grid-row>
            <input aria-label="Item" />
            <input aria-label="Amount" />
          </div>
          <label htmlFor="memo">Memo</label>
          <input id="memo" />
          <label htmlFor="disc">Discount</label>
          <input id="disc" />
        </div>
      </Modal>
    </>
  );
}

const tabLabel = () => {
  const el = document.activeElement as HTMLElement | null;
  return el?.id || el?.getAttribute('aria-label') || el?.textContent?.trim() || '(none)';
};

domTest('Tab follows QuickBooks: name, class, date, number, the rest, lines, memo, Save', async () => {
  await mount(<InvoiceLike />);
  await focusOn('c');
  const seen = [tabLabel()];
  for (let i = 0; i < 13; i++) {
    await press('Tab');
    seen.push(tabLabel());
  }
  equal(
    seen.join(' > '),
    'c > cl > d > n > due > po > Item > Amount > disc > memo > Create Invoice > Memorize > Cancel > Close',
    'Tab order',
  );
  await press('Tab');
  equal(tabLabel(), 'Previous', 'from the close button on to the toolbar');
  await press('Tab');
  equal(tabLabel(), 'c', 'and round to the name');
  const back = [tabLabel()];
  for (let i = 0; i < 4; i++) {
    await press('Tab', { shift: true });
    back.push(tabLabel());
  }
  equal(back.join(' < '), 'c < Previous < Close < Cancel < Memorize', 'Shift+Tab goes the same way back, wrapping in the dialog');
});

domTest('a form can give its own QuickBooks header order (Write Checks: account, number, date, payee)', async () => {
  await mount(
    <main>
      <KeyboardBase />
      <div data-shortcut-scope data-qb-tab-order="acct no date payee">
        <label htmlFor="payee">Pay to the Order of</label>
        <input id="payee" />
        <label htmlFor="acct">Bank Account</label>
        <select id="acct">
          <option>Checking</option>
        </select>
        <label htmlFor="date">Date</label>
        <DateInput id="date" defaultValue="2026-03-15" />
        <label htmlFor="no">Check No.</label>
        <DocNumberInput id="no" defaultValue="1001" />
        <label htmlFor="memo">Memo</label>
        <input id="memo" />
        <div data-grid-row>
          <input aria-label="Account" />
        </div>
        <Button>Save &amp; Close</Button>
      </div>
    </main>,
  );
  await focusOn('acct');
  const seen = [tabLabel()];
  for (let i = 0; i < 6; i++) {
    await press('Tab');
    seen.push(tabLabel());
  }
  equal(seen.join(' > '), 'acct > no > date > payee > memo > Account > Save & Close', 'check order');
});

void runDomTests();
