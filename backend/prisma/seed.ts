import { PrismaPg } from '@prisma/adapter-pg';
import { BusinessTypeSchema } from '@pos/shared';
import { type Prisma, PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_OWNER_URL! }) });

const cashier = { name: 'Cashier', permissions: ['sale.create', 'drawer.open'], requiresMfa: false };
const manager = {
  name: 'Manager',
  permissions: [
    'sale.create', 'sale.void', 'sale.refund', 'price.override', 'discount.apply', 'drawer.open',
    'shift.close', 'stock.adjust', 'report.view', 'device.enroll', 'register.manage',
  ],
  requiresMfa: true,
};

const businessTypes = [
  { key: 'retail', name: 'Retail', modules: ['core', 'customers', 'variants', 'barcodes', 'promotions', 'loyalty'] },
  { key: 'cafe', name: 'Café / Restaurant', modules: ['core', 'customers', 'tables', 'modifiers', 'kitchen-display', 'split-bill'] },
  { key: 'grocery', name: 'Grocery', modules: ['core', 'customers', 'barcodes', 'promotions', 'weighed-items'] },
  { key: 'pharmacy', name: 'Pharmacy', modules: ['core', 'customers', 'barcodes', 'batch-expiry', 'prescriptions'] },
];

await prisma.plan.upsert({
  where: { key: 'standard' },
  update: {},
  create: { key: 'standard', name: 'Standard', maxStores: 3, maxDevices: 10, maxUsers: 25 },
});

for (const raw of businessTypes) {
  const bt = BusinessTypeSchema.parse({ ...raw, roleTemplates: [manager, cashier] });
  await prisma.businessType.upsert({
    where: { key: bt.key },
    update: {},
    create: {
      key: bt.key,
      name: bt.name,
      modules: bt.modules,
      roleTemplates: bt.roleTemplates as Prisma.InputJsonArray,
      defaultSettings: bt.defaultSettings as Prisma.InputJsonObject,
    },
  });
}

await prisma.$disconnect();
console.log('Seeded plan "standard" and business types:', businessTypes.map((b) => b.key).join(', '));
