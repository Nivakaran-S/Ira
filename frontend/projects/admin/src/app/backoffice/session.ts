import { computed, inject, Injectable } from '@angular/core';
import { apiResource } from 'ui';
import { BackofficeApi } from './backoffice-api';

/** Who is signed in and what they may do. Provided by BackofficeLayout, so each sign-in gets a fresh instance. */
@Injectable()
export class BackofficeSession {
  private readonly api = inject(BackofficeApi);
  readonly me = apiResource({ loader: () => this.api.me() });
  readonly caps = apiResource({ loader: () => this.api.capabilities() });
  readonly permissions = computed(() => new Set(this.caps.value()?.permissions ?? []));
  readonly modules = computed(() => this.caps.value()?.modules ?? []);

  can(permission: string) {
    return this.permissions().has(permission);
  }

  reload() {
    this.me.reload();
    this.caps.reload();
  }
}
