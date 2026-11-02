import type { Response } from 'express';
import { REFRESH_ABSOLUTE_MS } from './session.service.js';

export const REFRESH_COOKIE = 'pos_rt';
export const TENANT_COOKIE_PATH = '/api/auth';
export const PLATFORM_COOKIE_PATH = '/api/platform/auth';

const base = { httpOnly: true, secure: true, sameSite: 'strict' as const };

export function setRefreshCookie(res: Response, token: string, path: string) {
  res.cookie(REFRESH_COOKIE, token, { ...base, path, maxAge: REFRESH_ABSOLUTE_MS });
}

export function clearRefreshCookie(res: Response, path: string) {
  res.clearCookie(REFRESH_COOKIE, { ...base, path });
}
