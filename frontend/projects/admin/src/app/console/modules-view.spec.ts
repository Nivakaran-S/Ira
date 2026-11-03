import { describe, expect, it } from 'vitest';
import { dependencyIssues, moduleRows } from './modules-view';

describe('moduleRows', () => {
  it('shows base, override and resolved state for every registered module', () => {
    const rows = moduleRows(['core', 'tables', 'split-bill'], [{ moduleKey: 'tables', enabled: false }], ['core']);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['core']).toMatchObject({ inBase: true, override: null, resolved: true, locked: true });
    expect(byKey['tables']).toMatchObject({ inBase: true, override: false, resolved: false });
    // split-bill is in the base but dropped because its dependency (tables) is overridden off
    expect(byKey['split-bill']).toMatchObject({ inBase: true, override: null, resolved: false, droppedFor: ['tables'] });
    expect(byKey['barcodes']).toMatchObject({ inBase: false, override: null, resolved: false, droppedFor: [] });
    expect(rows.length).toBeGreaterThanOrEqual(15);
  });
});

describe('dependencyIssues', () => {
  it('names each unmet dependency in plain words', () => {
    expect(dependencyIssues(['core', 'kitchen-display'])).toEqual(['Kitchen display needs Modifiers']);
    expect(dependencyIssues(['core', 'modifiers', 'kitchen-display'])).toEqual([]);
  });
});
