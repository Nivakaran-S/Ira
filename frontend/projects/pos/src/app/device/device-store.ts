import { Injectable } from '@angular/core';

export interface DeviceRecord {
  deviceId: string;
  registerId: string;
  name: string;
  /** Non-extractable; IndexedDB stores CryptoKey objects by structured clone without exposing key bytes. */
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** Where this till keeps its identity. */
export abstract class DeviceStore {
  abstract get(): Promise<DeviceRecord | null>;
  abstract save(record: DeviceRecord): Promise<void>;
  abstract clear(): Promise<void>;
}

const DB = 'pos-device';
const STORE = 'device';
const KEY = 'current';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = work(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

@Injectable()
export class IndexedDbDeviceStore extends DeviceStore {
  async get() {
    return ((await tx('readonly', (s) => s.get(KEY))) as DeviceRecord | undefined) ?? null;
  }
  async save(record: DeviceRecord) {
    await tx('readwrite', (s) => s.put(record, KEY));
  }
  async clear() {
    await tx('readwrite', (s) => s.delete(KEY));
  }
}

/** For tests. */
export class MemoryDeviceStore extends DeviceStore {
  private record: DeviceRecord | null = null;
  async get() {
    return this.record;
  }
  async save(record: DeviceRecord) {
    this.record = record;
  }
  async clear() {
    this.record = null;
  }
}
