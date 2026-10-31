'use client';
/**
 * NameField: the name field at the top of a transaction form (Customer:Job on an invoice, Vendor
 * on a bill). Type a few letters and Tab, as in QuickBooks; leaving the field with a name that
 * is not on the list opens Quick Add (components/NewNameModal.tsx), and the new name is chosen
 * on the form so the user carries on where they were.
 */
import * as React from 'react';
import { TypeaheadSelect, type TypeaheadSelectProps } from '@/components/TypeaheadSelect';
import { NewNameModal, type CreatedName, type NameType } from '@/components/NewNameModal';

export interface NameFieldProps extends Omit<TypeaheadSelectProps, 'onUnknown'> {
  /** The list a new name goes on (and the only one offered). */
  nameType: NameType;
  /**
   * A name was added: put it on the form's list. Return the value the field should hold
   * (default created.id); onChange(that value) follows.
   */
  onAdded: (created: CreatedName) => string | void;
  /** Also offer "Just this once" (Write Checks: a one-time payee); gets the typed text. */
  onUseOnce?: (text: string) => void;
  /** Lists the Quick Add box offers (default: nameType only). */
  types?: NameType[];
}

export const NameField = React.forwardRef<HTMLInputElement, NameFieldProps>(function NameField(
  { nameType, onAdded, onUseOnce, types, onChange, ...rest },
  ref,
) {
  const [asking, setAsking] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  const close = () => {
    setAsking(null);
    // Back to the name field, as QuickBooks does after Quick Add / Cancel.
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <>
      <TypeaheadSelect {...rest} ref={inputRef} onChange={onChange} onUnknown={(text) => setAsking(text)} />
      <NewNameModal
        open={asking !== null}
        name={asking ?? ''}
        suggestedType={nameType}
        types={types ?? [nameType]}
        onClose={close}
        onCreated={(n: CreatedName) => {
          const chosen = onAdded(n);
          onChange(typeof chosen === 'string' ? chosen : n.id);
          close();
        }}
        onUseOnce={
          onUseOnce
            ? () => {
                const text = asking ?? '';
                setAsking(null);
                onUseOnce(text);
              }
            : undefined
        }
      />
    </>
  );
});

export default NameField;
