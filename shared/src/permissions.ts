export const PERMISSIONS = [
  'store.manage',
  'register.manage',
  'user.manage',
  'role.manage',
  'device.enroll',
  'device.revoke',
  'audit.view',
  'sale.create',
  'sale.void',
  'sale.refund',
  'price.override',
  'discount.apply',
  'drawer.open',
  'shift.close',
  'stock.adjust',
  'report.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
