import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@erp/shared';

export const IS_PUBLIC = 'erp:isPublic';
export const AUTH_ONLY = 'erp:authOnly';
export const PERMS = 'erp:perms';
export const ALLOW_PENDING_PASSWORD = 'erp:allowPendingPassword';

/** Ruta sin sesión (sólo login). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Basta con tener sesión (perfil, búsqueda, dashboard). */
export const AuthOnly = () => SetMetadata(AUTH_ONLY, true);

/** Exige todos los permisos indicados. Una ruta sin @Perm ni @AuthOnly se rechaza. */
export const Perm = (...keys: PermissionKey[]) => SetMetadata(PERMS, keys);

/** Permite la ruta aunque el usuario deba cambiar su contraseña. */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);
