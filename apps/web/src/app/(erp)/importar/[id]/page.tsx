'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Info, RefreshCw, XCircle } from 'lucide-react';
import { IMPORT_BATCH_STATUS, IMPORT_ROW_ACTION, IMPORT_ROW_STATUS } from '@erp/shared';
import { get, patch, post } from '@/lib/api';
import { fmtDateTime, fmtInt } from '@/lib/format';
import { RESULT_LABELS, planSummary, type ImportBatch, type ImportMessage, type ImportRow } from '@/lib/imports';
import { DataTable, optionsFrom, type Column } from '@/components/data-table';
import { useToast } from '@/components/toast';
import { Badge, Button, Dialog, ErrorBox, Field, Input, PageHeader, Panel, Spinner, Stat, cx } from '@/components/ui';

const STATUS_TONE = { VALIDO: 'ok', ADVERTENCIA: 'warn', ERROR: 'bad', OMITIDO: 'neutral' } as const;
const ACTION_TONE = { CREAR: 'info', ACTUALIZAR: 'warn', SIN_CAMBIOS: 'neutral' } as const;

function MessageLine({ m }: { m: ImportMessage }) {
  const Icon = m.level === 'error' ? XCircle : m.level === 'warning' ? AlertTriangle : Info;
  return (
    <div className={cx('flex gap-1 text-xs', m.level === 'error' ? 'text-bad' : m.level === 'warning' ? 'text-warn' : 'text-ink-soft')}>
      <Icon className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{m.message}</span>
    </div>
  );
}

export default function ImportBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const toast = useToast();
  const rowsEndpoint = `/data-imports/${id}/rows`;
  const batch = useQuery({ queryKey: ['import', id], queryFn: () => get<ImportBatch>(`/data-imports/${id}`) });
  const [editing, setEditing] = useState<ImportRow | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const refresh = (b?: ImportBatch) => {
    if (b) qc.setQueryData(['import', id], b);
    else qc.invalidateQueries({ queryKey: ['import', id] });
    qc.invalidateQueries({ queryKey: [rowsEndpoint] });
  };
  const revalidate = useMutation({
    mutationFn: () => post<ImportBatch>(`/data-imports/${id}/revalidate`),
    onSuccess: (b) => { refresh(b); toast.ok('Vista previa actualizada con los datos actuales.'); },
    onError: (e: Error) => toast.error(e.message),
  });
  const apply = useMutation({
    mutationFn: () => post<ImportBatch>(`/data-imports/${id}/apply`),
    onSuccess: (b) => {
      refresh(b);
      setConfirm(false);
      toast.ok('Importación aplicada.');
      qc.invalidateQueries({ queryKey: ['/skus'] });
      qc.invalidateQueries({ queryKey: ['/inventory/stock'] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (e: Error) => { setConfirm(false); toast.error(e.message); refresh(); },
  });
  const cancel = useMutation({
    mutationFn: () => post<ImportBatch>(`/data-imports/${id}/cancel`),
    onSuccess: (b) => { refresh(b); toast.ok('Importación cancelada.'); },
    onError: (e: Error) => toast.error(e.message),
  });

  async function setSkipped(rows: ImportRow[], skipped: boolean, clear?: () => void) {
    let last: ImportBatch | undefined;
    for (const r of rows) {
      try {
        last = await patch<ImportBatch>(`/data-imports/${id}/rows/${r.id}`, { skipped });
      } catch (e) {
        toast.error(`Renglón ${r.rowNumber}: ${(e as Error).message}`);
      }
    }
    refresh(last);
    clear?.();
  }

  if (batch.isLoading) return <Spinner />;
  if (batch.error) return <ErrorBox error={batch.error} />;
  const b = batch.data!;
  const open = b.status === 'VALIDADO';
  const s = b.summary;
  const toApply = s.toCreate + s.toUpdate;
  const cols = b.template.columns;

  // Columnas de la vista previa: estado, acción, los campos del archivo y los mensajes.
  const columns: Column<ImportRow>[] = [
    { id: 'row', header: 'Renglón', align: 'right', cell: (r) => <span className="text-ink-soft">{r.rowNumber}</span> },
    { id: 'status', header: 'Estado', cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{IMPORT_ROW_STATUS[r.status]}</Badge> },
    {
      id: 'action',
      header: 'Acción',
      cell: (r) => (r.action && r.status !== 'ERROR' && r.status !== 'OMITIDO' ? <Badge tone={ACTION_TONE[r.action]}>{IMPORT_ROW_ACTION[r.action]}</Badge> : '—'),
    },
    ...cols.filter((c) => c.inFile).map<Column<ImportRow>>((c) => ({
      id: c.field,
      header: c.header,
      cell: (r) => {
        const lvl = r.messages.find((m) => m.field === c.field && m.level !== 'info')?.level;
        const edited = r.edits && c.field in r.edits;
        return (
          <span
            className={cx(
              'font-mono text-xs whitespace-nowrap',
              lvl === 'error' && 'rounded bg-bad-soft px-1 text-bad',
              lvl === 'warning' && 'rounded bg-warn-soft px-1 text-warn',
              edited && 'underline decoration-brand decoration-dotted underline-offset-2',
            )}
            title={edited ? `Original: ${r.raw[c.field] ?? '(vacío)'}` : undefined}
          >
            {r.values[c.field] ?? <span className="text-ink-faint">—</span>}
          </span>
        );
      },
    })),
    { id: 'plan', header: 'Qué se hará', cell: (r) => <span className="text-xs whitespace-nowrap text-ink-soft">{r.status === 'ERROR' || r.status === 'OMITIDO' ? '—' : planSummary(r.plan)}</span> },
    {
      id: 'messages',
      header: 'Observaciones',
      cell: (r) => {
        const shown = r.messages.filter((m) => showInfo || m.level !== 'info');
        return shown.length ? <div className="flex min-w-72 flex-col gap-0.5">{shown.map((m, i) => <MessageLine key={i} m={m} />)}</div> : null;
      },
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Importar desde Excel', href: '/importar' }, { label: b.fileName }]}
        title={b.fileName}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={b.status === 'APLICADO' ? 'ok' : b.status === 'VALIDADO' ? 'warn' : 'neutral'}>{IMPORT_BATCH_STATUS[b.status]}</Badge>
            <span>{b.template.label}</span>
            {b.sheetName && <span>· hoja {b.sheetName}</span>}
            <span>· cargado {fmtDateTime(b.createdAt)}{b.createdByName ? ` por ${b.createdByName}` : ''}</span>
            {b.appliedAt && <span>· aplicado {fmtDateTime(b.appliedAt)}</span>}
          </span>
        }
        actions={
          open && (
            <>
              <Button onClick={() => cancel.mutate()} loading={cancel.isPending}>Cancelar importación</Button>
              <Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => revalidate.mutate()} loading={revalidate.isPending}>Revalidar</Button>
              <Button variant="primary" disabled={s.error > 0 || toApply === 0} onClick={() => setConfirm(true)} title={s.error > 0 ? 'Corrige u omite los renglones con error' : undefined}>
                Importar {fmtInt(toApply)} renglones
              </Button>
            </>
          )
        }
      />

      {b.status === 'APLICADO' && b.result && (
        <Panel className="mb-3" title={<span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-ok" /> Importación aplicada</span>}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {Object.keys(RESULT_LABELS)
              .filter((k) => k in b.result! && (b.result![k] > 0 || k === 'skusCreados' || k === 'skusActualizados'))
              .map((k) => <Stat key={k} label={RESULT_LABELS[k]} value={fmtInt(b.result![k])} />)}
          </div>
          <div className="mt-3 flex gap-2">
            {b.template.key === 'kits' ? (
              <Link href="/productos/skus?isKit=true"><Button variant="primary">Ver kits</Button></Link>
            ) : b.template.key === 'inventario-inicial' ? (
              <>
                <Link href="/inventario"><Button variant="primary">Ver existencias</Button></Link>
                <Link href={`/inventario/movimientos?documentId=${b.id}`}><Button>Ver movimientos</Button></Link>
              </>
            ) : (
              <>
                <Link href="/productos/skus"><Button variant="primary">Ver SKU maestros</Button></Link>
                <Link href="/productos/publicaciones"><Button>Ver publicaciones</Button></Link>
              </>
            )}
            <Link href="/importar"><Button>Nueva importación</Button></Link>
          </div>
        </Panel>
      )}

      {open && (
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
          <Stat label="Renglones" value={fmtInt(b.totalRows)} />
          <Stat label="Válidos" value={fmtInt(s.valid)} />
          <Stat label="Con advertencia" value={<span className={s.warning ? 'text-warn' : ''}>{fmtInt(s.warning)}</span>} />
          <Stat label="Con error" value={<span className={s.error ? 'text-bad' : ''}>{fmtInt(s.error)}</span>} tone={s.error ? 'brand' : undefined} />
          <Stat label="Omitidos" value={fmtInt(s.skipped)} />
          <Stat label="A crear" value={fmtInt(s.toCreate)} />
          <Stat label="A actualizar · sin cambios" value={`${fmtInt(s.toUpdate)} · ${fmtInt(s.unchanged)}`} />
        </div>
      )}

      {b.fileMessages.length > 0 && (
        <div className="mb-3 rounded border border-line bg-panel px-3 py-2">
          {b.fileMessages.map((m, i) => <MessageLine key={i} m={m} />)}
        </div>
      )}

      {open && s.error > 0 && (
        <div className="mb-3 rounded border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">
          Hay {s.error} renglones con error. Haz clic en un renglón para corregirlo, u omítelo; después podrás importar.
        </div>
      )}

      <DataTable<ImportRow>
        tableKey={`import-rows-${b.template.key}`}
        endpoint={rowsEndpoint}
        columns={columns}
        rowId={(r) => String(r.id)}
        onRowClick={open ? (r) => setEditing(r) : undefined}
        searchPlaceholder="Buscar en los valores del renglón…"
        filters={[
          { key: 'status', label: 'Estado', options: optionsFrom(IMPORT_ROW_STATUS) },
          { key: 'action', label: 'Acción', options: optionsFrom(IMPORT_ROW_ACTION) },
        ]}
        toolbar={
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            <input type="checkbox" className="accent-brand" checked={showInfo} onChange={(e) => setShowInfo(e.target.checked)} />
            Mostrar notas informativas
          </label>
        }
        bulkActions={
          open
            ? (rows, clear) => (
                <>
                  <Button size="sm" onClick={() => setSkipped(rows.filter((r) => !r.skipped), true, clear)}>Omitir</Button>
                  <Button size="sm" onClick={() => setSkipped(rows.filter((r) => r.skipped), false, clear)}>Incluir</Button>
                </>
              )
            : undefined
        }
      />

      <RowDialog
        row={editing}
        batch={b}
        onClose={() => setEditing(null)}
        onSaved={(nb) => { refresh(nb); setEditing(null); }}
      />

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Confirmar importación"
        width="sm"
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Revisar otra vez</Button>
            <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate()}>Importar</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>Se aplicarán {fmtInt(toApply)} renglones en una sola operación:</p>
          <ul className="list-disc pl-5">
            <li>{fmtInt(s.toCreate)} SKU nuevos</li>
            <li>{fmtInt(s.toUpdate)} SKU existentes a los que se agrega lo que falta</li>
            {s.unchanged > 0 && <li>{fmtInt(s.unchanged)} renglones sin cambios</li>}
            {s.skipped > 0 && <li>{fmtInt(s.skipped)} renglones omitidos</li>}
          </ul>
          <p className="text-ink-soft">Nada se borra. Si algo cambió desde la vista previa, el sistema vuelve a validar y no importa nada si encuentra errores.</p>
        </div>
      </Dialog>
    </>
  );
}

function RowDialog({ row, batch, onClose, onSaved }: { row: ImportRow | null; batch: ImportBatch; onClose: () => void; onSaved: (b: ImportBatch) => void }) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (row) setValues(Object.fromEntries(batch.template.columns.map((c) => [c.field, row.values[c.field] ?? ''])));
  }, [row, batch.template.columns]);
  if (!row) return null;

  async function save(skipped?: boolean) {
    setSaving(true);
    try {
      const changed = Object.fromEntries(
        Object.entries(values)
          .filter(([k, v]) => (v || null) !== (row!.values[k] ?? null))
          .map(([k, v]) => [k, v.trim() === '' ? null : v]),
      );
      const body: Record<string, unknown> = {};
      if (Object.keys(changed).length) body.values = changed;
      if (skipped !== undefined) body.skipped = skipped;
      if (!Object.keys(body).length) return onClose();
      const b = await patch<ImportBatch>(`/data-imports/${batch.id}/rows/${row!.id}`, body);
      toast.ok(`Renglón ${row!.rowNumber} actualizado y revalidado.`);
      onSaved(b);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const msgsFor = (f: string) => row.messages.filter((m) => m.field === f);
  const general = row.messages.filter((m) => !m.field || !batch.template.columns.some((c) => c.field === m.field));
  return (
    <Dialog
      open={Boolean(row)}
      onClose={onClose}
      title={`Renglón ${row.rowNumber} · ${row.values.skuCode ?? ''}`}
      width="lg"
      footer={
        <>
          {row.skipped ? (
            <Button onClick={() => save(false)} loading={saving}>Incluir renglón</Button>
          ) : (
            <Button onClick={() => save(true)} loading={saving}>Omitir renglón</Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={() => save()} loading={saving}>Guardar y revalidar</Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-soft">Los cambios sólo afectan esta vista previa; el archivo original no se modifica. Deja vacío un campo para quitar su valor.</p>
      {general.length > 0 && <div className="mb-3">{general.map((m, i) => <MessageLine key={i} m={m} />)}</div>}
      <div className="grid gap-3 sm:grid-cols-2">
        {batch.template.columns.map((c) => {
          const ms = msgsFor(c.field);
          const lvl = ms.find((m) => m.level === 'error') ? 'error' : ms.find((m) => m.level === 'warning') ? 'warning' : null;
          return (
            <Field key={c.field} label={c.header}>
              <Input
                value={values[c.field] ?? ''}
                onChange={(e) => setValues({ ...values, [c.field]: e.target.value })}
                aria-invalid={lvl === 'error'}
                className={cx('font-mono', lvl === 'warning' && 'border-warn')}
              />
              {ms.map((m, i) => <MessageLine key={i} m={m} />)}
              {row.edits && c.field in row.edits && <span className="text-xs text-ink-faint">Original: {row.raw[c.field] ?? '(vacío)'}</span>}
            </Field>
          );
        })}
      </div>
    </Dialog>
  );
}
