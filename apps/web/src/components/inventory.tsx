'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ScanLine } from 'lucide-react';
import { MOVEMENT_DOCUMENT } from '@erp/shared';
import { documentHref, resolveCode, type Resolved } from '@/lib/inventory';
import { fmtInt } from '@/lib/format';
import { Input, cx } from './ui';

/** Cantidad con signo: verde entra, rojo sale. */
export function SignedQty({ value }: { value: number }) {
  return (
    <span className={cx('tabular-nums', value > 0 ? 'text-ok' : value < 0 ? 'text-bad' : 'text-ink-faint')}>
      {value > 0 ? '+' : value < 0 ? '−' : ''}
      {fmtInt(Math.abs(value))}
    </span>
  );
}

/** Existencia: en rojo si es negativa, tenue si es cero. */
export function StockQty({ value, strong }: { value: number; strong?: boolean }) {
  return <span className={cx('tabular-nums', value < 0 ? 'font-semibold text-bad' : value === 0 ? 'text-ink-faint' : strong ? 'font-semibold' : '')}>{fmtInt(value)}</span>;
}

export function DocLink({ type, id, folio, line }: { type: string; id: string; folio: string | null; line?: number | null }) {
  const href = documentHref(type, id);
  const label = `${folio ?? MOVEMENT_DOCUMENT[type as keyof typeof MOVEMENT_DOCUMENT] ?? type}${line ? ` · ${line}` : ''}`;
  const title = MOVEMENT_DOCUMENT[type as keyof typeof MOVEMENT_DOCUMENT] ?? type;
  return href ? (
    <Link href={href} className="whitespace-nowrap text-brand hover:underline" title={title}>
      {label}
    </Link>
  ) : (
    <span className="whitespace-nowrap" title={title}>{label}</span>
  );
}

/** Barra de totales dentro de una tabla. */
export function TotalsBar({ items }: { items: { label: string; value: ReactNode; tone?: 'bad' | 'warn' }[] }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-sm">
      {items.map((i) => (
        <div key={i.label} className="flex items-baseline gap-1.5">
          <span className="text-xs text-ink-soft">{i.label}</span>
          <span className={cx('font-semibold tabular-nums', i.tone === 'bad' && 'text-bad', i.tone === 'warn' && 'text-warn')}>{i.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Captura por lector de código de barras o teclado: SKU maestro, UPC/EAN, caja master, ASIN o artículo.
 * Enter resuelve el código; el lector normalmente manda Enter al final.
 */
export function ScanBox({ onResolved, placeholder = 'Escanea o escribe SKU, código de barras o caja master…', className }: { onResolved: (r: Resolved & { code: string }) => void; placeholder?: string; className?: string }) {
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={cx('flex flex-col gap-1', className)}
      onSubmit={async (e) => {
        e.preventDefault();
        const c = code.trim();
        if (!c) return;
        setBusy(true);
        try {
          const r = await resolveCode(c);
          if (!r.sku) setMsg(`No se encontró “${c}”.`);
          else if (r.sku.isKit) setMsg(`${r.sku.skuCode} es un kit: captura sus componentes.`);
          else {
            setMsg(r.packageCode ? `Caja ${r.packageCode}: ${r.units} pzas de ${r.sku.skuCode}` : `${r.sku.skuCode} · ${r.sku.name}`);
            onResolved({ ...r, code: c });
          }
        } catch (err) {
          setMsg((err as Error).message);
        } finally {
          setBusy(false);
          setCode('');
        }
      }}
    >
      <div className="relative">
        <ScanLine className="pointer-events-none absolute top-2 left-2 h-4 w-4 text-ink-faint" />
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={placeholder} className="pl-7 font-mono" disabled={busy} aria-label="Código" />
      </div>
      {msg && <span className="text-xs text-ink-soft">{msg}</span>}
    </form>
  );
}
