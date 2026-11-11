/**
 * Pure, deterministic scoring and automatic playlist generator for MyMusicAnywhere ("Para ti").
 * Zero external dependencies; reuses Balanced Dithered Shuffle from ./shuffle.js.
 */

import {
  buildSmartShuffleOrder,
  createArtistKeyResolver,
  getShuffleTrackKey,
  normalizeArtistText
} from './shuffle.js';
import {
  computeTotalPlays,
  getHourBucketName,
  normalizeListeningEntry
} from './listening-shared.js';

export const MIN_AUTOPLAYLIST_SIZE = 15;
export const MAX_AUTOPLAYLIST_SIZE = 40;
export const COLD_START_MIN_PLAYS = 20;
export const MAX_ALLOWED_SKIP_RATE = 0.6;
export const REDISCOVER_MIN_DAYS = 21;
export const MAX_SAME_ARTIST_RATIO = 0.3;

export const COLD_START_MESSAGE =
  'Escucha un poco más y tus playlists irán apareciendo.';

export const IGNORED_TERMS = new Set([
  'offline',
  'youtube',
  'música',
  'musica',
  'music',
  'spotify',
  'spotify csv',
  'offline pwa',
  'guardado en dispositivo',
  'guardado desde servidor',
  'archivo propio',
  'audio subido',
  'mi música',
  'mi musica',
  'audio mp3',
  'artista',
  'desconocido',
  'unknown',
  'unknown artist',
  'varios',
  'various artists',
  'recomendado',
  'single'
]);

const DAY_MS = 24 * 60 * 60 * 1000;

export function isCleanTerm(str) {
  if (!str || typeof str !== 'string') return false;
  const clean = str.trim().toLowerCase();
  if (clean.length < 2) return false;
  if (IGNORED_TERMS.has(clean)) return false;
  if (clean.startsWith('offline_')) return false;
  return true;
}

export function isRealGenre(rawGenre) {
  if (!rawGenre || typeof rawGenre !== 'string') return false;
  const trimmed = rawGenre.trim();
  if (trimmed.length < 2) return false;
  const low = trimmed.toLowerCase();
  if (low === 'offline' || low === 'youtube' || low === 'música' || low === 'musica') {
    return false;
  }
  if (IGNORED_TERMS.has(low)) return false;
  if (low.startsWith('offline_')) return false;
  return true;
}

export function formatLocalDateKey(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Deterministic 32-bit PRNG (FNV-1a seed hash -> Mulberry32).
 */
export function createSeededRng(seedInput = 'mma-default-seed') {
  const str = String(seedInput ?? 'mma-default-seed');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h || 0x6d2b79f5;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getTrackSkipRate(entry) {
  const norm = normalizeListeningEntry(entry);
  const attempts = norm.plays + norm.skips;
  if (attempts <= 0) return 0;
  return norm.skips / attempts;
}

export function isTrackExcludedBySkips(entry) {
  return getTrackSkipRate(entry) > MAX_ALLOWED_SKIP_RATE;
}

export function computeTrackFreshness(lastPlayedAt, now = Date.now()) {
  const ts = Number(lastPlayedAt);
  if (!Number.isFinite(ts) || ts <= 0) return 0.3;
  const ageDays = Math.max(0, (now - ts) / DAY_MS);
  // Smooth half-life around ~10 days in [0, 1]
  return Math.max(0, Math.min(1, Math.exp(-ageDays / 14)));
}

/**
 * Computes intrinsic affinity score (>= 0) for a single song.
 * - Increases with plays, completes, and favorite status (isLiked).
 * - Decreases monotonically as skips increase.
 */
export function scoreTrackAffinity(track, rawEntry, options = {}) {
  const entry = normalizeListeningEntry(rawEntry);
  const likedSet = options.likedIds instanceof Set ? options.likedIds : null;
  const isLiked =
    Boolean(options.isLiked) ||
    (likedSet && track?.id != null && likedSet.has(String(track.id)));

  const playSignal = Math.log1p(entry.plays) * 1.4 + Math.log1p(entry.completes) * 0.65;
  const likeBonus = isLiked ? 1.25 : 0;
  const baseline = 0.4;

  const skipRate = getTrackSkipRate(entry);
  const skipMultiplier = Math.max(0.05, 1 - 0.85 * skipRate);
  const rawScore = (baseline + playSignal + likeBonus) * skipMultiplier - entry.skips * 0.15;

  return Math.max(0, Number(rawScore.toFixed(6)));
}

/**
 * Computes per-artist affinity as the mean of the artist's songs weighted by play count (plays).
 * Falls back to unweighted mean only when an artist has 0 plays across all songs.
 */
export function computeArtistAffinities(tracks = [], listeningEntries = {}, options = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) return new Map();

  const resolveKey = createArtistKeyResolver(tracks);
  const buckets = new Map();

  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    if (!tr) continue;
    const artistKey = resolveKey(i);
    if (!artistKey || !isCleanTerm(artistKey)) continue;

    const entry = normalizeListeningEntry(listeningEntries?.[String(tr.id)]);
    const trackScore = scoreTrackAffinity(tr, entry, options);

    let rec = buckets.get(artistKey);
    if (!rec) {
      const displayName = String(tr.artist || '').split(/\s*(?:feat\.?|ft\.?|featuring)\s*/i)[0].trim();
      rec = {
        artistKey,
        displayName: displayName || artistKey,
        weightedSum: 0,
        totalPlays: 0,
        unweightedSum: 0,
        trackCount: 0
      };
      buckets.set(artistKey, rec);
    }

    rec.weightedSum += trackScore * entry.plays;
    rec.totalPlays += entry.plays;
    rec.unweightedSum += trackScore;
    rec.trackCount += 1;
  }

  const affinities = new Map();
  for (const [artistKey, rec] of buckets.entries()) {
    const affinity =
      rec.totalPlays > 0
        ? rec.weightedSum / rec.totalPlays
        : rec.trackCount > 0
        ? (rec.unweightedSum / rec.trackCount) * 0.5
        : 0;
    affinities.set(artistKey, {
      artistKey,
      displayName: rec.displayName,
      affinity: Number(affinity.toFixed(6)),
      totalPlays: rec.totalPlays,
      trackCount: rec.trackCount
    });
  }

  return affinities;
}

export function getTopAffinityArtists(tracks = [], listeningEntries = {}, options = {}, limit = 6) {
  const map = computeArtistAffinities(tracks, listeningEntries, options);
  return Array.from(map.values())
    .sort((a, b) => {
      if (b.affinity !== a.affinity) return b.affinity - a.affinity;
      if (b.totalPlays !== a.totalPlays) return b.totalPlays - a.totalPlays;
      return a.artistKey.localeCompare(b.artistKey);
    })
    .slice(0, limit);
}

function deduplicateCandidatePool(lists) {
  const out = [];
  const seenIds = new Set();
  const seenTitleArtist = new Set();

  for (const tr of lists) {
    if (!tr || tr.id == null || !tr.title) continue;
    const idStr = String(tr.id).trim();
    if (!idStr || seenIds.has(idStr)) continue;
    const normT = String(tr.title || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    const normA = normalizeArtistText(tr.artist);
    const taKey = normT ? `${normT}|${normA}` : '';
    if (taKey && seenTitleArtist.has(taKey)) continue;

    seenIds.add(idStr);
    if (taKey) seenTitleArtist.add(taKey);
    out.push(tr);
  }
  return out;
}

/**
 * Guarantees zero adjacent same-artist repeats after Balanced Dithered Shuffle
 * whenever mathematically feasible (always true when max per-artist <= 30%).
 */
function orderPlaylistTracksWithSmartShuffle(tracks, rng) {
  if (!Array.isArray(tracks) || tracks.length <= 1) return [...(tracks || [])];
  const indices = buildSmartShuffleOrder(tracks, { rng });
  const ordered = indices.map(i => tracks[i]).filter(Boolean);

  const getKey = createArtistKeyResolver(ordered);
  let hasCollision = false;
  for (let i = 1; i < ordered.length; i++) {
    const kPrev = getKey(i - 1);
    const kCur = getKey(i);
    if (kCur && kCur === kPrev) {
      hasCollision = true;
      break;
    }
  }
  if (!hasCollision) return ordered;

  // Exact lookahead repair preserving buildSmartShuffleOrder's sequence while preventing adjacent repeats
  let unk = 0;
  const remaining = ordered.map((track, idx) => ({
    track,
    key: getKey(idx) || `__u_${unk++}`
  }));
  const counts = new Map();
  for (const item of remaining) {
    counts.set(item.key, (counts.get(item.key) || 0) + 1);
  }

  const result = [];
  let prevKey = '';

  while (remaining.length > 0) {
    const slotsAfter = remaining.length - 1;
    const maxSelfAfter = Math.floor(slotsAfter / 2);
    const maxOtherAfter = Math.ceil(slotsAfter / 2);

    let chosenIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      const candKey = remaining[i].key;
      if (candKey === prevKey) continue;
      if ((counts.get(candKey) || 0) - 1 > maxSelfAfter) continue;

      let feasible = true;
      for (const [k, c] of counts.entries()) {
        if (k === candKey) continue;
        if (c > maxOtherAfter) {
          feasible = false;
          break;
        }
      }
      if (feasible) {
        chosenIdx = i;
        break;
      }
    }

    // Fallback when mathematically unavoidable (e.g. 70% single-artist Mix)
    if (chosenIdx === -1) {
      chosenIdx = remaining.findIndex(item => item.key !== prevKey);
      if (chosenIdx === -1) chosenIdx = 0;
    }

    const [picked] = remaining.splice(chosenIdx, 1);
    const nextCount = (counts.get(picked.key) || 1) - 1;
    if (nextCount <= 0) counts.delete(picked.key);
    else counts.set(picked.key, nextCount);
    result.push(picked.track);
    prevKey = picked.key;
  }

  return result;
}

/**
 * Selects up to `maxCount` ranked items ({ track, artistKey, rankScore }) enforcing
 * `count(artist) <= Math.floor(finalLength * maxArtistRatio)` strictly.
 */
function selectWithArtistCap(rankedItems, { maxCount = MAX_AUTOPLAYLIST_SIZE, maxArtistRatio = MAX_SAME_ARTIST_RATIO } = {}) {
  const initialCap = Math.max(1, Math.floor(maxCount * maxArtistRatio));
  const counts = new Map();
  const selected = [];

  for (const item of rankedItems) {
    if (selected.length >= maxCount) break;
    const key = item.artistKey || `__anon_${item.track.id}`;
    const c = counts.get(key) || 0;
    if (c >= initialCap) continue;
    counts.set(key, c + 1);
    selected.push(item);
  }

  // Exact post-trim: if selected.length < maxCount, ensure no artist exceeds floor(selected.length * maxArtistRatio)
  let changed = true;
  while (changed && selected.length > 0) {
    changed = false;
    const strictMax = Math.max(1, Math.floor(selected.length * maxArtistRatio));
    if (selected.length < 4) break;
    for (const [key, count] of counts.entries()) {
      if (count > strictMax) {
        // Remove the lowest-scored occurrence (last in `selected`) of this artist
        for (let idx = selected.length - 1; idx >= 0; idx--) {
          const itemKey = selected[idx].artistKey || `__anon_${selected[idx].track.id}`;
          if (itemKey === key) {
            selected.splice(idx, 1);
            counts.set(key, count - 1);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }
  }

  return selected.map(s => s.track);
}

function extractMosaicCovers(tracks, defaultCover = '/icon.svg?v=3') {
  const uniqueCovers = [];
  const seen = new Set();
  for (const tr of tracks) {
    const art = typeof tr?.artwork === 'string' ? tr.artwork.trim() : '';
    if (!art || art.includes('/icon.svg') || art.includes('/brand/logo') || seen.has(art)) {
      continue;
    }
    seen.add(art);
    uniqueCovers.push(art);
    if (uniqueCovers.length === 4) break;
  }
  while (uniqueCovers.length < 4) {
    uniqueCovers.push(uniqueCovers[uniqueCovers.length % Math.max(1, uniqueCovers.length)] || defaultCover);
  }
  return uniqueCovers.slice(0, 4);
}

function buildPlaylistCard({ id, kind, title, reason, tracks, rng }) {
  const ordered = orderPlaylistTracksWithSmartShuffle(tracks, rng);
  return {
    id,
    kind,
    title,
    reason,
    trackCount: ordered.length,
    mosaicCovers: extractMosaicCovers(ordered),
    tracks: ordered
  };
}

/**
 * Generates all deterministic "Para ti" playlists on the client.
 */
export function generateAutoPlaylists({
  userId = 'anon',
  dateKey = null,
  now = Date.now(),
  currentHour = null,
  tracksPool = [],
  likedTracks = [],
  customPlaylists = [],
  listeningEntries = {},
  recommendedTracks = [],
  refreshNonce = 0
} = {}) {
  const resolvedDateKey = dateKey || formatLocalDateKey(new Date(now));
  const seedPrefix = `${String(userId || 'anon')}:${resolvedDateKey}${
    refreshNonce ? `:r${refreshNonce}` : ''
  }`;

  const likedIds = new Set(
    (Array.isArray(likedTracks) ? likedTracks : [])
      .filter(t => t && t.id != null)
      .map(t => String(t.id))
  );

  const savedTracks = deduplicateCandidatePool([
    ...(Array.isArray(likedTracks) ? likedTracks : []),
    ...(Array.isArray(customPlaylists) ? customPlaylists.flatMap(p => p?.tracks || []) : []),
    ...(Array.isArray(tracksPool) ? tracksPool : [])
  ]);

  const savedIds = new Set(savedTracks.map(t => String(t.id)));

  const fullCatalog = deduplicateCandidatePool([
    ...savedTracks,
    ...(Array.isArray(recommendedTracks) ? recommendedTracks : [])
  ]);

  const totalPlays = computeTotalPlays(listeningEntries);
  const coldStart = totalPlays < COLD_START_MIN_PLAYS;

  const artistAffinities = computeArtistAffinities(fullCatalog, listeningEntries, { likedIds });
  const resolveCatalogArtist = createArtistKeyResolver(fullCatalog);

  // Filter out tracks with > 60% skip rate globally
  const eligibleRecords = [];
  for (let i = 0; i < fullCatalog.length; i++) {
    const track = fullCatalog[i];
    const entry = normalizeListeningEntry(listeningEntries?.[String(track.id)]);
    if (isTrackExcludedBySkips(entry)) continue;

    const artistKey = resolveCatalogArtist(i);
    const affinity = scoreTrackAffinity(track, entry, { likedIds });
    const freshness = computeTrackFreshness(entry.lastPlayedAt, now);
    const artistAff = artistAffinities.get(artistKey)?.affinity ?? 0;

    eligibleRecords.push({
      track,
      entry,
      artistKey,
      affinity,
      freshness,
      artistAffinity: artistAff,
      isSaved: savedIds.has(String(track.id)),
      isLiked: likedIds.has(String(track.id))
    });
  }

  const sortedArtists = Array.from(artistAffinities.values()).sort((a, b) => {
    if (b.affinity !== a.affinity) return b.affinity - a.affinity;
    if (b.totalPlays !== a.totalPlays) return b.totalPlays - a.totalPlays;
    return a.artistKey.localeCompare(b.artistKey);
  });

  const buildRanked = (subset, scoreFn, salt) => {
    const tieRng = createSeededRng(`${seedPrefix}:tie:${salt}`);
    return subset
      .map(rec => ({
        ...rec,
        rankScore: scoreFn(rec) + tieRng() * 1e-4
      }))
      .sort((a, b) => b.rankScore - a.rankScore);
  };

  // Helper to build "Descubre"
  const buildDiscoverPlaylist = allowSmallInColdStart => {
    const rng = createSeededRng(`${seedPrefix}:discover`);
    const recIds = new Set(
      (Array.isArray(recommendedTracks) ? recommendedTracks : [])
        .filter(t => t && t.id != null)
        .map(t => String(t.id))
    );
    let pool = eligibleRecords.filter(r => recIds.has(String(r.track.id)));
    if (pool.length < MIN_AUTOPLAYLIST_SIZE) {
      // Supplement offline or sparse recommendations with unplayed / low-play tracks
      const extra = eligibleRecords.filter(
        r => !recIds.has(String(r.track.id)) && r.entry.plays <= 2
      );
      pool = [...pool, ...extra];
    }
    const ranked = buildRanked(
      pool,
      r => (recIds.has(String(r.track.id)) ? 2.0 : 0.5) + r.artistAffinity * 0.6 + r.affinity * 0.2,
      'discover'
    );
    const chosen = selectWithArtistCap(ranked, {
      maxCount: MAX_AUTOPLAYLIST_SIZE,
      maxArtistRatio: MAX_SAME_ARTIST_RATIO
    });
    const minNeeded = allowSmallInColdStart ? 1 : MIN_AUTOPLAYLIST_SIZE;
    if (chosen.length < minNeeded) return null;

    const seedNames = sortedArtists
      .filter(a => a.totalPlays > 0)
      .slice(0, 2)
      .map(a => a.displayName);
    const reason =
      seedNames.length > 0
        ? `Inspirada en tu afinidad con ${seedNames.join(' y ')}`
        : 'Canciones seleccionadas para ampliar lo que escuchas';

    return buildPlaylistCard({
      id: 'auto_discover',
      kind: 'discover',
      title: 'Descubre',
      reason,
      tracks: chosen,
      rng
    });
  };

  // Helper to build "Joyas sin escuchar"
  const buildHiddenGemsPlaylist = allowSmallInColdStart => {
    const rng = createSeededRng(`${seedPrefix}:gems`);
    const gemsPool = eligibleRecords.filter(
      r => r.isSaved && r.entry.plays <= 1 && r.entry.skips === 0
    );
    const ranked = buildRanked(
      gemsPool,
      r => r.artistAffinity * 1.5 + (r.isLiked ? 0.6 : 0.2) - r.entry.plays * 0.25,
      'gems'
    );
    const chosen = selectWithArtistCap(ranked, {
      maxCount: MAX_AUTOPLAYLIST_SIZE,
      maxArtistRatio: MAX_SAME_ARTIST_RATIO
    });
    const minNeeded = allowSmallInColdStart ? 1 : MIN_AUTOPLAYLIST_SIZE;
    if (chosen.length < minNeeded) return null;

    const topGemArtist = sortedArtists[0]?.displayName;
    const reason = topGemArtist
      ? `Joyas guardadas casi sin reproducir de ${topGemArtist} y artistas afines`
      : 'Canciones guardadas en tu biblioteca listas para escuchar';

    return buildPlaylistCard({
      id: 'auto_gems',
      kind: 'gems',
      title: 'Joyas sin escuchar',
      reason,
      tracks: chosen,
      rng
    });
  };

  // Cold-start guard (< 20 total plays): ONLY "Descubre" and "Joyas sin escuchar"
  if (coldStart) {
    const playlists = [
      buildDiscoverPlaylist(true),
      buildHiddenGemsPlaylist(true)
    ].filter(Boolean);

    return {
      coldStart: true,
      totalPlays,
      message: COLD_START_MESSAGE,
      topArtists: sortedArtists.slice(0, 6).map(a => a.displayName),
      playlists
    };
  }

  const playlists = [];

  // 1. "Tus favoritas ahora": highest affinity * (0.5 + freshness)
  {
    const rng = createSeededRng(`${seedPrefix}:favorites_now`);
    const favNowPool = eligibleRecords.filter(r => r.entry.plays > 0 || r.isLiked);
    const ranked = buildRanked(
      favNowPool,
      r => r.affinity * (0.5 + r.freshness),
      'favorites_now'
    );
    const chosen = selectWithArtistCap(ranked, {
      maxCount: 30,
      maxArtistRatio: MAX_SAME_ARTIST_RATIO
    });
    if (chosen.length >= MIN_AUTOPLAYLIST_SIZE) {
      const topTwo = sortedArtists.slice(0, 2).map(a => a.displayName);
      playlists.push(
        buildPlaylistCard({
          id: 'auto_favorites_now',
          kind: 'favorites_now',
          title: 'Tus favoritas ahora',
          reason:
            topTwo.length > 0
              ? `Porque últimamente escuchas mucho a ${topTwo.join(' y ')}`
              : 'Las canciones con mayor afinidad y frescura en tu cuenta',
          tracks: chosen,
          rng
        })
      );
    }
  }

  // 2. "Redescubre": high affinity, not played in > 21 days
  {
    const rng = createSeededRng(`${seedPrefix}:rediscover`);
    const cutoffMs = now - REDISCOVER_MIN_DAYS * DAY_MS;
    const rediscoverPool = eligibleRecords.filter(r => {
      if (r.entry.lastPlayedAt > 0) {
        return r.entry.lastPlayedAt < cutoffMs && (r.entry.plays >= 1 || r.isLiked);
      }
      const addedAt = Number(r.track.addedAt) || 0;
      return r.isLiked && addedAt > 0 && addedAt < cutoffMs;
    });
    const ranked = buildRanked(rediscoverPool, r => r.affinity, 'rediscover');
    const chosen = selectWithArtistCap(ranked, {
      maxCount: 30,
      maxArtistRatio: MAX_SAME_ARTIST_RATIO
    });
    if (chosen.length >= MIN_AUTOPLAYLIST_SIZE) {
      playlists.push(
        buildPlaylistCard({
          id: 'auto_rediscover',
          kind: 'rediscover',
          title: 'Redescubre',
          reason: 'Favoritas con alta afinidad que llevas más de 21 días sin escuchar',
          tracks: chosen,
          rng
        })
      );
    }
  }

  // 3. "Joyas sin escuchar"
  {
    const gemsCard = buildHiddenGemsPlaylist(false);
    if (gemsCard) playlists.push(gemsCard);
  }

  // 4. "Mix de [artista]" (x3): top 3 affinity artists — 70% artist + 30% similar artists
  {
    // Precompute artist co-occurrence in customPlaylists & likedTracks + real genres
    const artistGenres = new Map();
    const artistPlaylists = new Map();
    const likedArtistKeys = new Set();

    for (const r of eligibleRecords) {
      if (!r.artistKey) continue;
      if (isRealGenre(r.track.genre)) {
        const g = r.track.genre.trim().toLowerCase();
        if (!artistGenres.has(r.artistKey)) artistGenres.set(r.artistKey, new Set());
        artistGenres.get(r.artistKey).add(g);
      }
      if (r.isLiked) {
        likedArtistKeys.add(r.artistKey);
      }
    }

    if (Array.isArray(customPlaylists)) {
      customPlaylists.forEach((pl, plIdx) => {
        const tracksInPl = Array.isArray(pl?.tracks) ? pl.tracks : [];
        const resolvePlArtist = createArtistKeyResolver(tracksInPl);
        for (let i = 0; i < tracksInPl.length; i++) {
          const ak = resolvePlArtist(i);
          if (!ak) continue;
          if (!artistPlaylists.has(ak)) artistPlaylists.set(ak, new Set());
          artistPlaylists.get(ak).add(pl.id || `pl_${plIdx}`);
        }
      });
    }

    let artistMixCount = 0;
    for (const targetArtist of sortedArtists) {
      if (artistMixCount >= 3) break;
      const targetKey = targetArtist.artistKey;
      const ownPool = eligibleRecords.filter(r => r.artistKey === targetKey);
      if (ownPool.length === 0) continue;

      const targetGenres = artistGenres.get(targetKey) || new Set();
      const targetPls = artistPlaylists.get(targetKey) || new Set();
      const targetInLikes = likedArtistKeys.has(targetKey);

      const similarPool = eligibleRecords.filter(r => {
        if (!r.artistKey || r.artistKey === targetKey) return false;
        const candGenres = artistGenres.get(r.artistKey);
        if (candGenres) {
          for (const g of targetGenres) {
            if (candGenres.has(g)) return true;
          }
        }
        const candPls = artistPlaylists.get(r.artistKey);
        if (candPls) {
          for (const pid of targetPls) {
            if (candPls.has(pid)) return true;
          }
        }
        if (targetInLikes && likedArtistKeys.has(r.artistKey)) {
          return true;
        }
        return false;
      });

      if (ownPool.length + similarPool.length < MIN_AUTOPLAYLIST_SIZE) continue;

      // Determine largest feasible size in [15, 40] closest to 70% own + 30% similar
      const maxDesired = Math.min(
        MAX_AUTOPLAYLIST_SIZE,
        ownPool.length + similarPool.length
      );
      let targetSize = Math.min(
        maxDesired,
        Math.max(
          MIN_AUTOPLAYLIST_SIZE,
          Math.min(
            Math.floor(ownPool.length / 0.7) || MIN_AUTOPLAYLIST_SIZE,
            Math.floor(similarPool.length / 0.3) || MIN_AUTOPLAYLIST_SIZE
          )
        )
      );
      if (targetSize > maxDesired) targetSize = maxDesired;

      let ownQuota = Math.min(ownPool.length, Math.round(targetSize * 0.7));
      let simQuota = Math.min(similarPool.length, targetSize - ownQuota);
      while (ownQuota + simQuota < MIN_AUTOPLAYLIST_SIZE) {
        if (ownQuota < ownPool.length) ownQuota += 1;
        else if (simQuota < similarPool.length) simQuota += 1;
        else break;
      }

      if (ownQuota + simQuota < MIN_AUTOPLAYLIST_SIZE) continue;

      const rankedOwn = buildRanked(ownPool, r => r.affinity, `mix_own_${targetKey}`)
        .slice(0, ownQuota)
        .map(r => r.track);
      const rankedSim = buildRanked(
        similarPool,
        r => r.affinity + r.artistAffinity * 0.5,
        `mix_sim_${targetKey}`
      )
        .slice(0, simQuota)
        .map(r => r.track);

      const mixTracks = [...rankedOwn, ...rankedSim].slice(0, MAX_AUTOPLAYLIST_SIZE);
      if (mixTracks.length >= MIN_AUTOPLAYLIST_SIZE) {
        const rng = createSeededRng(`${seedPrefix}:artist_mix:${targetKey}`);
        playlists.push(
          buildPlaylistCard({
            id: `auto_artist_${artistMixCount + 1}_${targetKey.replace(/[^a-z0-9]+/g, '_')}`,
            kind: 'artist_mix',
            title: `Mix de ${targetArtist.displayName}`,
            reason: `Porque escuchas mucho a ${targetArtist.displayName}`,
            tracks: mixTracks,
            rng
          })
        );
        artistMixCount += 1;
      }
    }
  }

  // 5. "Para esta hora": matching current hourBuckets slot
  {
    const slot = getHourBucketName(currentHour !== null ? currentHour : new Date(now));
    const slotLabels = {
      madrugada: 'de madrugada',
      manana: 'por la mañana',
      tarde: 'por la tarde',
      noche: 'por la noche'
    };
    const directSlotPool = eligibleRecords.filter(r => (r.entry.hourBuckets?.[slot] || 0) > 0);
    let hourCandidates = directSlotPool;
    if (directSlotPool.length > 0 && directSlotPool.length < MIN_AUTOPLAYLIST_SIZE) {
      const slotArtists = new Set(directSlotPool.map(r => r.artistKey).filter(Boolean));
      const supplement = eligibleRecords.filter(
        r => (r.entry.hourBuckets?.[slot] || 0) === 0 && slotArtists.has(r.artistKey)
      );
      hourCandidates = [...directSlotPool, ...supplement];
    }

    const ranked = buildRanked(
      hourCandidates,
      r => (r.entry.hourBuckets?.[slot] || 0) * 2.0 + r.affinity,
      `hour_${slot}`
    );
    const chosen = selectWithArtistCap(ranked, {
      maxCount: 28,
      maxArtistRatio: MAX_SAME_ARTIST_RATIO
    });
    if (chosen.length >= MIN_AUTOPLAYLIST_SIZE) {
      const rng = createSeededRng(`${seedPrefix}:hour:${slot}`);
      playlists.push(
        buildPlaylistCard({
          id: `auto_hour_${slot}`,
          kind: 'hour',
          title: 'Para esta hora',
          reason: `Lo que más sueles escuchar ${slotLabels[slot] || 'a esta hora'}`,
          tracks: chosen,
          rng
        })
      );
    }
  }

  // 6. "Mix de [género]": ONLY real genres (ignore Offline, YouTube, Música, and IGNORED_TERMS)
  {
    const byGenre = new Map();
    for (const r of eligibleRecords) {
      if (!isRealGenre(r.track.genre)) continue;
      const gKey = r.track.genre.trim().toLowerCase();
      let gEntry = byGenre.get(gKey);
      if (!gEntry) {
        gEntry = {
          genreKey: gKey,
          displayName: r.track.genre.trim(),
          totalScore: 0,
          records: []
        };
        byGenre.set(gKey, gEntry);
      }
      gEntry.totalScore += r.affinity;
      gEntry.records.push(r);
    }

    const sortedGenres = Array.from(byGenre.values()).sort(
      (a, b) => b.totalScore - a.totalScore
    );

    for (const gGroup of sortedGenres) {
      const ranked = buildRanked(gGroup.records, r => r.affinity, `genre_${gGroup.genreKey}`);
      const chosen = selectWithArtistCap(ranked, {
        maxCount: 30,
        maxArtistRatio: MAX_SAME_ARTIST_RATIO
      });
      if (chosen.length >= MIN_AUTOPLAYLIST_SIZE) {
        const rng = createSeededRng(`${seedPrefix}:genre:${gGroup.genreKey}`);
        playlists.push(
          buildPlaylistCard({
            id: `auto_genre_${gGroup.genreKey.replace(/[^a-z0-9]+/g, '_')}`,
            kind: 'genre_mix',
            title: `Mix de ${gGroup.displayName}`,
            reason: `Tu selección de ${gGroup.displayName} según tus reproducciones`,
            tracks: chosen,
            rng
          })
        );
        break;
      }
    }
  }

  // 7. "Descubre"
  {
    const discoverCard = buildDiscoverPlaylist(false);
    if (discoverCard) playlists.push(discoverCard);
  }

  return {
    coldStart: false,
    totalPlays,
    message: '',
    topArtists: sortedArtists.slice(0, 6).map(a => a.displayName),
    playlists
  };
}
