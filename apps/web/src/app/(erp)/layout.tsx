'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { SessionProvider, type Me } from '@/lib/session';
import { AppShell } from '@/components/shell';
import { Spinner } from '@/components/ui';

export default function ErpLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/auth/me'), staleTime: 60_000 });

  useEffect(() => {
    if (me.data?.mustChangePassword) router.replace('/cambiar-contrasena');
  }, [me.data, router]);

  if (!me.data || me.data.mustChangePassword) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner label="Cargando sesión…" />
      </div>
    );
  }
  return (
    <SessionProvider me={me.data}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
