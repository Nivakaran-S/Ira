import { Injectable } from '@angular/core';

const DB = 'pos-local';
const VERSION = 1;
export const STORES = ['kv', 'outbox', 'verifiers'] as const;
export type StoreName = (typeof STORES)[number];

interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(store: StoreName, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = work(t.objectStore(store));
        t.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        t.onerror = t.onabort = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
}

/** A non-extractable AES-GCM key: script can encrypt with it, never read it out. */
export function generateDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * The till's offline data (catalog, staff, outbox, PIN verifiers) in IndexedDB, every value sealed
 * with AES-GCM under the device's data key. This protects data copied off the machine, not against
 * code running in the page. Keys (record ids) are not secret and stay in the clear.
 */
@Injectable({ providedIn: 'root' })
export class LocalDb {
  private key: CryptoKey | null = null;

  useKey(key: CryptoKey | null) {
    this.key = key;
  }

  private requireKey(): CryptoKey {
    if (!this.key) throw new Error('Local store is locked: no device data key');
    return this.key;
  }

  private async seal(value: unknown): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.requireKey(), new TextEncoder().encode(JSON.stringify(value)));
    return { iv, ct };
  }

  private async open<T>(sealed: Sealed | undefined): Promise<T | undefined> {
    if (!sealed) return undefined;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, this.requireKey(), sealed.ct);
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  }

  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.open<T>(await run<Sealed | undefined>(store, 'readonly', (s) => s.get(key)));
  }

  async put(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
    const sealed = await this.seal(value);
    await run(store, 'readwrite', (s) => s.put(sealed, key));
  }

  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    await run(store, 'readwrite', (s) => s.delete(key));
  }

  /** Values in key order. */
  async all<T>(store: StoreName, limit?: number): Promise<{ key: IDBValidKey; value: T }[]> {
    const [keys, values] = await Promise.all([
      run<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys(null, limit)),
      run<Sealed[]>(store, 'readonly', (s) => s.getAll(null, limit)),
    ]);
    const out: { key: IDBValidKey; value: T }[] = [];
    for (let i = 0; i < keys.length; i++) out.push({ key: keys[i], value: (await this.open<T>(values[i]))! });
    return out;
  }

  count(store: StoreName): Promise<number> {
    return run<number>(store, 'readonly', (s) => s.count());
  }

  /** Wipes everything, e.g. when the server says this device is revoked. */
  async clear(): Promise<void> {
    for (const s of STORES) await run(s, 'readwrite', (st) => st.clear());
  }
}
