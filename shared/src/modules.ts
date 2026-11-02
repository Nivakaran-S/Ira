interface ModuleDef {
  readonly name: string;
  readonly requires: readonly string[];
}

export const MODULES = {
  core: { name: 'Core POS', requires: [] },
  customers: { name: 'Customers', requires: [] },
  variants: { name: 'Product variants', requires: [] },
  barcodes: { name: 'Barcodes & scanning', requires: [] },
  promotions: { name: 'Promotions', requires: [] },
  loyalty: { name: 'Loyalty', requires: ['customers'] },
  tables: { name: 'Tables', requires: [] },
  modifiers: { name: 'Modifiers', requires: [] },
  'kitchen-display': { name: 'Kitchen display', requires: ['modifiers'] },
  'split-bill': { name: 'Split bill', requires: ['tables'] },
  'weighed-items': { name: 'Weighed items', requires: [] },
  'batch-expiry': { name: 'Batch & expiry', requires: [] },
  prescriptions: { name: 'Prescriptions', requires: ['batch-expiry', 'customers'] },
  'multi-store': { name: 'Multi-store', requires: [] },
  purchasing: { name: 'Purchasing', requires: [] },
} as const satisfies Record<string, ModuleDef>;

export type ModuleKey = keyof typeof MODULES;
export const MODULE_KEYS = Object.keys(MODULES) as [ModuleKey, ...ModuleKey[]];

export interface ModuleOverride {
  moduleKey: string;
  enabled: boolean;
}

export function isModuleKey(key: string): key is ModuleKey {
  return Object.hasOwn(MODULES, key);
}

function requiresOf(key: ModuleKey): readonly ModuleKey[] {
  return MODULES[key].requires as readonly ModuleKey[];
}

/** Base set + overrides, without dependency pruning. Always contains core. */
export function applyOverrides(base: readonly string[], overrides: readonly ModuleOverride[] = []): Set<ModuleKey> {
  const set = new Set<ModuleKey>();
  for (const key of base) if (isModuleKey(key)) set.add(key);
  for (const o of overrides) {
    if (!isModuleKey(o.moduleKey)) continue;
    if (o.enabled) set.add(o.moduleKey);
    else set.delete(o.moduleKey);
  }
  set.add('core');
  return set;
}

/** The modules a tenant actually gets: overrides applied, modules with unmet dependencies dropped. */
export function resolveModules(base: readonly string[], overrides: readonly ModuleOverride[] = []): ModuleKey[] {
  const set = applyOverrides(base, overrides);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...set]) {
      if (requiresOf(key).some((dep) => !set.has(dep))) {
        set.delete(key);
        changed = true;
      }
    }
  }
  return [...set].sort();
}

export function missingDependencies(keys: Iterable<ModuleKey>): { module: ModuleKey; requires: ModuleKey }[] {
  const set = new Set(keys);
  const missing: { module: ModuleKey; requires: ModuleKey }[] = [];
  for (const key of set) {
    for (const dep of requiresOf(key)) if (!set.has(dep)) missing.push({ module: key, requires: dep });
  }
  return missing;
}
