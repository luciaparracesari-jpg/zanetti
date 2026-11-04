'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, ListPlus, Lock, Pencil, Plus, Save, Trash2, Unlock } from 'lucide-react';
import { ApiError, del, get, patch, post } from '@/lib/api';
import { fmtCost, fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import { BASIS, COST_STATUS, CURRENCIES, fmtCur, pctText, type CloseResult, type CostExpense, type CostLine, type Costing } from '@/lib/purchasing';
import { useSession } from '@/lib/session';
import { LocalTable, type LocalColumn } from './local-table';
import { useToast } from './toast';
import { Badge, Button, Dialog, Empty, ErrorBox, Field, Input, Panel, Select, Spinner, Stat, StatusBadge } from './ui';

const errText = (e: unknown) => (e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(' ') : e);

/**
 * Costeo del contenedor con el método del negocio: gastos en su moneda (USD × tipo de cambio), gasto por pieza
 * = gastos ÷ piezas, arancel por SKU con el tipo de cambio del pedimento y costo puesto en bodega por SKU.
 */
export function ContainerCosting({ containerId }: { containerId: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['/containers', containerId, 'costing'];
  const q = useQuery({ queryKey: key, queryFn: () => get<Costing>(`/containers/${containerId}/costing`) });
  const [expense, setExpense] = useState<{ open: boolean; row: CostExpense | null }>({ open: false, row: null });
  const [duty, setDuty] = useState(false);
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState<CloseResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const c = q.data!;
  const open = c.costStatus === 'ABIERTO';
  const editable = open && can('compras.editar');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['/containers'] });
  };

  async function loadDefaults() {
    try {
      const r = await post<{ added: number }>(`/containers/${containerId}/costs/defaults`);
      toast.ok(r.added ? `Se agregaron ${r.added} conceptos en 0: captura los montos.` : 'Ya están todos los conceptos.');
      refresh();
    } catch (e) {
      setError(errText(e));
    }
  }
  async function removeExpense(e: CostExpense) {
    if (!window.confirm(`¿Quitar el gasto "${e.concept}"?`)) return;
    try {
      await del(`/containers/${containerId}/costs/${e.id}`);
      refresh();
    } catch (x) {
      setError(errText(x));
    }
  }
  async function close() {
    setClosing(true);
    setError(null);
    try {
      const r = await post<CloseResult>(`/containers/${containerId}/costing/close`);
      setResult(r);
      refresh();
      qc.invalidateQueries({ queryKey: ['/inventory-valuation'] });
    } catch (e) {
      setError(errText(e));
    } finally {
      setClosing(false);
    }
  }
  async function reopen() {
    if (!window.confirm('¿Reabrir el costeo? Al cerrarlo de nuevo se recalculan los costos y se revalúan los lotes.')) return;
    try {
      await post(`/containers/${containerId}/costing/reopen`);
      refresh();
    } catch (e) {
      setError(errText(e));
    }
  }

  const expenseCols: LocalColumn<CostExpense>[] = [
    { id: 'concept', header: 'Concepto', cell: (r) => <span className="font-medium">{r.concept}</span>, value: (r) => r.concept },
    { id: 'amount', header: 'Monto', align: 'right', cell: (r) => <span className={Number(r.amount) === 0 ? 'text-ink-soft' : ''}>{fmtCur(r.amount, r.currency)}</span>, value: (r) => Number(r.amount) },
    { id: 'fx', header: 'Tipo de cambio', align: 'right', cell: (r) => (r.currency === 'MXN' ? '—' : r.fxUsed ? <span title={r.fxRate ? 'Del gasto' : 'Del contenedor'}>{r.fxUsed}{!r.fxRate && <span className="text-ink-soft"> *</span>}</span> : <Badge tone="bad">Falta</Badge>), value: (r) => r.fxUsed },
    { id: 'mxn', header: 'En pesos', align: 'right', cell: (r) => fmtMoney(r.amountMxn), value: (r) => Number(r.amountMxn) },
    { id: 'basis', header: 'Reparto', cell: (r) => <span className="text-xs">{BASIS[r.basis]}</span>, value: (r) => r.basis },
    { id: 'inv', header: 'Factura', cell: (r) => <span className="text-xs">{[r.invoiceRef, r.notes].filter(Boolean).join(' · ') || '—'}</span>, value: (r) => r.invoiceRef },
    ...(editable
      ? ([
          {
            id: 'act',
            header: '',
            align: 'right',
            cell: (r) => (
              <span className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setExpense({ open: true, row: r })} aria-label="Editar gasto" />
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => removeExpense(r)} aria-label="Quitar gasto" />
              </span>
            ),
          },
        ] as LocalColumn<CostExpense>[])
      : []),
  ];

  const show = (l: CostLine, k: 'merch' | 'duty' | 'expense' | 'unit') => {
    if (!open && l.unitCost !== null) return k === 'merch' ? l.merchUnitCost : k === 'duty' ? l.dutyUnitCost : k === 'expense' ? l.expenseUnitCost : l.unitCost;
    if (!l.calc) return null;
    return k === 'merch' ? l.calc.merchUnit : k === 'duty' ? l.calc.dutyUnit : k === 'expense' ? l.calc.expenseUnit : l.calc.unitCost;
  };
  const lineCols: LocalColumn<CostLine>[] = [
    { id: 'sku', header: 'SKU', cell: (l) => <Link href={`/productos/skus/${l.skuId}`} className="font-mono text-xs text-brand hover:underline">{l.skuCode}</Link>, value: (l) => l.skuCode },
    { id: 'name', header: 'Nombre', cell: (l) => <span className="line-clamp-2 text-xs">{l.name}</span>, value: (l) => l.name },
    { id: 'po', header: 'Orden', cell: (l) => (l.poId ? <Link href={`/compras/ordenes/${l.poId}`} className="text-xs text-brand hover:underline">{l.poFolio}</Link> : <Badge tone="warn">Sin orden</Badge>), value: (l) => l.poFolio },
    { id: 'qty', header: 'Piezas', align: 'right', cell: (l) => fmtInt(l.qtyCosted), value: (l) => l.qtyCosted },
    { id: 'price', header: 'Precio proveedor', align: 'right', cell: (l) => (l.unitPrice === null ? <Badge tone="warn">Sin precio</Badge> : fmtCur(l.unitPrice, l.currency ?? 'MXN', 4)), value: (l) => (l.unitPrice === null ? null : Number(l.unitPrice)) },
    { id: 'fx', header: 'TC', align: 'right', cell: (l) => (l.currency === 'MXN' ? '—' : (l.fxUsed ?? '—')), value: (l) => l.fxUsed },
    { id: 'merch', header: 'Producto', group: 'Por pieza (MXN)', align: 'right', cell: (l) => fmtCost(show(l, 'merch')), value: (l) => Number(show(l, 'merch') ?? 0) },
    { id: 'rate', header: 'Arancel %', group: 'Por pieza (MXN)', align: 'right', cell: (l) => (l.dutyRate === null ? <Badge tone="warn">—</Badge> : `${pctText(l.dutyRate)} %`), value: (l) => (l.dutyRate === null ? null : Number(l.dutyRate)) },
    { id: 'duty', header: 'Arancel', group: 'Por pieza (MXN)', align: 'right', cell: (l) => fmtCost(show(l, 'duty')), value: (l) => Number(show(l, 'duty') ?? 0) },
    { id: 'exp', header: 'Gastos', group: 'Por pieza (MXN)', align: 'right', cell: (l) => fmtCost(show(l, 'expense')), value: (l) => Number(show(l, 'expense') ?? 0) },
    { id: 'unit', header: 'Costo en bodega', group: 'Por pieza (MXN)', align: 'right', cell: (l) => <b>{fmtCost(show(l, 'unit'))}</b>, value: (l) => Number(show(l, 'unit') ?? 0) },
    { id: 'total', header: 'Total', align: 'right', cell: (l) => fmtMoney(show(l, 'unit') === null ? null : Number(show(l, 'unit')) * l.qtyCosted), value: (l) => Number(show(l, 'unit') ?? 0) * l.qtyCosted },
    ...(c.received
      ? ([
          {
            id: 'lot',
            header: 'Lote en inventario',
            cell: (l) => (l.lot ? <span className="text-xs">{fmtCost(l.lot.unitCost)} <StatusBadge value={l.lot.costStatus} labels={{ FINAL: 'Final', PROVISIONAL: 'Provisional' }} /> · {fmtInt(l.lot.onHand)} pzas</span> : '—'),
            value: (l) => (l.lot ? Number(l.lot.unitCost) : null),
          },
        ] as LocalColumn<CostLine>[])
      : []),
  ];

  return (
    <div className="grid gap-3">
      <ErrorBox error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge value={c.costStatus} labels={COST_STATUS} />
        {!open && c.costClosedAt && <span className="text-xs text-ink-soft">Cerrado el {fmtDateTime(c.costClosedAt)}</span>}
        <span className="ml-auto flex gap-2">
          {open && can('compras.autorizar') && (
            <Button variant="primary" icon={<Lock className="h-4 w-4" />} loading={closing} disabled={c.issues.length > 0 || c.lines.length === 0 || c.status === 'PLANEADO'} onClick={close}>
              Cerrar costeo
            </Button>
          )}
          {!open && can('compras.autorizar') && <Button icon={<Unlock className="h-4 w-4" />} onClick={reopen}>Reabrir</Button>}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Stat label="Piezas" value={fmtInt(c.totals.pieces)} hint={c.received ? 'Las recibidas en APLIN' : 'Las del contenedor'} />
        <Stat label="Mercancía (MXN)" value={fmtMoney(c.totals.merchMxn)} hint="Precio del proveedor × tipo de cambio" />
        <Stat label="Arancel (IGI)" value={fmtMoney(c.totals.dutyMxn)} hint="Precio × TC del pedimento × tasa de cada SKU" />
        <Stat label="Gastos del contenedor" value={fmtMoney(c.totals.expensesMxn)} />
        <Stat label="Gasto por pieza" value={fmtCost(c.totals.expensePerPiece)} tone="brand" hint="Gastos ÷ piezas (como tu hoja de costeo)" />
        <Stat label="Costo total puesto en bodega" value={fmtMoney(c.totals.total)} />
      </div>
      {c.issues.length > 0 && (
        <div className="rounded border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">
          <b>Para cerrar el costeo falta:</b>
          <ul className="ml-4 list-disc">{c.issues.slice(0, 8).map((i, n) => <li key={n}>{i.message}</li>)}</ul>
          {c.issues.length > 8 && <span>… y {c.issues.length - 8} más.</span>}
        </div>
      )}
      {open && c.warnings.length > 0 && (
        <div className="rounded border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
          <b>Avisos:</b> {c.warnings.length} SKU sin tasa de arancel (IGI): se costean con 0%. {editable && <button className="underline" onClick={() => setDuty(true)}>Capturar aranceles</button>}
        </div>
      )}
      <HeaderForm c={c} editable={editable} onSaved={refresh} />
      <Panel
        title="Gastos del contenedor"
        actions={
          editable && (
            <>
              <Button size="sm" icon={<ListPlus className="h-4 w-4" />} onClick={loadDefaults}>Conceptos habituales</Button>
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setExpense({ open: true, row: null })}>Agregar gasto</Button>
            </>
          )
        }
        bodyClassName="p-0"
      >
        <LocalTable
          rows={c.expenses}
          columns={expenseCols}
          rowKey={(r) => r.id}
          maxHeight="40vh"
          empty={<Empty>Sin gastos. Usa “Conceptos habituales” para cargar flete, maniobras, honorarios, DTA, PRV, IGI… y sólo capturar los montos.</Empty>}
          footer={
            c.expenses.length > 0 && (
              <tr className="border-t border-line font-semibold">
                <td className="px-2 py-1.5">Total gastos</td>
                <td />
                <td />
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(c.totals.expensesMxn)}</td>
                <td className="px-2 py-1.5 text-xs font-normal text-ink-soft" colSpan={editable ? 3 : 2}>÷ {fmtInt(c.totals.pieces)} piezas = {fmtCost(c.totals.expensePerPiece)} por pieza</td>
              </tr>
            )
          }
        />
        <p className="px-3 py-2 text-xs text-ink-soft">Montos sin IVA (el IVA de importación se acredita, no es costo). * = usa el tipo de cambio del contenedor.</p>
      </Panel>
      <LocalTable
        rows={c.lines}
        columns={lineCols}
        rowKey={(l) => l.id}
        search={(l) => `${l.skuCode} ${l.name} ${l.poFolio ?? ''}`}
        csvName={`costeo-${c.code}`}
        toolbar={editable && <Button size="sm" icon={<Calculator className="h-4 w-4" />} onClick={() => setDuty(true)}>Aranceles por SKU</Button>}
      />
      {expense.open && <ExpenseDialog containerId={containerId} row={expense.row} concepts={c.defaultConcepts} onClose={() => setExpense({ open: false, row: null })} onDone={refresh} />}
      {duty && <DutyDialog containerId={containerId} lines={c.lines} onClose={() => setDuty(false)} onDone={refresh} />}
      {result && <CloseResultDialog code={c.code} r={result} onClose={() => setResult(null)} />}
    </div>
  );
}

function HeaderForm({ c, editable, onSaved }: { c: Costing; editable: boolean; onSaved: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const [pedimento, setPedimento] = useState(c.pedimento ?? '');
  const [invoiceRef, setInvoiceRef] = useState(c.invoiceRef ?? '');
  const [fxRate, setFxRate] = useState(c.fxRate ?? '');
  const [dutyFxRate, setDutyFxRate] = useState(c.dutyFxRate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await patch(`/containers/${c.id}/costing`, {
        pedimento: pedimento || null,
        invoiceRef: invoiceRef || null,
        ...(editable ? { fxRate: fxRate || null, dutyFxRate: dutyFxRate || null } : {}),
      });
      toast.ok('Datos del costeo guardados.');
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  const canEdit = can('compras.editar');
  return (
    <Panel title="Pedimento y tipo de cambio">
      <ErrorBox error={error} />
      <div className="grid gap-3 md:grid-cols-5">
        <Field label="Pedimento"><Input value={pedimento} onChange={(e) => setPedimento(e.target.value)} disabled={!canEdit} placeholder="Ej. 26 16 1234 6000001" /></Field>
        <Field label="Factura(s) comercial(es)"><Input value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} disabled={!canEdit} placeholder="Ej. INV-2026-001" /></Field>
        <Field label="Tipo de cambio de la mercancía" hint="Para órdenes y gastos en USD sin tipo de cambio propio."><Input inputMode="decimal" className="num" value={fxRate} onChange={(e) => setFxRate(e.target.value)} disabled={!editable} placeholder="18.0000" /></Field>
        <Field label="Tipo de cambio del pedimento" hint="Para el arancel (IGI). Vacío = el de la mercancía."><Input inputMode="decimal" className="num" value={dutyFxRate} onChange={(e) => setDutyFxRate(e.target.value)} disabled={!editable} placeholder="18.1000" /></Field>
        {canEdit && <div className="flex items-end"><Button icon={<Save className="h-4 w-4" />} loading={busy} onClick={save}>Guardar</Button></div>}
      </div>
    </Panel>
  );
}

function ExpenseDialog({ containerId, row, concepts, onClose, onDone }: { containerId: string; row: CostExpense | null; concepts: string[]; onClose: () => void; onDone: () => void }) {
  const [concept, setConcept] = useState(row?.concept ?? '');
  const [amount, setAmount] = useState(row?.amount ?? '');
  const [currency, setCurrency] = useState(row?.currency ?? 'MXN');
  const [fxRate, setFxRate] = useState(row?.fxRate ?? '');
  const [basis, setBasis] = useState(row?.basis ?? 'PIEZAS');
  const [invoiceRef, setInvoiceRef] = useState(row?.invoiceRef ?? '');
  const [notes, setNotes] = useState(row?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    const body = { concept, amount, currency, fxRate: currency === 'MXN' ? null : fxRate || null, basis, invoiceRef: invoiceRef || null, notes: notes || null };
    try {
      if (row) await patch(`/containers/${containerId}/costs/${row.id}`, body);
      else await post(`/containers/${containerId}/costs`, body);
      onDone();
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={row ? `Editar gasto: ${row.concept}` : 'Agregar gasto'} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!concept || amount === ''} onClick={submit}>Guardar</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
        <Field label="Concepto" required className="sm:col-span-2">
          <Input list="cost-concepts" value={concept} onChange={(e) => setConcept(e.target.value)} />
          <datalist id="cost-concepts">{concepts.map((x) => <option key={x} value={x} />)}</datalist>
        </Field>
        <Field label="Monto (sin IVA)" required><Input inputMode="decimal" className="num" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={Boolean(row)} /></Field>
        <Field label="Moneda"><Select value={currency} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((x) => <option key={x}>{x}</option>)}</Select></Field>
        {currency !== 'MXN' && <Field label="Tipo de cambio" hint="Vacío = el del contenedor."><Input inputMode="decimal" className="num" value={fxRate} onChange={(e) => setFxRate(e.target.value)} /></Field>}
        <Field label="Cómo se reparte" hint="Tu método: por piezas.">
          <Select value={basis} onChange={(e) => setBasis(e.target.value)}>{Object.entries(BASIS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </Field>
        <Field label="Factura del gasto"><Input value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} /></Field>
        <Field label="Notas"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. IGI incrementables = (flete + seguro + otros) × 15%" /></Field>
      </div>
    </Dialog>
  );
}

function DutyDialog({ containerId, lines, onClose, onDone }: { containerId: string; lines: CostLine[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const skus = [...new Map(lines.map((l) => [l.skuId, l])).values()];
  const [rates, setRates] = useState<Record<string, string>>(Object.fromEntries(skus.map((l) => [l.skuId, pctText(l.dutyRate)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const items = skus.map((l) => ({ skuId: l.skuId, dutyRate: rates[l.skuId] === '' ? null : Number(rates[l.skuId]) / 100 }));
      const r = await patch<{ changed: number }>(`/containers/${containerId}/duty-rates`, { items });
      toast.ok(r.changed ? `${r.changed} aranceles actualizados.` : 'Sin cambios.');
      onDone();
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Arancel (IGI) por SKU" footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={submit}>Guardar</Button></>}>
      <div className="grid gap-2">
        <ErrorBox error={error} />
        <p className="text-sm text-ink-soft">Tasa de la fracción arancelaria de cada SKU (por ejemplo 15 o 25). Se guarda en el SKU y se usa en todos sus contenedores. Arancel por pieza = precio del proveedor × TC del pedimento × tasa.</p>
        <div className="flex justify-end gap-2 text-xs">
          {['15', '25'].map((p) => <button key={p} className="text-brand underline" onClick={() => setRates(Object.fromEntries(skus.map((l) => [l.skuId, rates[l.skuId] || p])))}>Llenar vacíos con {p} %</button>)}
        </div>
        <table className="w-full text-sm">
          <tbody>
            {skus.map((l) => (
              <tr key={l.skuId} className="border-t border-line">
                <td className="py-1 pr-2 font-mono text-xs">{l.skuCode}</td>
                <td className="py-1 pr-2 text-xs">{l.name}</td>
                <td className="w-28 py-1">
                  <div className="flex items-center gap-1">
                    <Input inputMode="decimal" className="num" value={rates[l.skuId] ?? ''} onChange={(e) => setRates((x) => ({ ...x, [l.skuId]: e.target.value }))} aria-label={`Arancel de ${l.skuCode}`} />
                    <span className="text-xs">%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

function CloseResultDialog({ code, r, onClose }: { code: string; r: CloseResult; onClose: () => void }) {
  const changed = r.revalued.filter((x) => x.changed);
  return (
    <Dialog open width="lg" onClose={onClose} title={`Costeo de ${code} cerrado`} footer={<Button variant="primary" onClick={onClose}>Listo</Button>}>
      <div className="grid gap-3 text-sm">
        <p>
          Costo total puesto en bodega <b>{fmtMoney(r.totals.total)}</b> ({fmtInt(r.totals.pieces)} piezas): mercancía {fmtMoney(r.totals.merchMxn)} + arancel {fmtMoney(r.totals.dutyMxn)} + gastos {fmtMoney(r.totals.expensesMxn)}.
        </p>
        {!r.received ? (
          <p className="text-ink-soft">El contenedor aún no llega: cuando se reciba, sus lotes entran con estos costos como finales.</p>
        ) : changed.length === 0 ? (
          <p className="text-ink-soft">Los lotes ya tenían estos costos; no hubo revaluación.</p>
        ) : (
          <>
            <p>
              Se revaluaron <b>{changed.length}</b> lotes: el inventario cambia <b>{fmtMoney(r.deltaOnHand)}</b> en almacenes y {fmtMoney(r.deltaInTransit)} en camino. La diferencia de lo que ya salió es {fmtMoney(r.deltaConsumed)} (va al costo de venta).
            </p>
            <div className="max-h-72 overflow-auto rounded border border-line">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-page text-ink-soft">
                  <tr><th className="px-2 py-1 text-left">SKU</th><th className="px-2 py-1 text-right">Costo anterior</th><th className="px-2 py-1 text-right">Costo final</th><th className="px-2 py-1 text-right">Existencia</th><th className="px-2 py-1 text-right">Cambio en inventario</th><th className="px-2 py-1 text-right">Ya salió</th></tr>
                </thead>
                <tbody>
                  {changed.map((x) => (
                    <tr key={x.skuCode + x.lotCode} className="border-t border-line">
                      <td className="px-2 py-1 font-mono">{x.skuCode}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtCost(x.oldCost)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtCost(x.newCost)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtInt(x.onHand + x.inTransit)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(Number(x.deltaOnHand) + Number(x.deltaInTransit))}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtInt(x.consumed)} pzas · {fmtMoney(x.deltaConsumed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
