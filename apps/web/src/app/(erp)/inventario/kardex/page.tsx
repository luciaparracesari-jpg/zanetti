'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { fmtInt, fmtMoney } from '@/lib/format';
import { useWarehouses } from '@/lib/inventory';
import { useSession } from '@/lib/session';
import { AsyncCombobox } from '@/components/combobox';
import { DataTable, type Column } from '@/components/data-table';
import { StockQty, TotalsBar } from '@/components/inventory';
import { DateRange, useUrlParams } from '@/components/url-controls';
import { Empty, Field, PageHeader, Panel, Select } from '@/components/ui';
import { movementColumns, type MovementRow } from '@/components/movement-columns';

interface Summary {
  openingQty: number;
  ins: number;
  outs: number;
  closingQty: number;
  openingValue?: string;
  closingValue?: string;
}

export default function KardexPage() {
  const { can } = useSession();
  const costs = can('costos.ver');
  const u = useUrlParams();
  const skuId = u.get('skuId');
  const whs = useWarehouses();
  const sku = useQuery({
    queryKey: ['sku', skuId],
    queryFn: () => get<{ id: string; skuCode: string; name: string }>(`/skus/${skuId}`),
    enabled: Boolean(skuId),
  });

  const columns: Column<MovementRow>[] = [
    ...movementColumns(costs, { showSku: false, sortable: false }),
    { id: 'balance', header: 'Saldo', align: 'right', cell: (r) => <StockQty value={r.balance ?? 0} strong />, csv: (r) => r.balance },
    ...(costs ? ([{ id: 'balanceValue', header: 'Saldo valor', align: 'right', cell: (r) => fmtMoney(r.balanceValue), csv: (r) => r.balanceValue }] as Column<MovementRow>[]) : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Kardex' }]}
        title="Kardex"
        subtitle="Historia de un SKU con su saldo después de cada movimiento. Del más reciente al más antiguo."
        actions={skuId && sku.data ? <Link href={`/productos/skus/${skuId}?tab=inventario`} className="text-sm text-brand hover:underline">Ver ficha de {sku.data.skuCode}</Link> : null}
      />
      <Panel className="mb-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(16rem,24rem)_14rem_auto] sm:items-end">
          <Field label="SKU maestro" required>
            <AsyncCombobox<{ id: string; skuCode: string; name: string; isKit: boolean }>
              value={skuId || null}
              initialLabel={sku.data?.skuCode ?? null}
              onChange={(v) => u.set({ skuId: v })}
              fetchPath="/skus/options"
              map={(s) => ({ value: s.id, label: s.skuCode, hint: `${s.isKit ? 'Kit · ' : ''}${s.name}` })}
              placeholder="Buscar SKU…"
            />
          </Field>
          <Field label="Almacén">
            <Select value={u.get('warehouseId')} onChange={(e) => u.set({ warehouseId: e.target.value })}>
              <option value="">Todos los almacenes</option>
              {(whs.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
              ))}
            </Select>
          </Field>
          <div className="pb-0.5"><DateRange /></div>
        </div>
      </Panel>
      {!skuId ? (
        <Panel><Empty>Elige un SKU para ver su kardex.</Empty></Panel>
      ) : (
        <DataTable<MovementRow>
          tableKey="kardex"
          endpoint="/inventory/kardex"
          columns={columns}
          rowId={(r) => String(r.id)}
          searchable={false}
          urlParams={['skuId', 'warehouseId', 'from', 'to']}
          exportPerm="inventario.exportar"
          exportName={`kardex-${sku.data?.skuCode ?? 'sku'}`}
          emptyText="Sin movimientos en el periodo."
          summary={(d) => {
            const s = d.summary as Summary | undefined;
            if (!s) return null;
            return (
              <TotalsBar
                items={[
                  { label: 'Saldo inicial', value: fmtInt(s.openingQty) },
                  { label: 'Entradas', value: s.ins ? `+${fmtInt(s.ins)}` : '0' },
                  { label: 'Salidas', value: s.outs ? `−${fmtInt(s.outs)}` : '0' },
                  { label: 'Saldo final', value: fmtInt(s.closingQty), tone: s.closingQty < 0 ? 'bad' : undefined },
                  ...(s.closingValue !== undefined ? [{ label: 'Valor inicial', value: fmtMoney(s.openingValue) }, { label: 'Valor final', value: fmtMoney(s.closingValue) }] : []),
                ]}
              />
            );
          }}
        />
      )}
    </>
  );
}
