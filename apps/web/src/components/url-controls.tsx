'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Input } from './ui';

/** Actualiza parámetros de la URL (la tabla los lee y vuelve a consultar). */
export function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  return {
    get: (k: string) => sp.get(k) ?? '',
    set(patch: Record<string, string | null>) {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (!v) next.delete(k);
        else next.set(k, v);
      }
      next.delete('page');
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
  };
}

/** Rango de fechas Desde / Hasta guardado en la URL como from / to (AAAA-MM-DD). */
export function DateRange() {
  const u = useUrlParams();
  return (
    <div className="flex items-center gap-1 text-xs text-ink-soft">
      <span>Del</span>
      <Input type="date" value={u.get('from')} onChange={(e) => u.set({ from: e.target.value })} className="h-7 w-36 text-xs" aria-label="Desde" />
      <span>al</span>
      <Input type="date" value={u.get('to')} onChange={(e) => u.set({ to: e.target.value })} className="h-7 w-36 text-xs" aria-label="Hasta" />
    </div>
  );
}
