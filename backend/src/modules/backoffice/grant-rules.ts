import type { Permission } from '@pos/shared';
import { AppError } from '../../common/errors/app-error.js';

/** You can only hand out authority you hold yourself. */
export function assertCanGrant(actor: Set<Permission>, requested: Iterable<string>): void {
  const missing = [...new Set(requested)].filter((p) => !actor.has(p as Permission));
  if (missing.length) throw new AppError('FORBIDDEN', 403, 'You cannot grant permissions you do not hold', { missing });
}
