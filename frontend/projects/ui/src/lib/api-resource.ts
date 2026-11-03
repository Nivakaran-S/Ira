import { computed, resource, type ResourceLoaderParams, type Signal } from '@angular/core';
import { humanMessage, toApiError } from './api-error';

export interface ApiResource<T> {
  /** The loaded value, or undefined while loading or after an error. Never throws. */
  readonly value: Signal<T | undefined>;
  readonly error: Signal<unknown>;
  /** A sentence for the person, or null when there is no error. */
  readonly errorMessage: Signal<string | null>;
  readonly isLoading: Signal<boolean>;
  reload(): void;
  set(value: T): void;
}

/**
 * Angular's resource() throws when value() is read in the error state. Templates read values freely,
 * so wrap it: value() is safe and the error is surfaced as an ApiError-derived message instead.
 */
export function apiResource<T, P = unknown>(options: { params?: () => P; loader: (p: ResourceLoaderParams<NoInfer<P>>) => Promise<T> }): ApiResource<T> {
  const r = resource<T, P>(options as never);
  return {
    value: computed(() => (r.hasValue() ? r.value() : undefined)),
    error: r.error,
    errorMessage: computed(() => (r.error() ? humanMessage(toApiError(r.error())) : null)),
    isLoading: r.isLoading,
    reload: () => void r.reload(),
    set: (v: T) => r.set(v),
  };
}
