'use client';
/**
 * TypeaheadSelect: a find-as-you-type picker that stores an id, for the account / item / name /
 * class columns of transaction line grids (the QB "type a few letters, Tab" picker). It is a
 * drop-in for a <Select> of records: `value` is the chosen id ('' = none) and `onChange` gets
 * the new id.
 *
 * Keys are those of <Typeahead> (typing filters, Alt+Down / Ctrl+L open, Down / Up move, Enter / Tab take
 * the highlighted entry, Esc closes only the list). While the list is open the field reports
 * aria-expanded="true", so useGridKeys and FormShortcuts leave Enter and the arrows to it; while
 * it is closed, Enter / Down / Up move between lines as before.
 *
 * Leaving the field with typed text keeps an exact match (a full name or an account number),
 * clears the choice when the text was erased, and otherwise puts the chosen entry's label back
 * (rules in resolveTypedChoice, lib/typeahead.ts).
 */
import * as React from 'react';
import { Typeahead, type TypeaheadProps } from '@/components/Typeahead';
import { type TypeaheadChoice, choicesToOptions, labelForId, resolveTypedChoice } from '@/lib/typeahead';

export interface TypeaheadSelectProps extends Omit<TypeaheadProps, 'value' | 'onChange' | 'options' | 'onPick' | 'allowFreeText'> {
  /** Chosen id ('' = none). */
  value: string;
  onChange: (id: string) => void;
  choices: TypeaheadChoice[];
}

export const TypeaheadSelect = React.forwardRef<HTMLInputElement, TypeaheadSelectProps>(function TypeaheadSelect(
  { value, onChange, choices, onFocus, onBlur, ...rest },
  ref,
) {
  const options = React.useMemo(() => choicesToOptions(choices), [choices]);
  const label = React.useMemo(() => labelForId(choices, value), [choices, value]);
  const [text, setText] = React.useState(label);
  // True once the user has typed since focusing; only then does leaving the field change the id.
  const dirty = React.useRef(false);
  const focused = React.useRef(false);

  // Follow outside changes (another line picked, the form reset) while the user isn't typing.
  React.useEffect(() => {
    if (!focused.current || !dirty.current) setText(label);
  }, [label]);

  return (
    <Typeahead
      {...rest}
      ref={ref}
      value={text}
      options={options}
      onChange={(t) => {
        dirty.current = true;
        setText(t);
      }}
      onPick={(o) => {
        dirty.current = false;
        if (o.id !== undefined) {
          setText(o.value);
          if (o.id !== value) onChange(o.id);
        }
      }}
      onFocus={(e) => {
        focused.current = true;
        dirty.current = false;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        if (dirty.current) {
          dirty.current = false;
          const id = resolveTypedChoice(choices, text, value);
          setText(labelForId(choices, id));
          if (id !== value) onChange(id);
        } else {
          setText(label);
        }
        onBlur?.(e);
      }}
    />
  );
});

export default TypeaheadSelect;
