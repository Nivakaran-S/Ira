import { ApplicationRef, Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error';
import { apiResource } from './api-resource';

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    TestBed.inject(ApplicationRef).tick();
  }
}

describe('apiResource', () => {
  it('exposes the value once loaded', async () => {
    const r = runInInjectionContext(TestBed.inject(Injector), () => apiResource({ loader: async () => [1, 2] }));
    await settle();
    expect(r.value()).toEqual([1, 2]);
    expect(r.errorMessage()).toBeNull();
  });

  it('reads as undefined (never throws) in the error state and offers a human message', async () => {
    const r = runInInjectionContext(TestBed.inject(Injector), () =>
      apiResource<number[]>({
        loader: async () => {
          throw new ApiError(403, 'TENANT_SUSPENDED', 'This account is suspended', undefined, 'c');
        },
      }),
    );
    await settle();
    expect(() => r.value()).not.toThrow();
    expect(r.value()).toBeUndefined();
    expect(r.errorMessage()).toMatch(/suspended/i);
  });
});
