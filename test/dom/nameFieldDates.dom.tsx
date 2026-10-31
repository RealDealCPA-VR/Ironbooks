// The QuickBooks-converts gaps closed in this round, pressed as a keyboard would
// (test/keyboardDom.test.ts): a date typed in part fills in the year on Tab, and a form's name
// field finds as you type and offers Quick Add for a name that is not on the list.
import * as React from 'react';
import { domTest, mount, press, typeText, equal, check, until, runDomTests, $, button, click, settle, stubFetch, fetchLog } from './kit';
import KeyboardBase from '@/components/KeyboardBase';
import { DateInput } from '@/components/ui';
import { NameField } from '@/components/NameField';
import { setDateKeyToday } from '@/lib/shortcuts';

domTest('a date typed as 10/24 then Tab fills in the current year', async () => {
  setDateKeyToday(() => '2026-10-31');
  try {
    await mount(
      <div>
        <KeyboardBase />
        <DateInput aria-label="Date" defaultValue="" />
        <input aria-label="After" />
      </div>,
    );
    const date = $<HTMLInputElement>('[aria-label="Date"]')!;
    date.focus();
    await settle();
    await typeText('10/24');
    await press('Tab');
    equal(date.value, '2026-10-24', 'month and day, this year');
    equal(document.activeElement?.getAttribute('aria-label'), 'After', 'Tab still moves on');
  } finally {
    setDateKeyToday(null);
  }
});

function Picker({ onPicked }: { onPicked: (id: string) => void }) {
  const [list, setList] = React.useState([
    { id: 'c1', label: 'Acme Supply' },
    { id: 'c2', label: 'Baker Farms' },
  ]);
  const [id, setId] = React.useState('');
  return (
    <div>
      <NameField
        aria-label="Customer"
        nameType="customer"
        value={id}
        choices={list}
        onChange={(v) => {
          setId(v);
          onPicked(v);
        }}
        onAdded={(n) => setList((prev) => [...prev, { id: n.id, label: n.label }])}
      />
      <input aria-label="Next" />
    </div>
  );
}

domTest('a name field finds as you type: "bak" then Tab picks Baker Farms', async () => {
  let picked = '';
  await mount(<Picker onPicked={(v) => (picked = v)} />);
  $<HTMLInputElement>('[aria-label="Customer"]')!.focus();
  await settle();
  await typeText('bak');
  await press('Tab');
  equal(picked, 'c2', 'Baker Farms chosen');
  equal($<HTMLInputElement>('[aria-label="Customer"]')!.value, 'Baker Farms', 'field shows the name');
});

domTest('a name not on the list opens Quick Add and the new name is chosen', async () => {
  stubFetch({ 'POST /api/customers': { id: 'c9', displayName: 'Zephyr Co' } });
  let picked = '';
  await mount(<Picker onPicked={(v) => (picked = v)} />);
  $<HTMLInputElement>('[aria-label="Customer"]')!.focus();
  await settle();
  await typeText('Zephyr Co');
  await press('Tab');
  const add = await until(() => button(/Add Customer/), 'Quick Add box');
  check(!button(/Just this once/), 'an invoice customer has no one-time option');
  await click(add, 'Add Customer');
  await until(() => picked === 'c9' || null, 'new customer chosen');
  const post = fetchLog().find((c) => c.method === 'POST');
  equal((post?.body as { displayName?: string })?.displayName, 'Zephyr Co', 'saved with the typed name');
});

void runDomTests();
