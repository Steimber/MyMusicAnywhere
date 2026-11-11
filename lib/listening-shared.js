/**
 * Pure isomorphic utilities for MyMusicAnywhere listening history
 * (safe for both browser client and Node.js server/tests).
 */

export const HOUR_BUCKETS = ['madrugada', 'manana', 'tarde', 'noche'];
export const MAX_LISTENING_ENTRIES = 10000;

export function getHourBucketName(dateOrHour = new Date()) {
  const hour =
    typeof dateOrHour === 'number' && Number.isFinite(dateOrHour)
      ? ((Math.floor(dateOrHour) % 24) + 24) % 24
      : dateOrHour instanceof Date && !Number.isNaN(dateOrHour.getTime())
      ? dateOrHour.getHours()
      : new Date().getHours();

  if (hour >= 6 && hour <= 11) return 'manana';
  if (hour >= 12 && hour <= 18) return 'tarde';
  if (hour >= 19 && hour <= 23) return 'noche';
  return 'madrugada';
}

function toSafeCounter(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1_000_000, Math.floor(n));
}

export function createEmptyHourBuckets() {
  return {
    madrugada: 0,
    manana: 0,
    tarde: 0,
    noche: 0
  };
}

export function normalizeHourBuckets(raw) {
  const base = createEmptyHourBuckets();
  if (!raw || typeof raw !== 'object') return base;
  for (const slot of HOUR_BUCKETS) {
    base[slot] = toSafeCounter(raw[slot]);
  }
  // Support accented alias 'mañana' if ever passed externally
  if (raw['mañana'] !== undefined) {
    base.manana += toSafeCounter(raw['mañana']);
  }
  return base;
}

export function normalizeListeningEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      plays: 0,
      skips: 0,
      completes: 0,
      lastPlayedAt: 0,
      hourBuckets: createEmptyHourBuckets()
    };
  }
  const lastPlayedNum = Number(raw.lastPlayedAt);
  return {
    plays: toSafeCounter(raw.plays),
    skips: toSafeCounter(raw.skips),
    completes: toSafeCounter(raw.completes),
    lastPlayedAt:
      Number.isFinite(lastPlayedNum) && lastPlayedNum > 0 ? Math.round(lastPlayedNum) : 0,
    hourBuckets: normalizeHourBuckets(raw.hourBuckets)
  };
}

function isNonZeroEntry(entry) {
  if (!entry) return false;
  if (entry.plays > 0 || entry.skips > 0 || entry.completes > 0 || entry.lastPlayedAt > 0) {
    return true;
  }
  return HOUR_BUCKETS.some(slot => entry.hourBuckets[slot] > 0);
}

export function sanitizeListeningEntries(rawEntries) {
  if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
    return {};
  }
  const result = {};
  let count = 0;
  for (const [rawKey, rawVal] of Object.entries(rawEntries)) {
    if (count >= MAX_LISTENING_ENTRIES) break;
    const key = String(rawKey || '')
      .replace(/[\u0000-\u001f\u007f]+/g, '')
      .trim()
      .slice(0, 120);
    if (!key) continue;
    const normalized = normalizeListeningEntry(rawVal);
    if (!isNonZeroEntry(normalized)) continue;
    result[key] = normalized;
    count += 1;
  }
  return result;
}

export function mergeTwoListeningEntries(entryA, entryB) {
  const a = normalizeListeningEntry(entryA);
  const b = normalizeListeningEntry(entryB);
  const hourBuckets = createEmptyHourBuckets();
  for (const slot of HOUR_BUCKETS) {
    hourBuckets[slot] = toSafeCounter(a.hourBuckets[slot] + b.hourBuckets[slot]);
  }
  return {
    plays: toSafeCounter(a.plays + b.plays),
    skips: toSafeCounter(a.skips + b.skips),
    completes: toSafeCounter(a.completes + b.completes),
    lastPlayedAt: Math.max(a.lastPlayedAt, b.lastPlayedAt),
    hourBuckets
  };
}

/**
 * Merges two listening-history maps by summing counters (plays, skips, completes, hourBuckets)
 * and retaining the most recent lastPlayedAt timestamp per song.
 */
export function mergeListeningEntries(entriesA = {}, entriesB = {}) {
  const safeA = sanitizeListeningEntries(entriesA);
  const safeB = sanitizeListeningEntries(entriesB);
  const allKeys = new Set([...Object.keys(safeA), ...Object.keys(safeB)]);
  const merged = {};

  for (const key of allKeys) {
    if (safeA[key] && safeB[key]) {
      merged[key] = mergeTwoListeningEntries(safeA[key], safeB[key]);
    } else {
      merged[key] = normalizeListeningEntry(safeA[key] || safeB[key]);
    }
  }
  return merged;
}

export function applyListeningDeltaToMap(entries = {}, trackId, delta = {}) {
  const key = String(trackId || '').trim().slice(0, 120);
  if (!key) return entries;
  const current = normalizeListeningEntry(entries[key]);
  const addPlays = toSafeCounter(delta.plays);
  const addSkips = toSafeCounter(delta.skips);
  const addCompletes = toSafeCounter(delta.completes);
  const nextBuckets = { ...current.hourBuckets };

  if (delta.hourBucket && HOUR_BUCKETS.includes(delta.hourBucket)) {
    nextBuckets[delta.hourBucket] = toSafeCounter(
      nextBuckets[delta.hourBucket] + Math.max(1, addPlays || 1)
    );
  } else if (delta.hourBuckets && typeof delta.hourBuckets === 'object') {
    const extra = normalizeHourBuckets(delta.hourBuckets);
    for (const slot of HOUR_BUCKETS) {
      nextBuckets[slot] = toSafeCounter(nextBuckets[slot] + extra[slot]);
    }
  }

  const ts = Number(delta.lastPlayedAt);
  const nextLastPlayed =
    Number.isFinite(ts) && ts > 0 ? Math.max(current.lastPlayedAt, Math.round(ts)) : current.lastPlayedAt;

  return {
    ...entries,
    [key]: {
      plays: toSafeCounter(current.plays + addPlays),
      skips: toSafeCounter(current.skips + addSkips),
      completes: toSafeCounter(current.completes + addCompletes),
      lastPlayedAt: nextLastPlayed,
      hourBuckets: nextBuckets
    }
  };
}

export function computeTotalPlays(entries = {}) {
  if (!entries || typeof entries !== 'object') return 0;
  let total = 0;
  for (const val of Object.values(entries)) {
    total += toSafeCounter(val?.plays);
  }
  return total;
}
