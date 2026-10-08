'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { post } from '@/lib/api';
import { Button, ErrorBox, Field, Input } from '@/components/ui';

function LoginForm() {
  const sp = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await post<{ mustChangePassword: boolean }>('/auth/login', { email, password });
      const next = sp.get('next');
      const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
      window.location.href = r.mustChangePassword ? '/cambiar-contrasena' : safeNext;
    } catch (err) {
      setError(err);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <ErrorBox error={error} />
      <Field label="Correo">
        <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </Field>
      <Field label="Contraseña">
        <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </Field>
      <Button type="submit" variant="primary" loading={loading} className="mt-1 w-full">
        Iniciar sesión
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded border border-line bg-panel shadow-sm">
        <div className="border-b border-line bg-side px-5 py-4">
          <div className="text-sm font-semibold tracking-wide text-white">ERP ECOMMERCE</div>
          <div className="text-xs text-side-ink">Sistema Integral de Operaciones</div>
        </div>
        <div className="p-5">
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
