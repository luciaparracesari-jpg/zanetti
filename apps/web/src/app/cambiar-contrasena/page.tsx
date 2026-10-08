'use client';

import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import type { Me } from '@/lib/session';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { useState } from 'react';

interface FormValues {
  currentPassword: string;
  newPassword: string;
  confirm: string;
}

export default function ChangePasswordPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/auth/me') });
  const { register, handleSubmit, setError, formState } = useForm<FormValues>();
  const [msg, setMsg] = useState<string | null>(null);

  async function onSubmit(v: FormValues) {
    setMsg(null);
    if (v.newPassword !== v.confirm) {
      setError('confirm', { message: 'No coincide con la nueva contraseña' });
      return;
    }
    try {
      await post('/auth/password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
      window.location.href = '/dashboard';
    } catch (err) {
      setMsg(applyServerErrors(err, setError));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded border border-line bg-panel shadow-sm">
        <div className="border-b border-line px-5 py-3">
          <h1 className="text-base font-semibold">Cambiar contraseña</h1>
          {me.data?.mustChangePassword && (
            <p className="mt-1 text-sm text-warn">Por seguridad, define una contraseña nueva antes de continuar.</p>
          )}
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3 p-5">
          {msg && <ErrorBox error={msg} />}
          <Field label="Contraseña actual" error={formState.errors.currentPassword?.message}>
            <Input type="password" autoComplete="current-password" {...register('currentPassword', { required: 'Requerido' })} />
          </Field>
          <Field label="Nueva contraseña" hint="Mínimo 10 caracteres, con letras y números." error={formState.errors.newPassword?.message}>
            <Input type="password" autoComplete="new-password" {...register('newPassword', { required: 'Requerido' })} />
          </Field>
          <Field label="Confirmar nueva contraseña" error={formState.errors.confirm?.message}>
            <Input type="password" autoComplete="new-password" {...register('confirm', { required: 'Requerido' })} />
          </Field>
          <div className="mt-1 flex justify-between gap-2">
            {!me.data?.mustChangePassword && (
              <Button onClick={() => history.back()}>Cancelar</Button>
            )}
            <Button type="submit" variant="primary" loading={formState.isSubmitting} className="ml-auto">
              Guardar contraseña
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
