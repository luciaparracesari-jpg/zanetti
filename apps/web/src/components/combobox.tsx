'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronsUpDown, X } from 'lucide-react';
import { get } from '@/lib/api';
import { cx } from './ui';

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Selector con búsqueda en el servidor (productos, SKU). `fetchPath` recibe ?q=.
 * Muestra la etiqueta actual aunque no esté en la página de resultados.
 */
export function AsyncCombobox<T>({
  value,
  onChange,
  fetchPath,
  map,
  placeholder = 'Buscar…',
  initialLabel,
  invalid,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null, option: Option | null) => void;
  fetchPath: string;
  map: (row: T) => Option;
  placeholder?: string;
  initialLabel?: string | null;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [label, setLabel] = useState(initialLabel ?? '');
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => setLabel(initialLabel ?? ''), [initialLabel]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const sep = fetchPath.includes('?') ? '&' : '?';
  const res = useQuery({
    queryKey: [fetchPath, 'combo', debounced],
    queryFn: () => get<T[]>(`${fetchPath}${sep}q=${encodeURIComponent(debounced)}`),
    enabled: open,
    staleTime: 30_000,
  });
  const options = (res.data ?? []).map(map);

  function pick(o: Option) {
    onChange(o.value, o);
    setLabel(o.label);
    setOpen(false);
    setQ('');
  }

  return (
    <div ref={boxRef} className="relative">
      <div
        className={cx(
          'flex h-8 items-center rounded border bg-panel text-sm',
          invalid ? 'border-bad' : 'border-line-strong',
          open && 'border-brand ring-1 ring-brand',
          disabled && 'bg-page',
        )}
      >
        <input
          className="h-full min-w-0 flex-1 bg-transparent px-2 outline-none placeholder:text-ink-faint"
          placeholder={value ? label : placeholder}
          value={open ? q : value ? label : ''}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, options.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
            if (e.key === 'Enter' && open && options[cursor]) { e.preventDefault(); pick(options[cursor]); }
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        {value && !disabled ? (
          <button type="button" className="px-1.5 text-ink-faint hover:text-ink" onClick={() => { onChange(null, null); setLabel(''); }} aria-label="Quitar">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <ChevronsUpDown className="mr-2 h-3.5 w-3.5 text-ink-faint" />
        )}
      </div>
      {open && (
        <div className="absolute z-40 mt-1 max-h-64 w-full overflow-y-auto rounded border border-line bg-panel py-1 shadow-lg">
          {res.isLoading && <div className="px-3 py-1.5 text-sm text-ink-soft">Buscando…</div>}
          {!res.isLoading && options.length === 0 && <div className="px-3 py-1.5 text-sm text-ink-soft">Sin resultados.</div>}
          {options.map((o, i) => (
            <button
              type="button"
              key={o.value}
              onClick={() => pick(o)}
              className={cx('flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm', i === cursor ? 'bg-brand-soft' : 'hover:bg-page', o.value === value && 'font-semibold')}
            >
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="truncate text-xs text-ink-soft">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
