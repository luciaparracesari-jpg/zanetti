'use client';

import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Loader2, X } from 'lucide-react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ───────────────────────────── Botones ─────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white border-brand hover:bg-brand-hover hover:border-brand-hover',
  secondary: 'bg-panel text-ink border-line-strong hover:bg-page',
  ghost: 'bg-transparent text-ink-soft border-transparent hover:bg-page hover:text-ink',
  danger: 'bg-panel text-bad border-line-strong hover:bg-bad-soft hover:border-bad',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }
>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded border font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

// ───────────────────────────── Campos ─────────────────────────────

const fieldBase =
  'w-full rounded border border-line-strong bg-panel px-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:bg-page disabled:text-ink-soft aria-[invalid=true]:border-bad';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(fieldBase, 'h-8', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(fieldBase, 'h-8 pr-6', className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx(fieldBase, 'min-h-16 py-1.5', className)} {...rest} />;
});

export function Field({
  label,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-ink-soft">
        {label}
        {required && <span className="text-bad"> *</span>}
      </span>
      {children}
      {error ? <span className="text-xs text-bad">{error}</span> : hint ? <span className="text-xs text-ink-faint">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-ink">
      <input type="checkbox" className="h-3.5 w-3.5 accent-brand" {...rest} />
      {label}
    </label>
  );
}

// ───────────────────────────── Etiquetas de estado ─────────────────────────────

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
const TONES: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok border-ok/30',
  warn: 'bg-warn-soft text-warn border-warn/30',
  bad: 'bg-bad-soft text-bad border-bad/30',
  info: 'bg-brand-soft text-brand border-brand/30',
  neutral: 'bg-page text-ink-soft border-line-strong',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center rounded border px-1.5 py-px text-xs font-medium leading-4 whitespace-nowrap', TONES[tone], className)}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  ACTIVO: 'ok',
  ACTIVA: 'ok',
  MAPEADO: 'ok',
  BORRADOR: 'info',
  PAUSADO: 'warn',
  PAUSADA: 'warn',
  PENDIENTE: 'warn',
  BLOQUEADO: 'bad',
  DESCONTINUADO: 'neutral',
  INACTIVO: 'neutral',
  INACTIVA: 'neutral',
  IGNORADO: 'neutral',
  // Inventario
  AUTORIZADA: 'info',
  ENVIADA: 'warn',
  RECIBIDA: 'ok',
  RECIBIDA_CON_DIFERENCIAS: 'bad',
  CANCELADA: 'neutral',
  CANCELADO: 'neutral',
  POR_AUTORIZAR: 'warn',
  APLICADO: 'ok',
  ABIERTO: 'info',
  CERRADO: 'ok',
  PROVISIONAL: 'warn',
  FINAL: 'ok',
};

export function StatusBadge({ value, labels }: { value: string; labels: Record<string, string> }) {
  return <Badge tone={STATUS_TONE[value] ?? 'neutral'}>{labels[value] ?? value}</Badge>;
}

// ───────────────────────────── Estructura de página ─────────────────────────────

export function PageHeader({
  title,
  subtitle,
  breadcrumbs,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
  actions?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {breadcrumbs && (
          <nav className="mb-0.5 text-xs text-ink-faint">
            {breadcrumbs.map((b, i) => (
              <span key={i}>
                {i > 0 && ' / '}
                {b.href ? (
                  <a href={b.href} className="hover:text-brand hover:underline">
                    {b.label}
                  </a>
                ) : (
                  b.label
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="truncate text-lg font-semibold text-ink">{title}</h1>
        {subtitle && <p className="text-sm text-ink-soft">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx('rounded border border-line bg-panel', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cx('p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: ReactNode; hidden?: boolean }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="tablist" className="scroll-thin mb-3 flex gap-0.5 overflow-x-auto border-b border-line">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={value === t.value}
            onClick={() => onChange(t.value)}
            className={cx(
              '-mb-px border-b-2 px-3 py-1.5 text-sm whitespace-nowrap',
              value === t.value ? 'border-brand font-semibold text-ink' : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
    </div>
  );
}

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-ink-soft">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-ink-soft">{children}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="rounded border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">{msg}</div>;
}

/** Celda de resumen (ficha de SKU, dashboard). */
export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'brand'; hint?: string }) {
  return (
    <div className={cx('rounded border bg-panel px-3 py-2', tone === 'brand' ? 'border-brand ring-1 ring-brand' : 'border-line')} title={hint}>
      <div className="text-xs text-ink-soft">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-ink tabular-nums">{value}</div>
    </div>
  );
}

// ───────────────────────────── Diálogo ─────────────────────────────

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx(
        'm-auto max-h-[90vh] w-[calc(100%-2rem)] rounded border border-line bg-panel p-0 text-ink shadow-xl',
        width === 'sm' ? 'max-w-md' : width === 'lg' ? 'max-w-4xl' : 'max-w-2xl',
      )}
    >
      {open && (
        <div className="flex max-h-[90vh] flex-col">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-base font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded p-1 text-ink-soft hover:bg-page" aria-label="Cerrar">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="overflow-y-auto px-4 py-3">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-page/60 px-4 py-2.5">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
