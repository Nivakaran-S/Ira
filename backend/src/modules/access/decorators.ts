import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ModuleKey, Permission } from '@pos/shared';

export type RouteRealm = 'tenant' | 'platform' | 'any';

export const REALM_KEY = 'pos:realm';
export const PUBLIC_KEY = 'pos:public';
export const DEVICE_KEY = 'pos:device';
export const MODULE_KEY = 'pos:module';
export const PERMISSION_KEY = 'pos:permission';
export const STEP_UP_KEY = 'pos:step-up';

/** Which host serves this route. Default (no decorator) is 'tenant'. */
export const Realm = (realm: RouteRealm) => SetMetadata(REALM_KEY, realm);
/** Skips user authentication. Realm, tenant status and device checks still apply. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const RequiresDevice = () => SetMetadata(DEVICE_KEY, true);
export const RequiresModule = (key: ModuleKey) => SetMetadata(MODULE_KEY, key);
export const RequiresPermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
export const RequiresStepUp = (action: Permission) => SetMetadata(STEP_UP_KEY, action);

export function routeMeta<T>(reflector: Reflector, key: string, ctx: ExecutionContext): T | undefined {
  return reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
}

export function routeRealm(reflector: Reflector, ctx: ExecutionContext): RouteRealm {
  return routeMeta<RouteRealm>(reflector, REALM_KEY, ctx) ?? 'tenant';
}
