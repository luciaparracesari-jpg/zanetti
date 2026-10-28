'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { IMPORT_BATCH_STATUS } from '@erp/shared';
import { api, get } from '@/lib/api';
import { fmtDateTime, fmtInt } from '@/lib/format';
import { RESULT_LABELS, type ImportTemplateInfo } from '@/lib/imports';
import { DataTable, type Column } from '@/components/data-table';
import { Badge, Button, ErrorBox, PageHeader, Panel, Spinner, cx } from '@/components/ui';

interface BatchRow {
  id: string;
  fileName: string;
  templateLabel: string;
  status: string;
  totalRows: number;
  result: Record<string, number> | null;
  createdAt: string;
  appliedAt: string | null;
  createdByName: string | null;
}

export default function ImportPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const templates = useQuery({ queryKey: ['/data-imports/templates'], queryFn: () => get<ImportTemplateInfo[]>('/data-imports/templates') });
  const allowed = (templates.data ?? []).filter((t) => t.allowed);
  const [selected, setSelected] = useState<string | null>(sp.get('plantilla'));
  const tpl = allowed.find((t) => t.key === selected) ?? allowed[0];
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function upload() {
    if (!file || !tpl) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('template', tpl.key);
      fd.append('file', file);
      const batch = await api<{ id: string }>('/data-imports', { method: 'POST', body: fd });
      router.push(`/importar/${batch.id}`);
    } catch (e) {
      setError(e);
      setUploading(false);
    }
  }

  const columns: Column<BatchRow>[] = [
    { id: 'when', header: 'Cargado', cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</span> },
    { id: 'file', header: 'Archivo', cell: (r) => <span className="font-medium">{r.fileName}</span> },
    { id: 'tpl', header: 'Tipo', cell: (r) => r.templateLabel },
    { id: 'rows', header: 'Renglones', align: 'right', cell: (r) => fmtInt(r.totalRows) },
    {
      id: 'status',
      header: 'Estado',
      cell: (r) => (
        <Badge tone={r.status === 'APLICADO' ? 'ok' : r.status === 'VALIDADO' ? 'warn' : 'neutral'}>
          {IMPORT_BATCH_STATUS[r.status as keyof typeof IMPORT_BATCH_STATUS]}
        </Badge>
      ),
    },
    {
      id: 'result',
      header: 'Resultado',
      cell: (r) =>
        r.result ? (
          <span className="text-xs text-ink-soft">
            {Object.entries(r.result)
              .filter(([k, v]) => v && !['renglonesAplicados', 'renglonesOmitidos', 'sinCambios'].includes(k))
              .map(([k, v]) => `${RESULT_LABELS[k] ?? k}: ${v}`)
              .join(' · ') || 'sin cambios'}
          </span>
        ) : (
          '—'
        ),
    },
    { id: 'user', header: 'Usuario', cell: (r) => r.createdByName ?? '—' },
  ];

  return (
    <>
      <PageHeader
        title="Importar desde Excel"
        subtitle="Carga un archivo, revisa la vista previa, corrige lo necesario y confirma. Nada cambia en el sistema hasta que confirmas."
      />
      {templates.isLoading ? (
        <Spinner />
      ) : allowed.length === 0 ? (
        <ErrorBox error="No tienes permisos para ninguna importación." />
      ) : (
        <div className="mb-3 grid gap-3 lg:grid-cols-3">
          <Panel title="1. Tipo de información" className="lg:col-span-1">
            <div className="flex flex-col gap-2">
              {allowed.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setSelected(t.key)}
                  className={cx('rounded border px-3 py-2 text-left', tpl?.key === t.key ? 'border-brand bg-brand-soft' : 'border-line hover:bg-page')}
                >
                  <div className="text-sm font-semibold">{t.label}</div>
                  <div className="text-xs text-ink-soft">{t.description}</div>
                </button>
              ))}
              {tpl && (
                <a href={`/api/v1/data-imports/templates/${tpl.key}/file`} download className="mt-1">
                  <Button size="sm" icon={<Download className="h-3.5 w-3.5" />}>Descargar plantilla</Button>
                </a>
              )}
            </div>
          </Panel>

          <Panel title="2. Archivo" className="lg:col-span-2">
            <div
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
              onClick={() => input.current?.click()}
              className={cx(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded border-2 border-dashed px-4 py-8 text-center',
                drag ? 'border-brand bg-brand-soft' : 'border-line-strong hover:bg-page',
              )}
            >
              <FileSpreadsheet className="h-8 w-8 text-ink-faint" />
              {file ? (
                <div className="text-sm">
                  <span className="font-medium">{file.name}</span> · {(file.size / 1024).toFixed(0)} KB
                </div>
              ) : (
                <div className="text-sm text-ink-soft">Arrastra aquí tu archivo .xlsx o .csv, o haz clic para elegirlo (máximo 5 MB, 5,000 renglones).</div>
              )}
              <input
                ref={input}
                type="file"
                accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            {tpl && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-ink-soft">Columnas que reconoce “{tpl.label}”</summary>
                <table className="mt-2 w-full text-xs">
                  <tbody>
                    {tpl.columns.map((c) => (
                      <tr key={c.field} className="border-t border-line align-top">
                        <td className="py-1 pr-3 font-mono whitespace-nowrap">{c.header}{c.required && <span className="text-bad"> *</span>}</td>
                        <td className="py-1 text-ink-soft">{c.help}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex-1">{error ? <ErrorBox error={error} /> : null}</div>
              <Button variant="primary" icon={<Upload className="h-4 w-4" />} disabled={!file || !tpl} loading={uploading} onClick={upload}>
                Validar archivo
              </Button>
            </div>
          </Panel>
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold">Historial de importaciones</h2>
      <DataTable<BatchRow>
        tableKey="imports"
        endpoint="/data-imports"
        columns={columns}
        rowId={(r) => r.id}
        rowHref={(r) => `/importar/${r.id}`}
        searchable={false}
        emptyText="Aún no hay importaciones."
      />
      <p className="mt-2 text-xs text-ink-faint">
        ¿Dudas con el formato? <Link className="text-brand hover:underline" href="/productos/skus">Revisa los SKU ya cargados</Link> o descarga la plantilla.
      </p>
    </>
  );
}
