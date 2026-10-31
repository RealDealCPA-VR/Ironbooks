'use client';
/**
 * Receive Payments — "Credits" for one invoice (or General Journal charge), like QuickBooks'
 * Discount and Credits window (salesar C4): every available credit is listed with what it still
 * has after the other invoices of this payment, and the amount to use on THIS invoice can be typed
 * (or filled with "Use available credits"). One credit can so be split over several invoices; the
 * server checks the parts together against what the credit has left.
 */
import { AmountInput, Button, Modal, Table, Td, Th, Tr } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { moneyDec } from '@/lib/paymentApply';
import {
  type CreditUse,
  type SplitCredit,
  creditLeftFor,
  creditUsed,
  fillCreditsFor,
  setCreditPart,
} from './creditSplit';

export interface DialogCredit extends SplitCredit {
  ref: string;
  date: string;
}

export function CreditsDialog({
  open,
  onClose,
  title,
  target,
  balanceDue,
  discount,
  credits,
  use,
  onChange,
  fmt,
}: {
  open: boolean;
  onClose: () => void;
  /** e.g. "Invoice #1001". */
  title: string;
  /** Invoice id, or `je:<line id>`. */
  target: string;
  /** What the invoice owes before this payment. */
  balanceDue: string;
  /** Early-payment discount taken on it in this payment. */
  discount: string;
  /** The credits that can go on this target (in the payment's currency). */
  credits: readonly DialogCredit[];
  use: CreditUse;
  onChange: (next: CreditUse) => void;
  /** Money in the payment's currency. */
  fmt: (v: string) => string;
}) {
  const owes = moneyDec(balanceDue).minus(moneyDec(discount));
  const owesStr = (owes.greaterThan(0) ? owes : moneyDec(0)).toFixed(2);
  const usedHere = credits.reduce((s, c) => s.plus(moneyDec(use[c.id]?.[target])), moneyDec(0));
  const after = owes.minus(usedHere);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Credits — ${title}`}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              let next = use;
              for (const c of credits) next = setCreditPart(next, c.id, target, '');
              onChange(next);
            }}
          >
            Clear
          </Button>
          <Button variant="secondary" onClick={() => onChange(fillCreditsFor(credits, use, target, owesStr))}>
            Use available credits
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="space-y-3">
        <dl className="grid grid-cols-4 gap-3 text-sm">
          <div>
            <dt className="text-navy/60">Balance due</dt>
            <dd className="font-semibold tabular-nums">{fmt(moneyDec(balanceDue).toFixed(2))}</dd>
          </div>
          <div>
            <dt className="text-navy/60">Discount</dt>
            <dd className="font-semibold tabular-nums">{fmt(moneyDec(discount).toFixed(2))}</dd>
          </div>
          <div>
            <dt className="text-navy/60">Credits used here</dt>
            <dd className="font-semibold tabular-nums">{fmt(usedHere.toFixed(2))}</dd>
          </div>
          <div>
            <dt className="text-navy/60">Left to pay</dt>
            <dd className={'font-semibold tabular-nums ' + (after.isNegative() ? 'text-red-600' : '')}>
              {fmt(after.toFixed(2))}
            </dd>
          </div>
        </dl>
        {after.isNegative() && (
          <p role="alert" className="text-xs text-red-600">
            The discount and credits are more than this invoice owes. Lower one of the amounts.
          </p>
        )}
        {credits.length === 0 ? (
          <p className="text-sm italic text-navy/50">This customer has no credits that can be used here.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <Table>
              <thead>
                <tr className="bg-slate-50">
                  <Th>Credit</Th>
                  <Th>Date</Th>
                  <Th numeric>Credit left</Th>
                  <Th numeric>Used on other invoices</Th>
                  <Th numeric>Use on this one</Th>
                </tr>
              </thead>
              <tbody>
                {credits.map((c) => {
                  const left = creditLeftFor(c, use, target);
                  const elsewhere = creditUsed(use, c.id, target);
                  const here = use[c.id]?.[target] ?? '';
                  const over = moneyDec(here).greaterThan(left);
                  return (
                    <Tr key={c.id}>
                      <Td className="font-medium">{c.ref}</Td>
                      <Td>{c.date ? formatDate(c.date) : ''}</Td>
                      <Td numeric>{fmt(moneyDec(c.available).toFixed(2))}</Td>
                      <Td numeric>{elsewhere.greaterThan(0) ? fmt(elsewhere.toFixed(2)) : '—'}</Td>
                      <Td numeric>
                        <AmountInput
                          placeholder="0.00"
                          aria-label={`Use ${c.ref} on ${title}`}
                          aria-invalid={over || undefined}
                          value={here}
                          onChange={(e) => onChange(setCreditPart(use, c.id, target, e.target.value))}
                          className="text-right"
                        />
                        {over && (
                          <span className="mt-1 block text-xs text-red-600">Only {fmt(left.toFixed(2))} of it is left.</span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
        <p className="text-xs text-navy/50">
          A credit can be spread over several invoices: what you use here is taken off what it has left
          for the others.
        </p>
      </div>
    </Modal>
  );
}
