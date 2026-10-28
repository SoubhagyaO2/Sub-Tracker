import { useId, useMemo, useState } from 'react';
import { searchServices, type ServiceTemplate } from '@subcycle/shared';
import { CATEGORY_LABEL } from '../lib/labels';
import { ServiceIcon } from './ui/display';
import { TextField } from './ui/Field';

interface Props {
  value: string;
  onChange: (text: string) => void;
  /** The user chose a suggestion. */
  onPick: (service: ServiceTemplate) => void;
  error?: string;
}

/**
 * The "Service name" field with type-ahead suggestions from the built-in catalogue. WAI-ARIA combobox (list autocomplete):
 * focus stays in the input; Arrow keys move through the options; Enter picks the highlighted one (and otherwise submits the form
 * as usual); Escape closes; Tab leaves without picking anything. Suggestions only fill in what the catalogue knows (category,
 * website, icon), never a price or a date.
 */
export function ServiceNameField({ value, onChange, onPick, error }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const results = useMemo(() => (open ? searchServices(value, 6) : []), [open, value]);
  const expanded = open && results.length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const pick = (s: ServiceTemplate) => {
    setOpen(false);
    setActive(-1);
    onPick(s);
  };

  return (
    <div className="relative">
      <TextField
        name="name"
        label="Service name"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => value.trim() && setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!expanded && value.trim()) {
              setOpen(true);
              return e.preventDefault();
            }
            if (!results.length) return;
            e.preventDefault();
            setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % results.length : (i <= 0 ? results.length : i) - 1));
          } else if (e.key === 'Enter' && expanded && active >= 0) {
            e.preventDefault(); // choosing a suggestion must not submit the form
            pick(results[active]!);
          } else if (e.key === 'Escape' && expanded) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setActive(-1);
          }
        }}
        error={error}
        maxLength={80}
        autoComplete="off"
        required
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
      />
      <div role="status" className="sr-only">
        {expanded ? `${results.length} ${results.length === 1 ? 'suggestion' : 'suggestions'} available. Use the arrow keys, then Enter.` : ''}
      </div>
      {expanded ? (
        <ul id={listId} role="listbox" aria-label="Suggested services" className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-control border border-strong bg-raised py-1 shadow-pop">
          {results.map((s, i) => (
            <li
              key={s.name}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
              onClick={() => pick(s)}
              onMouseMove={() => setActive(i)}
              className={`flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm ${i === active ? 'bg-accent-soft text-accent-text' : 'text-fg'}`}
            >
              <ServiceIcon subscription={{ name: s.name, category: s.category, icon: s.logo ? { kind: 'glyph', value: s.logo } : null }} />
              <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
              <span className={`shrink-0 text-xs ${i === active ? "text-accent-text" : "text-muted"}`}>{CATEGORY_LABEL[s.category]}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
