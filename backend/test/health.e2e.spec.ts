import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';

describe('health and error contract', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns ok with a correlation id header', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a well-formed incoming correlation id', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').set('x-correlation-id', 'abc12345-req').expect(200);
    expect(res.headers['x-correlation-id']).toBe('abc12345-req');
  });

  it('replaces a malformed incoming correlation id', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').set('x-correlation-id', 'bad id <script>').expect(200);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unknown routes return the error contract', async () => {
    const res = await request(app.getHttpServer()).get('/api/nope').expect(404);
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: 'Not found', correlationId: res.headers['x-correlation-id'] });
  });

  it('sets security headers', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /api/health/ready checks postgres and redis', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
