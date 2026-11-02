import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Migrations and seeds run as pos_owner. The app itself connects as pos_app (DATABASE_URL).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: env('DATABASE_OWNER_URL') },
});
