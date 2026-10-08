'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtRate } from '@/lib/format';
import { applyServerErrors } from '@/lib/forms';
import { useSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { Button, ErrorBox, Field, Input, PageHeader, Panel, Spinner } from '@/components/ui';

interface Settings {
  company: { legalName: string; tradeName: string | null; rfc: string | null; timezone: string; baseCurrency: string };
  parameters: { key: string; value: unknown; description: string | null; updatedAt: string }[];
  taxes: { id: string; code: string; name: string; rate: string; validFrom: string; validTo: string | null }[];
  currencies: { code: string; name: string; symbol: string }[];
}

function ParamRow({ p, editable }: { p: Settings['parameters'][number]; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [val, setVal] = useState(p.value === null ? '' : String(p.value));
  useEffect(() => setVal(p.value === null ? '' : String(p.value)), [p.value]);
  const isBool = typeof p.value === 'boolean';
  async function save(raw: string | boolean) {
    const value = isBool ? raw : raw === '' ? null : Number.isNaN(Number(raw)) ? raw : Number(raw);
    try {
      await patch(`/settings/parameters/${encodeURIComponent(p.key)}`, { value });
      toast.ok('Parámetro guardado.');
      qc.invalidateQueries({ queryKey: ['/settings'] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <tr className="border-t border-line align-top">
      <td className="px-3 py-1.5">
        <div className="font-mono text-xs">{p.key}</div>
        <div className="text-xs text-ink-soft">{p.description}</div>
      </td>
      <td className="px-3 py-1.5">
        {isBool ? (
          <input type="checkbox" className="h-4 w-4 accent-brand" checked={Boolean(p.value)} disabled={!editable} onChange={(e) => save(e.target.checked)} />
        ) : (
          <div className="flex gap-1">
            <Input value={val} onChange={(e) => setVal(e.target.value)} disabled={!editable} className="w-32 num" placeholder="sin definir" />
            {editable && val !== (p.value === null ? '' : String(p.value)) && <Button size="sm" variant="primary" onClick={() => save(val)}>Guardar</Button>}
          </div>
        )}
      </td>
      <td className="px-3 py-1.5 text-xs text-ink-faint whitespace-nowrap">{fmtDateTime(p.updatedAt)}</td>
    </tr>
  );
}

export default function CompanyPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['/settings'], queryFn: () => get<Settings>('/settings') });
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError, formState } = useForm<{ legalName: string; tradeName: string; rfc: string }>();
  useEffect(() => {
    if (q.data) reset({ legalName: q.data.company.legalName, tradeName: q.data.company.tradeName ?? '', rfc: q.data.company.rfc ?? '' });
  }, [q.data, reset]);

  async function onSubmit(v: { legalName: string; tradeName: string; rfc: string }) {
    setMsg(null);
    try {
      await patch('/settings/company', v);
      toast.ok('Datos de la empresa guardados.');
      qc.invalidateQueries({ queryKey: ['/settings'] });
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const editable = can('configuracion.editar');
  return (
    <>
      <PageHeader title="Empresa y parámetros" />
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Datos de la empresa">
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
            {msg && <div className="sm:col-span-2"><ErrorBox error={msg} /></div>}
            <Field label="Razón social" required className="sm:col-span-2" error={formState.errors.legalName?.message}><Input {...register('legalName')} disabled={!editable} /></Field>
            <Field label="Nombre comercial"><Input {...register('tradeName')} disabled={!editable} /></Field>
            <Field label="RFC" error={formState.errors.rfc?.message}><Input {...register('rfc')} disabled={!editable} className="uppercase" /></Field>
            <Field label="Zona horaria"><Input value={d.company.timezone} disabled /></Field>
            <Field label="Moneda base"><Input value={d.company.baseCurrency} disabled /></Field>
            {editable && <div className="flex justify-end sm:col-span-2"><Button type="submit" variant="primary" loading={formState.isSubmitting}>Guardar</Button></div>}
          </form>
        </Panel>
        <div className="flex flex-col gap-3">
          <Panel title="Impuestos" bodyClassName="p-0">
            <table className="w-full text-sm">
              <tbody>
                {d.taxes.map((t) => (
                  <tr key={t.id} className="border-t border-line first:border-0">
                    <td className="px-3 py-1.5">{t.name}</td>
                    <td className="num px-3 py-1.5">{fmtRate(t.rate)}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-soft">desde {fmtDate(t.validFrom)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Monedas" bodyClassName="p-0">
            <table className="w-full text-sm">
              <tbody>
                {d.currencies.map((c) => (
                  <tr key={c.code} className="border-t border-line first:border-0">
                    <td className="px-3 py-1.5 font-mono">{c.code}</td>
                    <td className="px-3 py-1.5">{c.name}</td>
                    <td className="px-3 py-1.5">{c.symbol}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
      <Panel title="Parámetros del sistema" className="mt-3" bodyClassName="p-0">
        <table className="w-full text-sm">
          <tbody>
            {d.parameters.map((p) => <ParamRow key={p.key} p={p} editable={editable} />)}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
