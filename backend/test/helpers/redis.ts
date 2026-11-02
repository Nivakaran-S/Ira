import { Redis } from 'ioredis';

export async function flushRedis(): Promise<void> {
  const r = new Redis(process.env.REDIS_URL!);
  await r.flushdb();
  await r.quit();
}
