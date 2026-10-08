'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { PermissionKey } from '@erp/shared';

export interface Me {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  warehouseIds: string[] | null;
  mustChangePassword: boolean;
}

const SessionContext = createContext<{ me: Me; can: (k: PermissionKey) => boolean } | null>(null);

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const set = new Set(me.permissions);
  return <SessionContext.Provider value={{ me, can: (k) => set.has(k) }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession fuera de SessionProvider');
  return ctx;
}

/** Muestra el contenido sólo si el usuario tiene el permiso. */
export function Can({ perm, children }: { perm: PermissionKey; children: ReactNode }) {
  const { can } = useSession();
  return can(perm) ? <>{children}</> : null;
}
