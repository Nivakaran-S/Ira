import { describe, expect, it } from 'vitest';
import { MODULES, MODULE_KEYS, missingDependencies, resolveModules } from './modules.js';

describe('module registry', () => {
  it('every dependency refers to a registered module', () => {
    for (const key of MODULE_KEYS) {
      for (const dep of MODULES[key].requires) expect(MODULE_KEYS).toContain(dep);
    }
  });
});

describe('resolveModules', () => {
  it('always includes core', () => {
    expect(resolveModules([])).toEqual(['core']);
  });

  it('applies enable and disable overrides on top of the base set', () => {
    const result = resolveModules(['core', 'tables', 'customers'], [
      { moduleKey: 'tables', enabled: false },
      { moduleKey: 'barcodes', enabled: true },
    ]);
    expect(result).toEqual(['barcodes', 'core', 'customers']);
  });

  it('drops modules whose dependencies are missing', () => {
    // kitchen-display requires modifiers; prescriptions requires batch-expiry + customers
    expect(resolveModules(['kitchen-display', 'prescriptions', 'customers'])).toEqual(['core', 'customers']);
  });

  it('cascades drops through chains of dependencies', () => {
    expect(resolveModules(['tables', 'split-bill'], [{ moduleKey: 'tables', enabled: false }])).toEqual(['core']);
  });

  it('ignores unknown module keys', () => {
    expect(resolveModules(['core', 'teleporter'], [{ moduleKey: 'warp', enabled: true }])).toEqual(['core']);
  });

  it('cannot disable core', () => {
    expect(resolveModules(['core'], [{ moduleKey: 'core', enabled: false }])).toEqual(['core']);
  });
});

describe('missingDependencies', () => {
  it('lists each unmet dependency', () => {
    expect(missingDependencies(['core', 'kitchen-display'])).toEqual([{ module: 'kitchen-display', requires: 'modifiers' }]);
  });
  it('returns empty for a closed set', () => {
    expect(missingDependencies(['core', 'modifiers', 'kitchen-display'])).toEqual([]);
  });
});
