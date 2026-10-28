'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Rows3,
  Rows4,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { PermissionKey } from '@erp/shared';
import { api, get, post, del, qs, type Paged } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { useSession } from '@/lib/session';
import { useToast } from './toast';
import { Button, Dialog, Empty, ErrorBox, Field, Input, Select, Spinner, cx } from './ui';

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Valor para exportar; si falta, la columna no se exporta. */
  csv?: (row: T) => string | number | null | undefined;
  /** Campo de ordenamiento que acepta la API. */
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  defaultHidden?: boolean;
  className?: string;
}

export interface FilterDef {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  /** Texto de la opción vacía. */
  allLabel?: string;
}

interface SavedFilter {
  id: string;
  name: string;
  filter: Record<string, string>;
  isDefault: boolean;
}

interface Props<T> {
  tableKey: string;
  endpoint: string;
  columns: Column<T>[];
  rowId: (row: T) => string;
  filters?: FilterDef[];
  rowHref?: (row: T) => string;
  onRowClick?: (row: T) => void;
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
  toolbar?: ReactNode;
  exportPerm?: PermissionKey;
  exportName?: string;
  searchPlaceholder?: string;
  /** Parámetros fijos que no se muestran como filtros. */
  fixedParams?: Record<string, string>;
  emptyText?: ReactNode;
  pageSizes?: number[];
  /** Parámetros de la URL que se reenvían a la API aunque no sean filtros de lista (p. ej. fechas). */
  urlParams?: string[];
  /** false oculta la búsqueda y los filtros guardados (tablas cortas sin búsqueda en la API). */
  searchable?: boolean;
}

const PAGE_SIZES = [25, 50, 100, 200];

function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento no disponible */
  }
}

export function DataTable<T>({
  tableKey,
  endpoint,
  columns,
  rowId,
  filters = [],
  rowHref,
  onRowClick,
  bulkActions,
  toolbar,
  exportPerm,
  exportName,
  searchPlaceholder = 'Buscar…',
  fixedParams,
  emptyText = 'No hay registros con estos filtros.',
  pageSizes = PAGE_SIZES,
  urlParams = [],
  searchable = true,
}: Props<T>) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);

  const page = Math.max(1, Number(sp.get('page') ?? 1));
  const pageSize = Number(sp.get('pageSize') ?? 50);
  const sort = sp.get('sort') ?? '';
  const q = sp.get('q') ?? '';
  const filterValues = Object.fromEntries([...filters.map((f) => f.key), ...urlParams].map((k) => [k, sp.get(k) ?? '']));

  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  const [hidden, setHidden] = useState<string[]>(() =>
    readLocal(`erp.cols.${tableKey}`, columns.filter((c) => c.defaultHidden).map((c) => c.id)),
  );
  const [dense, setDense] = useState<boolean>(() => readLocal('erp.dense', true));
  const [selected, setSelected] = useState<Map<string, T>>(new Map());
  const [colMenu, setColMenu] = useState(false);
  const [savedMenu, setSavedMenu] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  const visible = columns.filter((c) => !hidden.includes(c.id));

  const params = { ...fixedParams, q, page, pageSize, sort, ...filterValues };
  const query = useQuery({
    queryKey: [endpoint, params],
    queryFn: () => get<Paged<T>>(endpoint + qs(params)),
    placeholderData: (prev) => prev,
  });

  // Atajo "/" para enfocar la búsqueda.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setSelected(new Map()), [endpoint, q, page, pageSize, sort, JSON.stringify(filterValues)]);

  function setParams(patch: Record<string, string | number | null>, resetPage = true) {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '' || v === undefined) next.delete(k);
      else next.set(k, String(v));
    }
    if (resetPage && !('page' in patch)) next.delete('page');
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  function toggleSort(key: string) {
    const [f, d] = sort.split(':');
    if (f !== key) setParams({ sort: `${key}:asc` });
    else if (d === 'asc') setParams({ sort: `${key}:desc` });
    else setParams({ sort: null });
  }

  const saved = useQuery({
    queryKey: ['saved-filters', tableKey],
    queryFn: () => get<SavedFilter[]>(`/saved-filters${qs({ table: tableKey })}`),
  });
  const saveFilter = useMutation({
    mutationFn: () =>
      post('/saved-filters', {
        tableKey,
        name: saveName,
        filter: Object.fromEntries(Object.entries({ q, sort, ...filterValues }).filter(([, v]) => v)),
      }),
    onSuccess: () => {
      toast.ok('Filtro guardado.');
      setSaveOpen(false);
      setSaveName('');
      qc.invalidateQueries({ queryKey: ['saved-filters', tableKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteFilter = useMutation({
    mutationFn: (id: string) => del(`/saved-filters/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-filters', tableKey] }),
  });
  function applySaved(f: SavedFilter) {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(f.filter)) if (v) next.set(k, String(v));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    setSavedMenu(false);
  }

  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    setExporting(true);
    try {
      const data = await api<Paged<T>>(endpoint + qs({ ...params, page: 1, export: 1 }));
      const cols = visible.filter((c) => c.csv);
      downloadCsv(
        `${exportName ?? tableKey}-${new Date().toISOString().slice(0, 10)}.csv`,
        cols.map((c) => c.header),
        data.items.map((r) => cols.map((c) => c.csv!(r))),
      );
      if (data.total > data.items.length) toast.error(`Se exportaron ${data.items.length} de ${data.total} renglones (límite).`);
      else toast.ok(`Se exportaron ${data.items.length} renglones.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const data = query.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const allOnPage = items.length > 0 && items.every((r) => selected.has(rowId(r)));
  const activeFilters = Object.values(filterValues).filter(Boolean).length + (q ? 1 : 0);
  const cellPad = dense ? 'px-2 py-1' : 'px-3 py-2';

  return (
    <div className="rounded border border-line bg-panel">
      {/* Barra de filtros */}
      <div className="flex flex-wrap items-end gap-2 border-b border-line p-2">
        {searchable && (
        <form
          className="relative w-full sm:w-64"
          onSubmit={(e) => {
            e.preventDefault();
            setParams({ q: search.trim() });
          }}
        >
          <Search className="pointer-events-none absolute top-2 left-2 h-4 w-4 text-ink-faint" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => search.trim() !== q && setParams({ q: search.trim() })}
            placeholder={searchPlaceholder}
            className="pl-7"
            aria-label="Buscar"
          />
        </form>
        )}
        {filters.map((f) => (
          <div key={f.key} className="w-[calc(50%-4px)] sm:w-auto sm:max-w-56 sm:min-w-40">
            <Select
              value={filterValues[f.key]}
              onChange={(e) => setParams({ [f.key]: e.target.value })}
              className={filterValues[f.key] ? 'border-brand bg-brand-soft' : ''}
              aria-label={f.label}
            >
              <option value="">{f.allLabel ?? `${f.label}: todos`}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {f.label}: {o.label}
                </option>
              ))}
            </Select>
          </div>
        ))}
        {activeFilters > 0 && (
          <Button
            variant="ghost"
            size="sm"
            icon={<X className="h-3.5 w-3.5" />}
            onClick={() => router.replace(pathname, { scroll: false })}
          >
            Limpiar
          </Button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {toolbar}
          {(searchable || filters.length > 0) && (
          <div className="relative">
            <Button size="sm" variant="secondary" icon={<Bookmark className="h-3.5 w-3.5" />} onClick={() => setSavedMenu((v) => !v)}>
              Filtros guardados
            </Button>
            {savedMenu && (
              <div className="absolute right-0 z-20 mt-1 w-64 rounded border border-line bg-panel py-1 shadow-lg" onMouseLeave={() => setSavedMenu(false)}>
                {(saved.data ?? []).length === 0 && <div className="px-3 py-2 text-xs text-ink-faint">Aún no guardas filtros en esta tabla.</div>}
                {(saved.data ?? []).map((f) => (
                  <div key={f.id} className="flex items-center justify-between px-3 py-1 hover:bg-page">
                    <button className="flex-1 truncate text-left text-sm" onClick={() => applySaved(f)}>
                      {f.name}
                    </button>
                    <button className="text-ink-faint hover:text-bad" onClick={() => deleteFilter.mutate(f.id)} aria-label="Eliminar filtro">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <div className="mt-1 border-t border-line px-3 pt-1.5 pb-1">
                  <button className="text-sm text-brand hover:underline disabled:opacity-50" disabled={activeFilters === 0 && !sort} onClick={() => { setSavedMenu(false); setSaveOpen(true); }}>
                    Guardar filtros actuales…
                  </button>
                </div>
              </div>
            )}
          </div>
          )}
          <div className="relative">
            <Button size="sm" variant="secondary" icon={<Columns3 className="h-3.5 w-3.5" />} onClick={() => setColMenu((v) => !v)}>
              Columnas
            </Button>
            {colMenu && (
              <div className="absolute right-0 z-20 mt-1 max-h-80 w-56 overflow-y-auto rounded border border-line bg-panel py-1 shadow-lg" onMouseLeave={() => setColMenu(false)}>
                {columns.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 px-3 py-1 text-sm hover:bg-page">
                    <input
                      type="checkbox"
                      className="accent-brand"
                      checked={!hidden.includes(c.id)}
                      onChange={(e) => {
                        const next = e.target.checked ? hidden.filter((h) => h !== c.id) : [...hidden, c.id];
                        setHidden(next);
                        writeLocal(`erp.cols.${tableKey}`, next);
                      }}
                    />
                    {c.header}
                  </label>
                ))}
              </div>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            title={dense ? 'Vista detallada' : 'Vista compacta'}
            icon={dense ? <Rows3 className="h-3.5 w-3.5" /> : <Rows4 className="h-3.5 w-3.5" />}
            onClick={() => {
              setDense(!dense);
              writeLocal('erp.dense', !dense);
            }}
          >
            {dense ? 'Compacta' : 'Detallada'}
          </Button>
          {exportPerm && can(exportPerm) && (
            <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} loading={exporting} onClick={exportCsv}>
              Exportar
            </Button>
          )}
        </div>
      </div>

      {/* Acciones masivas */}
      {bulkActions && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-soft px-3 py-1.5 text-sm">
          <span className="font-medium">{selected.size} seleccionados</span>
          {bulkActions([...selected.values()], () => setSelected(new Map()))}
          <button className="ml-auto text-xs text-ink-soft hover:underline" onClick={() => setSelected(new Map())}>
            Quitar selección
          </button>
        </div>
      )}

      {/* Tabla */}
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-page text-xs text-ink-soft">
            <tr>
              {bulkActions && (
                <th className={cx(cellPad, 'w-8 border-b border-line')}>
                  <input
                    type="checkbox"
                    className="accent-brand"
                    aria-label="Seleccionar página"
                    checked={allOnPage}
                    onChange={(e) => {
                      const next = new Map(selected);
                      for (const r of items) e.target.checked ? next.set(rowId(r), r) : next.delete(rowId(r));
                      setSelected(next);
                    }}
                  />
                </th>
              )}
              {visible.map((c) => {
                const [sf, sd] = sort.split(':');
                const active = c.sortKey && sf === c.sortKey;
                return (
                  <th
                    key={c.id}
                    className={cx(
                      cellPad,
                      'border-b border-line font-semibold whitespace-nowrap',
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    )}
                  >
                    {c.sortKey ? (
                      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => toggleSort(c.sortKey!)}>
                        {c.header}
                        {active ? sd === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const id = rowId(r);
              const href = rowHref?.(r);
              return (
                <tr
                  key={id}
                  className={cx('border-b border-line last:border-b-0 hover:bg-brand-soft/50', (href || onRowClick) && 'cursor-pointer', selected.has(id) && 'bg-brand-soft/60')}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a,button,input,select,label')) return;
                    if (href) router.push(href);
                    else onRowClick?.(r);
                  }}
                >
                  {bulkActions && (
                    <td className={cellPad}>
                      <input
                        type="checkbox"
                        className="accent-brand"
                        aria-label="Seleccionar"
                        checked={selected.has(id)}
                        onChange={(e) => {
                          const next = new Map(selected);
                          e.target.checked ? next.set(id, r) : next.delete(id);
                          setSelected(next);
                        }}
                      />
                    </td>
                  )}
                  {visible.map((c, i) => (
                    <td
                      key={c.id}
                      className={cx(
                        cellPad,
                        'align-middle',
                        c.align === 'right' ? 'num' : c.align === 'center' ? 'text-center' : '',
                        c.className,
                      )}
                    >
                      {i === 0 && href ? (
                        <Link href={href} className="font-medium whitespace-nowrap text-brand hover:underline">
                          {c.cell(r)}
                        </Link>
                      ) : (
                        c.cell(r)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {query.isLoading && <Spinner />}
        {query.error && (
          <div className="p-3">
            <ErrorBox error={query.error} />
          </div>
        )}
        {!query.isLoading && !query.error && items.length === 0 && <Empty>{emptyText}</Empty>}
      </div>

      {/* Paginación */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-xs text-ink-soft">
        <span>
          {total === 0 ? '0 registros' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} de ${total.toLocaleString('es-MX')}`}
          {query.isFetching && !query.isLoading && ' · actualizando…'}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1">
            Renglones
            <Select value={pageSize} onChange={(e) => setParams({ pageSize: e.target.value })} className="h-7 w-16 text-xs">
              {pageSizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setParams({ page: page - 1 }, false)} aria-label="Anterior">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span>
            Página {page} de {pages}
          </span>
          <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setParams({ page: page + 1 }, false)} aria-label="Siguiente">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Dialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Guardar filtros"
        width="sm"
        footer={
          <>
            <Button onClick={() => setSaveOpen(false)}>Cancelar</Button>
            <Button variant="primary" loading={saveFilter.isPending} disabled={!saveName.trim()} onClick={() => saveFilter.mutate()}>
              Guardar
            </Button>
          </>
        }
      >
        <Field label="Nombre del filtro" required>
          <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Ej. Kits activos de Amazon" autoFocus />
        </Field>
      </Dialog>
    </div>
  );
}

/** Opciones de filtro a partir de un mapa de etiquetas. */
export const optionsFrom = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }));

export function useOptions<T extends { id: string }>(path: string, label: (r: T) => string) {
  const q = useQuery({ queryKey: [path], queryFn: () => get<T[]>(path), staleTime: 60_000 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (q.data ?? []).map((r) => ({ value: r.id, label: label(r) })), [q.data]);
}
