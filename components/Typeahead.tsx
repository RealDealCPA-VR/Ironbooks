'use client';
/**
 * Typeahead: a free-text field with a find-as-you-type pick list, fully keyboard operable
 * (ARIA 1.2 combobox pattern):
 *
 *   typing          filters the list (matching rules in lib/typeahead.ts) and opens it
 *   Alt+Down        opens the list without typing
 *   Down / Up       move through the open list (Home / End jump)
 *   Enter / Tab     take the highlighted entry (Tab then moves on as usual)
 *   Esc             closes the list (and only the list — not the dialog or form around it)
 *
 * While the list is closed, Down / Up / Enter are left alone so line grids keep moving between
 * lines. The list is drawn with position: fixed so it is never clipped by scrolling tables.
 */
import * as React from 'react';
import { Input } from '@/components/ui';
import { type TypeaheadOption, filterTypeahead, moveHighlight } from '@/lib/typeahead';

export interface TypeaheadProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onSelect' | 'type'> {
  value: string;
  onChange: (value: string) => void;
  options: TypeaheadOption[];
  /** Called after an option is chosen from the list. */
  onPick?: (option: TypeaheadOption) => void;
  maxResults?: number;
}

export const Typeahead = React.forwardRef<HTMLInputElement, TypeaheadProps>(function Typeahead(
  { value, onChange, options, onPick, maxResults = 8, onKeyDown, onBlur, onFocus, className, ...rest },
  ref,
) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);
  const listId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [rect, setRect] = React.useState<{ left: number; top: number; width: number } | null>(null);

  const results = React.useMemo(() => (open ? filterTypeahead(options, value, maxResults) : []), [open, options, value, maxResults]);
  const expanded = open && results.length > 0;

  const place = React.useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 240) });
  }, []);

  React.useEffect(() => {
    if (!expanded) return;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [expanded, place]);

  function choose(o: TypeaheadOption) {
    onChange(o.value);
    onPick?.(o);
    setOpen(false);
    setActive(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (!expanded) {
      if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        setOpen(true);
        setActive(0);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End':
        if (e.key === 'ArrowDown' && e.altKey) return;
        e.preventDefault();
        setActive((i) => moveHighlight(i, results.length, e.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'));
        return;
      case 'Enter':
        if (active >= 0 && results[active]) {
          e.preventDefault();
          choose(results[active]);
        } else setOpen(false);
        return;
      case 'Tab':
        if (active >= 0 && results[active]) choose(results[active]);
        else setOpen(false);
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setActive(-1);
        return;
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <>
      <Input
        {...rest}
        ref={inputRef}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        className={className}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(e.target.value.trim() ? 0 : -1);
        }}
        onFocus={onFocus}
        onBlur={(e) => {
          setOpen(false);
          setActive(-1);
          onBlur?.(e);
        }}
        onKeyDown={handleKeyDown}
      />
      {expanded && rect && (
        <ul
          id={listId}
          role="listbox"
          className="fixed z-[60] max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
          style={{ left: rect.left, top: rect.top, width: rect.width }}
        >
          {results.map((o, i) => (
            <li
              key={`${o.value}-${i}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm ${
                i === active ? 'bg-electric/10 text-navy' : 'text-navy/80 hover:bg-slate-50'
              }`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the field
                choose(o);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="truncate">{o.label ?? o.value}</span>
              {o.hint && <span className="shrink-0 text-xs text-navy/40">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
});

export default Typeahead;
