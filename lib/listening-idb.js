/**
 * Browser IndexedDB storage for per-user listening history
 * ({ userId, version, syncedEntries, pendingDelta, updatedAt }).
 * Falls back gracefully to in-memory storage when IndexedDB is unavailable.
 */

import { sanitizeListeningEntries } from './listening-shared.js';

const DB_NAME = 'mma_listening_db_v1';
const DB_VERSION = 1;
const STORE_NAME = 'user_listening';

const memoryFallback = new Map();
let dbPromise = null;

function normalizeStoredRecord(userId, raw = {}) {
  const ver = Number(raw?.version);
  return {
    userId: String(userId),
    version: Number.isInteger(ver) && ver >= 0 ? ver : 0,
    syncedEntries: sanitizeListeningEntries(raw?.syncedEntries),
    pendingDelta: sanitizeListeningEntries(raw?.pendingDelta),
    updatedAt: Number(raw?.updatedAt) > 0 ? Math.round(Number(raw.updatedAt)) : Date.now()
  };
}

function openListeningDb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'userId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        resolve(null);
      };
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });

  return dbPromise;
}

export async function readListeningStateFromIdb(userId) {
  const key = String(userId || 'offline_local').trim() || 'offline_local';
  const db = await openListeningDb();
  if (!db) {
    return normalizeStoredRecord(key, memoryFallback.get(key));
  }

  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        resolve(normalizeStoredRecord(key, getReq.result));
      };
      getReq.onerror = () => {
        resolve(normalizeStoredRecord(key, memoryFallback.get(key)));
      };
    } catch {
      resolve(normalizeStoredRecord(key, memoryFallback.get(key)));
    }
  });
}

export async function writeListeningStateToIdb(userId, state) {
  const key = String(userId || 'offline_local').trim() || 'offline_local';
  const normalized = normalizeStoredRecord(key, state);
  memoryFallback.set(key, normalized);

  const db = await openListeningDb();
  if (!db) return normalized;

  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(normalized);
      tx.oncomplete = () => resolve(normalized);
      tx.onerror = () => resolve(normalized);
    } catch {
      resolve(normalized);
    }
  });
}
