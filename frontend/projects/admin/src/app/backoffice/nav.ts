export interface NavItem {
  path: string;
  label: string;
  /** Shown when the user holds any of these; empty = always. UX only: the API enforces. */
  anyOf: string[];
  /** Shown only when this module is on for the tenant. */
  module?: string;
}

const ITEMS: NavItem[] = [
  { path: '/', label: 'Overview', anyOf: [] },
  { path: '/reports', label: 'Reports', anyOf: ['report.view'] },
  { path: '/insights', label: 'Insights', anyOf: ['report.view'] },
  { path: '/sales', label: 'Sales', anyOf: ['report.view'] },
  { path: '/shifts', label: 'Shifts', anyOf: ['report.view'] },
  { path: '/catalog', label: 'Catalog', anyOf: ['catalog.manage'] },
  { path: '/taxes', label: 'Taxes', anyOf: ['catalog.manage'] },
  { path: '/stock', label: 'Stock', anyOf: ['stock.adjust'] },
  { path: '/customers', label: 'Customers', anyOf: ['customer.manage'], module: 'customers' },
  { path: '/promotions', label: 'Promotions', anyOf: ['promotion.manage'], module: 'promotions' },
  { path: '/modifiers', label: 'Modifiers', anyOf: ['catalog.manage'], module: 'modifiers' },
  { path: '/tables', label: 'Tables', anyOf: ['table.manage'], module: 'tables' },
  { path: '/lots', label: 'Lots and expiry', anyOf: ['stock.adjust'], module: 'batch-expiry' },
  { path: '/purchasing', label: 'Purchasing', anyOf: ['purchasing.manage'], module: 'purchasing' },
  { path: '/transfers', label: 'Transfers', anyOf: ['stock.transfer'], module: 'multi-store' },
  { path: '/store-prices', label: 'Store prices', anyOf: ['catalog.manage'], module: 'multi-store' },
  { path: '/stores', label: 'Stores', anyOf: ['store.manage'] },
  { path: '/registers', label: 'Registers', anyOf: ['register.manage'] },
  { path: '/roles', label: 'Roles', anyOf: ['role.manage'] },
  { path: '/users', label: 'Users', anyOf: ['user.manage'] },
  { path: '/devices', label: 'Devices', anyOf: ['device.enroll', 'device.revoke'] },
  { path: '/offline-review', label: 'Offline review', anyOf: ['sync.review'] },
  { path: '/audit', label: 'Audit log', anyOf: ['audit.view'] },
  { path: '/settings', label: 'Settings', anyOf: ['settings.manage'] },
  { path: '/billing', label: 'Plan and billing', anyOf: ['billing.view'] },
];

export function navItems(permissions: ReadonlySet<string>, modules: readonly string[] = []): NavItem[] {
  return ITEMS.filter((i) => (i.anyOf.length === 0 || i.anyOf.some((p) => permissions.has(p))) && (!i.module || modules.includes(i.module)));
}
