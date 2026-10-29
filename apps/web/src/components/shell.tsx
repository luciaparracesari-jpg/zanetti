'use client';

import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronDown, ChevronRight, KeyRound, LogOut, Menu, Search, User, X } from 'lucide-react';
import { get, post } from '@/lib/api';
import { ENTREGA_LABEL, NAV, type NavSection } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { cx } from './ui';

// ───────────────────────────── Menú lateral ─────────────────────────────

function SectionLinks({ section, pathname, onNavigate }: { section: NavSection; pathname: string; onNavigate: () => void }) {
  const { can } = useSession();
  const items = (section.items ?? []).filter((i) => !i.perm || can(i.perm));
  const base = (h: string) => h.split('?')[0];
  const matches = (h: string) => pathname === base(h) || pathname.startsWith(`${base(h)}/`);
  // La liga activa es la más específica (Existencias = /inventario no se enciende en /inventario/ajustes).
  const activeHref = items
    .filter((i) => !i.entrega && matches(i.href))
    .sort((a, b) => base(b.href).length - base(a.href).length)[0]?.href;
  const containsActive = Boolean(activeHref);
  const [open, setOpen] = useState(containsActive);
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);
  if (!items.length) return null;
  const Icon = section.icon;
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className={cx(
          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-side-hover',
          containsActive ? 'text-white' : 'text-side-ink',
        )}
        aria-expanded={open}
      >
        <Icon className="h-4 w-4 shrink-0 opacity-80" />
        <span className="flex-1">{section.label}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 opacity-60" /> : <ChevronRight className="h-3.5 w-3.5 opacity-60" />}
      </button>
      {open && (
        <div className="pb-1">
          {items.map((i) => {
            const active = i.href === activeHref;
            return (
              <Link
                key={i.href}
                href={i.href}
                onClick={onNavigate}
                className={cx(
                  'flex items-center gap-2 py-1 pr-3 pl-9 text-[13px]',
                  active ? 'bg-side-active text-white' : i.entrega ? 'text-side-faint hover:bg-side-hover' : 'text-side-ink hover:bg-side-hover hover:text-white',
                )}
              >
                <span className="flex-1 truncate">{i.label}</span>
                {i.entrega && <span className="rounded bg-side-hover px-1 text-[10.5px] text-side-faint">{ENTREGA_LABEL(i.entrega)}</span>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { can } = useSession();
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={onClose} />}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-side transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-12 items-center justify-between border-b border-white/10 px-3">
          <Link href="/dashboard" className="text-sm font-semibold tracking-wide text-white">
            ERP ECOMMERCE
          </Link>
          <button className="text-side-ink lg:hidden" onClick={onClose} aria-label="Cerrar menú">
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="scroll-thin flex-1 overflow-y-auto py-2">
          {NAV.map((s) =>
            s.href ? (
              (!s.perm || can(s.perm)) && (
                <Link
                  key={s.label}
                  href={s.href}
                  onClick={onClose}
                  className={cx(
                    'flex items-center gap-2 px-3 py-1.5 text-sm',
                    pathname.startsWith(s.href) ? 'bg-side-active text-white' : 'text-side-ink hover:bg-side-hover',
                  )}
                >
                  <s.icon className="h-4 w-4 opacity-80" />
                  {s.label}
                </Link>
              )
            ) : (
              <SectionLinks key={s.label} section={s} pathname={pathname} onNavigate={onClose} />
            ),
          )}
        </nav>
        <div className="border-t border-white/10 px-3 py-2 text-[11px] text-side-faint">Sistema Integral de Operaciones · v0.1</div>
      </aside>
    </>
  );
}

// ───────────────────────────── Búsqueda global ─────────────────────────────

interface SearchGroup {
  module: string;
  label: string;
  hits: { id: string; title: string; subtitle?: string | null; href: string }[];
}

function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  // Ctrl/Cmd + K abre la búsqueda desde cualquier pantalla.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const res = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => get<SearchGroup[]>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });
  const flat = (res.data ?? []).flatMap((g) => g.hits);

  function go(href: string) {
    setOpen(false);
    setQ('');
    router.push(href);
  }

  return (
    <div className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute top-2 left-2.5 h-4 w-4 text-ink-faint" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setCursor(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, flat.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
          if (e.key === 'Enter' && flat[cursor]) go(flat[cursor].href);
          if (e.key === 'Escape') { setOpen(false); ref.current?.blur(); }
        }}
        placeholder="Buscar SKU, código de barras, ASIN, proveedor…"
        className="h-8 w-full rounded border border-line-strong bg-page pr-14 pl-8 text-sm focus:border-brand focus:bg-panel focus:outline-none"
        aria-label="Búsqueda global"
      />
      <kbd className="pointer-events-none absolute top-1.5 right-2 hidden rounded border border-line-strong bg-panel px-1 text-[10.5px] text-ink-faint sm:block">Ctrl K</kbd>
      {open && debounced.length >= 2 && (
        <div className="absolute z-30 mt-1 max-h-[70vh] w-full overflow-y-auto rounded border border-line bg-panel py-1 shadow-lg">
          {res.isLoading && <div className="px-3 py-2 text-sm text-ink-soft">Buscando…</div>}
          {!res.isLoading && flat.length === 0 && <div className="px-3 py-2 text-sm text-ink-soft">Sin resultados para “{debounced}”.</div>}
          {(res.data ?? []).map((g) => (
            <div key={g.module}>
              <div className="px-3 pt-2 pb-0.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">{g.label}</div>
              {g.hits.map((h) => {
                const idx = flat.indexOf(h);
                return (
                  <button
                    key={h.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(h.href)}
                    className={cx('flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm', idx === cursor ? 'bg-brand-soft' : 'hover:bg-page')}
                  >
                    <span className="font-medium">{h.title}</span>
                    {h.subtitle && <span className="truncate text-xs text-ink-soft">{h.subtitle}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Barra superior ─────────────────────────────

function Notifications() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const summary = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: () => get<{ codigosSinMapear: number }>('/dashboard/summary'),
    enabled: can('dashboard.ver'),
    refetchInterval: 120_000,
  });
  const pending = summary.data?.codigosSinMapear ?? 0;
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="relative rounded p-1.5 text-ink-soft hover:bg-page" aria-label="Notificaciones">
        <Bell className="h-4.5 w-4.5" />
        {pending > 0 && <span className="absolute -top-0.5 -right-0.5 rounded-full bg-bad px-1 text-[10px] leading-4 font-semibold text-white">{pending}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 rounded border border-line bg-panel py-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <div className="border-b border-line px-3 py-1.5 text-xs font-semibold text-ink-soft">Alertas</div>
          {pending > 0 ? (
            <Link href="/productos/sin-mapear" className="block px-3 py-2 text-sm hover:bg-page" onClick={() => setOpen(false)}>
              <span className="font-medium text-warn">{pending} códigos sin mapear</span>
              <div className="text-xs text-ink-soft">Ventas que no descuentan inventario hasta ligarlas a un SKU.</div>
            </Link>
          ) : (
            <div className="px-3 py-2 text-sm text-ink-soft">Sin alertas.</div>
          )}
          <div className="border-t border-line px-3 py-1.5 text-xs text-ink-faint">Las alertas de stock y reabasto llegan en la entrega 5.</div>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  async function logout() {
    try {
      await post('/auth/logout');
    } finally {
      window.location.href = '/login';
    }
  }
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded px-2 py-1 text-sm hover:bg-page">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-soft text-brand">
          <User className="h-3.5 w-3.5" />
        </span>
        <span className="hidden max-w-36 truncate sm:inline">{me.name}</span>
        <ChevronDown className="h-3.5 w-3.5 text-ink-faint" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 rounded border border-line bg-panel py-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <div className="border-b border-line px-3 py-1.5">
            <div className="truncate text-sm font-medium">{me.name}</div>
            <div className="truncate text-xs text-ink-soft">{me.email}</div>
            <div className="text-xs text-ink-faint">{me.roles.join(', ')}</div>
          </div>
          <Link href="/cambiar-contrasena" className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-page">
            <KeyRound className="h-3.5 w-3.5" /> Cambiar contraseña
          </Link>
          <button onClick={logout} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-bad hover:bg-page">
            <LogOut className="h-3.5 w-3.5" /> Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar open={menu} onClose={() => setMenu(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
          <button className="rounded p-1 text-ink-soft hover:bg-page lg:hidden" onClick={() => setMenu(true)} aria-label="Abrir menú">
            <Menu className="h-5 w-5" />
          </button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1">
            <Notifications />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-3 sm:p-4">
          <Suspense>{children}</Suspense>
        </main>
      </div>
    </div>
  );
}
