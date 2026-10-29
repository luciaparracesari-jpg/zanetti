'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Download, Search } from 'lucide-react';
import { downloadCsv } from '@/lib/csv';
import { Button, Input, cx } from './ui';

export interface LocalColumn<T> {
  id: string;
  header: ReactNode;
  /** Texto para el encabezado del CSV (si el encabezado no es texto). */
  csvHeader?: string;
  cell: (r: T) => ReactNode;
  /** Valor para ordenar y para el CSV. */
  value?: (r: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** Grupo de encabezado (fila superior). */
  group?: string;
  sticky?: boolean;
}

/**
 * Tabla para resultados ya calculados (reabasto, resúmenes): ordenar, buscar, exportar a CSV y
 * encabezado fijo. Para listas grandes paginadas en el servidor se usa DataTable.
 */
export function LocalTable<T>({
  rows,
  columns,
  rowKey,
  rowClassName,
  search,
  searchPlaceholder = 'Buscar SKU o nombre…',
  csvName,
  toolbar,
  footer,
  maxHeight = '70vh',
  empty = 'Sin renglones.',
  initialSort,
}: {
  rows: T[];
  columns: LocalColumn<T>[];
  rowKey: (r: T) => string;
  rowClassName?: (r: T) => string | undefined;
  search?: (r: T) => string;
  searchPlaceholder?: string;
  csvName?: string;
  toolbar?: ReactNode;
  footer?: ReactNode;
  maxHeight?: string;
  empty?: ReactNode;
  initialSort?: { id: string; dir: 'asc' | 'desc' };
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = needle && search ? rows.filter((r) => search(r).toLowerCase().includes(needle)) : rows;
    const col = sort && columns.find((c) => c.id === sort.id);
    if (col?.value) {
      const v = col.value;
      out = [...out].sort((a, b) => {
        const x = v(a);
        const y = v(b);
        if (x === y) return 0;
        if (x === null || x === undefined || x === '') return 1;
        if (y === null || y === undefined || y === '') return -1;
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es');
        return sort!.dir === 'asc' ? c : -c;
      });
    }
    return out;
  }, [rows, q, sort, columns, search]);

  const groups = columns.some((c) => c.group)
    ? columns.reduce<{ label: string; span: number }[]>((acc, c) => {
        const g = c.group ?? '';
        if (acc.length && acc[acc.length - 1].label === g) acc[acc.length - 1].span++;
        else acc.push({ label: g, span: 1 });
        return acc;
      }, [])
    : null;

  const exportCsv = () =>
    downloadCsv(
      `${csvName}.csv`,
      columns.map((c) => c.csvHeader ?? (typeof c.header === 'string' ? c.header : c.id)),
      shown.map((r) => columns.map((c) => (c.value ? c.value(r) : null))),
    );

  return (
    <div className="rounded border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
        {search && (
          <div className="relative w-64 max-w-full">
            <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} className="pl-7" />
          </div>
        )}
        <span className="text-xs text-ink-faint">{shown.length === rows.length ? `${rows.length} renglones` : `${shown.length} de ${rows.length}`}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {toolbar}
          {csvName && (
            <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={exportCsv}>
              CSV
            </Button>
          )}
        </div>
      </div>
      <div className="scroll-thin overflow-auto" style={{ maxHeight }}>
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10 bg-page text-xs text-ink-soft">
            {groups && (
              <tr>
                {groups.map((g, i) => (
                  <th key={i} colSpan={g.span} className={cx('border-b border-line px-2 py-1 text-center font-semibold', g.label && 'border-x border-line bg-brand-soft/50 text-ink')}>
                    {g.label}
                  </th>
                ))}
              </tr>
            )}
            <tr>
              {columns.map((c) => (
                <th
                  key={c.id}
                  className={cx(
                    'border-b border-line px-2 py-1.5 font-semibold whitespace-nowrap',
                    c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.value && 'cursor-pointer select-none hover:text-ink',
                    c.sticky && 'sticky left-0 z-20 bg-page',
                  )}
                  onClick={() => c.value && setSort((s) => (s?.id === c.id ? (s.dir === 'asc' ? { id: c.id, dir: 'desc' } : null) : { id: c.id, dir: 'asc' }))}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.header}
                    {sort?.id === c.id && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-ink-soft">
                  {empty}
                </td>
              </tr>
            ) : (
              shown.map((r) => (
                <tr key={rowKey(r)} className={cx('hover:bg-brand-soft/30', rowClassName?.(r))}>
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className={cx(
                        'border-b border-line px-2 py-1 align-top',
                        c.align === 'right' ? 'text-right tabular-nums' : c.align === 'center' ? 'text-center' : '',
                        c.sticky && 'sticky left-0 bg-panel',
                        c.className,
                      )}
                    >
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {footer && <tfoot className="sticky bottom-0 bg-page text-sm font-semibold">{footer}</tfoot>}
        </table>
      </div>
    </div>
  );
}
