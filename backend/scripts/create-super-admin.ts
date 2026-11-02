import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomToken, sha256Hex } from '../src/common/crypto/hash.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { AuditService } from '../src/modules/audit/audit.service.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email || !values.name) {
  console.error('Usage: npm run platform:create-admin -w backend -- --email you@example.com --name "Your Name"');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_OWNER_URL! }) });
const code = randomToken(24);
const audit = new AuditService();

await prisma.$transaction(async (tx) => {
  const admin = await tx.superAdmin.create({
    data: {
      email: values.email!.toLowerCase(),
      name: values.name!,
      setupTokenHash: sha256Hex(code),
      setupTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000),
    },
  });
  await audit.recordPlatform(tx, { action: 'platform.super_admin_bootstrapped', entityType: 'SuperAdmin', entityId: admin.id });
});
await prisma.$disconnect();

console.log('Super admin created.');
console.log('One-time setup code (valid 24 h, shown only once):');
console.log(code);
console.log(`Set the password with POST https://admin.${process.env.PLATFORM_DOMAIN}/api/platform/auth/setup-password`);
