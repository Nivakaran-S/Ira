export interface NavItem {
  path: string;
  label: string;
  /** Shown when the user holds any of these; empty = always. UX only: the API enforces. */
  anyOf: string[];
}

const ITEMS: NavItem[] = [
  { path: '/', label: 'Overview', anyOf: [] },
  { path: '/reports', label: 'Reports', anyOf: ['report.view'] },
  { path: '/sales', label: 'Sales', anyOf: ['report.view'] },
  { path: '/shifts', label: 'Shifts', anyOf: ['report.view'] },
  { path: '/catalog', label: 'Catalog', anyOf: ['catalog.manage'] },
  { path: '/taxes', label: 'Taxes', anyOf: ['catalog.manage'] },
  { path: '/stock', label: 'Stock', anyOf: ['stock.adjust'] },
  { path: '/stores', label: 'Stores', anyOf: ['store.manage'] },
  { path: '/registers', label: 'Registers', anyOf: ['register.manage'] },
  { path: '/roles', label: 'Roles', anyOf: ['role.manage'] },
  { path: '/users', label: 'Users', anyOf: ['user.manage'] },
  { path: '/devices', label: 'Devices', anyOf: ['device.enroll', 'device.revoke'] },
  { path: '/offline-review', label: 'Offline review', anyOf: ['sync.review'] },
  { path: '/audit', label: 'Audit log', anyOf: ['audit.view'] },
  { path: '/settings', label: 'Settings', anyOf: ['settings.manage'] },
];

export function navItems(permissions: ReadonlySet<string>): NavItem[] {
  return ITEMS.filter((i) => i.anyOf.length === 0 || i.anyOf.some((p) => permissions.has(p)));
}
