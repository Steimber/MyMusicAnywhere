import fs from 'fs';
import { resolveSafeUserJsonPath, writeJsonFileAtomic } from './store.js';
import { sanitizeListeningEntries } from './listening-shared.js';

export const MAX_LISTENING_BODY_BYTES = 1024 * 1024; // 1 MB hard ceiling

function normalizeListeningFilePayload(raw = {}) {
  const versionNum = Number(raw.version);
  const version = Number.isInteger(versionNum) && versionNum >= 1 ? versionNum : 1;
  const updatedAt = Number(raw.updatedAt) > 0 ? Math.round(Number(raw.updatedAt)) : Date.now();
  const entries = sanitizeListeningEntries(raw.entries);
  return {
    version,
    updatedAt,
    entries
  };
}

export function getUserListeningHistory(userId) {
  const filePath = resolveSafeUserJsonPath('listening', userId);
  if (!filePath) {
    return {
      ok: false,
      status: 400,
      error: 'Identificador de usuario inválido.'
    };
  }

  if (!fs.existsSync(filePath)) {
    return {
      ok: true,
      hasSnapshot: false,
      version: 0,
      updatedAt: null,
      entries: {}
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalized = normalizeListeningFilePayload(raw);
    return {
      ok: true,
      hasSnapshot: true,
      ...normalized
    };
  } catch {
    return {
      ok: true,
      hasSnapshot: false,
      version: 0,
      updatedAt: null,
      entries: {}
    };
  }
}

export function saveUserListeningHistory(userId, payload = {}) {
  const filePath = resolveSafeUserJsonPath('listening', userId);
  if (!filePath) {
    return {
      ok: false,
      status: 400,
      error: 'Identificador de usuario inválido.'
    };
  }

  const current = getUserListeningHistory(userId);
  if (!current.ok) return current;

  const hasBaseVersion = payload.baseVersion !== undefined && payload.baseVersion !== null;

  if (current.hasSnapshot) {
    if (!hasBaseVersion || !Number.isInteger(payload.baseVersion) || payload.baseVersion < 0) {
      return {
        ok: false,
        status: 400,
        error: 'Se requiere baseVersion entero para guardar el historial de escucha.'
      };
    }
    if (payload.baseVersion !== current.version) {
      return {
        ok: false,
        status: 409,
        conflict: true,
        snapshot: current
      };
    }
  } else if (hasBaseVersion) {
    if (!Number.isInteger(payload.baseVersion) || payload.baseVersion < 0) {
      return {
        ok: false,
        status: 400,
        error: 'El campo baseVersion debe ser un entero válido.'
      };
    }
    if (payload.baseVersion !== 0) {
      return {
        ok: false,
        status: 409,
        conflict: true,
        snapshot: current
      };
    }
  }

  const nextEntries =
    payload.entries !== undefined
      ? sanitizeListeningEntries(payload.entries)
      : current.entries;

  const nextVersion = current.version + 1;
  const updatedAt = Date.now();
  const nextDoc = {
    version: nextVersion,
    updatedAt,
    entries: nextEntries
  };

  writeJsonFileAtomic(filePath, nextDoc);

  return {
    ok: true,
    status: 200,
    snapshot: {
      hasSnapshot: true,
      ...nextDoc
    }
  };
}
