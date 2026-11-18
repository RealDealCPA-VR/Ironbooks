'use client';
/**
 * AccountSelect: the Account column of a transaction line grid (Write Checks, Enter Bills, Make
 * Deposits, Make General Journal Entries), with QuickBooks' "Account Not Found — Set Up".
 *
 * It is a <TypeaheadSelect> of accounts. Typing a name that is not in the chart and leaving the
 * field (Tab or click away) opens the Add Account dialog with that name filled in; the account it
 * creates goes into the Chart of Accounts for good and onto this line. Cancel puts the line's
 * account back as it was.
 *
 * The page keeps its own account list: `onAccountCreated` adds the new account to it, so every
 * other picker on the page offers it too. Until the page has it, this picker shows it itself.
 *
 * The dialog is rendered into <body> and its submit event stops here: the picker sits inside the
 * transaction's own <form>, and React events bubble through a portal to it — creating the account
 * must not also save the check. Key events are left alone: Enter-to-save (FormShortcuts, on the
 * window) presses the topmost dialog's button, so Enter in the dialog creates the account.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { TypeaheadSelect, type TypeaheadSelectProps } from '@/components/TypeaheadSelect';
import { AddAccountModal, type Account } from '@/components/accounts/AccountForm';
import type { QbAccountType } from '@/lib/accountTypes';
import type { TypeaheadChoice } from '@/lib/typeahead';

export interface AccountSelectProps extends Omit<TypeaheadSelectProps, 'onUnknown'> {
  /** The page's accounts (as GET /api/accounts returns them): parent choices in the dialog. */
  accounts: ReadonlyArray<{ id: string; code: string; name: string }>;
  /** The account type the dialog starts on (an expense line: 'expense'; a deposit line: 'income'). */
  newAccountType?: QbAccountType;
  /** Called with the account just created (as POST /api/accounts returns it). */
  onAccountCreated: (account: Account) => void;
}

/** "6000 – Rent", or the name alone when the account has no number. */
const choiceFor = (a: Account): TypeaheadChoice => ({
  id: a.id,
  label: a.code ? `${a.code} – ${a.name}` : a.name,
  terms: [a.code, a.name].filter(Boolean),
});

export const AccountSelect = React.forwardRef<HTMLInputElement, AccountSelectProps>(function AccountSelect(
  { accounts, newAccountType = 'expense', onAccountCreated, choices, onChange, ...rest },
  ref,
) {
  const [newName, setNewName] = React.useState<string | null>(null);
  // Accounts made here that the page's list doesn't have yet.
  const [made, setMade] = React.useState<Account[]>([]);
  const allChoices = React.useMemo(() => {
    const extra = made.filter((a) => !choices.some((c) => c.id === a.id)).map(choiceFor);
    return extra.length ? [...choices, ...extra] : choices;
  }, [choices, made]);

  return (
    <>
      <TypeaheadSelect
        {...rest}
        ref={ref}
        choices={allChoices}
        onChange={onChange}
        onUnknown={(text) => setNewName(text)}
      />
      {newName !== null &&
        createPortal(
          <div onSubmit={(e) => e.stopPropagation()}>
            <AddAccountModal
              open
              initial={{ name: newName, qbType: newAccountType }}
              accounts={accounts as unknown as Account[]}
              onClose={() => setNewName(null)}
              onCreated={(a) => {
                setMade((prev) => [...prev, a]);
                onAccountCreated(a);
                onChange(a.id);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
});

export default AccountSelect;
