import { isModuleKey, missingDependencies, MODULE_KEYS, MODULES, type ModuleKey, type ModuleOverride } from '@pos/shared';

export interface ModuleRow {
  key: ModuleKey;
  name: string;
  requires: string[];
  inBase: boolean;
  /** null = follows the business type. */
  override: boolean | null;
  resolved: boolean;
  /** Wanted (by base or override) but dropped because these dependencies are off. */
  droppedFor: string[];
  locked: boolean;
}

export function moduleRows(base: readonly string[], overrides: readonly ModuleOverride[], resolved: readonly string[]): ModuleRow[] {
  const baseSet = new Set(base);
  const resolvedSet = new Set(resolved);
  const overrideOf = new Map(overrides.filter((o) => isModuleKey(o.moduleKey)).map((o) => [o.moduleKey, o.enabled]));
  return MODULE_KEYS.map((key) => {
    const override = overrideOf.has(key) ? overrideOf.get(key)! : null;
    const wanted = key === 'core' || (override ?? baseSet.has(key));
    const requires = [...MODULES[key].requires] as string[];
    const isResolved = resolvedSet.has(key);
    return {
      key,
      name: MODULES[key].name,
      requires,
      inBase: baseSet.has(key),
      override,
      resolved: isResolved,
      droppedFor: wanted && !isResolved ? requires.filter((d) => !resolvedSet.has(d)) : [],
      locked: key === 'core',
    };
  });
}

/** Unmet dependencies of a module selection, as sentences. */
export function dependencyIssues(keys: readonly string[]): string[] {
  const set = new Set<ModuleKey>(['core', ...keys.filter(isModuleKey)]);
  return missingDependencies(set).map((m) => `${MODULES[m.module].name} needs ${MODULES[m.requires].name}`);
}
