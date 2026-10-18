const FEAT_SPLIT_REGEX = /\s+(?:feat\.?|ft\.?|featuring|with|x)\s+.*$/i;
const PAREN_FEAT_REGEX = /\s*[\(\[](?:feat\.?|ft\.?|featuring|with)\s+[^\)\]]+[\)\]]/gi;

export function wrap01(x) {
  return ((x % 1) + 1) % 1;
}

export function normalizeArtistText(raw) {
  return String(raw || '')
    .replace(PAREN_FEAT_REGEX, ' ')
    .replace(FEAT_SPLIT_REGEX, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds a resolver that maps each track's artist field to a canonical primary artist key.
 * - Always strips "feat.", "ft.", "featuring", "with", " x ".
 * - Splits on "," or ";" or "&" ONLY when the left-hand artist already exists as a standalone
 *   artist in the library AND splitting won't break legitimate duo/band names like
 *   "Simon & Garfunkel", "Earth, Wind & Fire", or "Tyler, The Creator".
 */
export function createArtistKeyResolver(list) {
  const standaloneArtists = new Set();
  const rawCleanedByIndex = new Array(list.length);

  for (let i = 0; i < list.length; i++) {
    const cleaned = normalizeArtistText(list[i]?.artist);
    rawCleanedByIndex[i] = cleaned;
    if (cleaned && !/[,;&]/.test(cleaned)) {
      standaloneArtists.add(cleaned);
    }
  }

  return function getArtistKey(idx) {
    const cleaned = rawCleanedByIndex[idx] ?? normalizeArtistText(list[idx]?.artist);
    if (!cleaned) return '';

    // Check comma or semicolon collaborations: e.g. "Artist X, Artist Y"
    if (cleaned.includes(',') || cleaned.includes(';')) {
      const parts = cleaned.split(/\s*[,;]\s*/).filter(Boolean);
      if (parts.length >= 2) {
        const left = parts[0];
        const right = parts[1];
        const isBandPattern =
          /^the\b/i.test(right) || // "Tyler, The Creator"
          right.includes('&'); // "Earth, Wind & Fire" / "Crosby, Stills & Nash"
        if (!isBandPattern && standaloneArtists.has(left)) {
          return left;
        }
      }
    }

    // Check ampersand collaborations: only split if the left-hand artist is a multi-word
    // standalone artist in the library (so "Simon & Garfunkel" never merges into a solo "Simon")
    if (cleaned.includes(' & ')) {
      const parts = cleaned.split(/\s+&\s+/).filter(Boolean);
      if (parts.length >= 2) {
        const left = parts[0];
        const leftWordCount = left.split(/\s+/).length;
        if (leftWordCount >= 2 && standaloneArtists.has(left)) {
          return left;
        }
      }
    }

    return cleaned;
  };
}

export function getShuffleTrackKey(track) {
  if (!track) return '';
  if (track.id !== undefined && track.id !== null && String(track.id) !== '') {
    return `id:${String(track.id)}`;
  }
  const t = String(track.title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  const a = normalizeArtistText(track.artist);
  return `${t}|${a}`;
}

function fisherYatesInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Repairs adjacent same-artist collisions in `order` within the index range [minIdx, maxIdx]
 * without ever moving indices < minIdx or moving recent tracks into the protected front zone.
 */
function repairAdjacentArtists(order, getArtistKey, minIdx, isPlacementAllowed) {
  const len = order.length;
  if (len - minIdx <= 2) return;

  for (let pass = 0; pass < 3; pass++) {
    let changed = false;

    for (let i = Math.max(1, minIdx); i < len; i++) {
      const prevArtist = getArtistKey(order[i - 1]);
      const curArtist = getArtistKey(order[i]);
      if (!curArtist || curArtist !== prevArtist) continue;

      // 1. Try swapping order[i] with a non-conflicting index j >= minIdx
      let swapped = false;
      for (let j = minIdx; j < len; j++) {
        if (j === i || j === i - 1) continue;
        const candIdx = order[j];
        const candArtist = getArtistKey(candIdx);
        if (candArtist === curArtist) continue;
        if (!isPlacementAllowed(candIdx, i) || !isPlacementAllowed(order[i], j)) continue;

        // Check neighbors of i if candIdx is placed at i
        const leftOfI = i > 0 ? getArtistKey(order[i - 1]) : '';
        const rightOfI = i + 1 < len && i + 1 !== j ? getArtistKey(order[i + 1]) : '';
        if (candArtist && (candArtist === leftOfI || candArtist === rightOfI)) continue;

        // Check neighbors of j if order[i] is placed at j
        const leftOfJ = j > 0 && j - 1 !== i ? getArtistKey(order[j - 1]) : '';
        const rightOfJ = j + 1 < len && j + 1 !== i ? getArtistKey(order[j + 1]) : '';
        if (curArtist && (curArtist === leftOfJ || curArtist === rightOfJ)) continue;

        [order[i], order[j]] = [order[j], order[i]];
        swapped = true;
        changed = true;
        break;
      }

      if (swapped) continue;

      // 2. Fallback: remove order[i] and insert it into the first valid gap g >= minIdx
      const itemIdx = order[i];
      for (let g = minIdx; g <= len - 1; g++) {
        if (g === i || g === i + 1) continue;
        const targetPos = g > i ? g - 1 : g;
        if (!isPlacementAllowed(itemIdx, targetPos)) continue;

        const leftNeighbor = g > 0 ? getArtistKey(order[g - 1 === i ? g - 2 : g - 1]) : '';
        const rightNeighbor = g < len ? getArtistKey(order[g === i ? g + 1 : g]) : '';
        if (curArtist === leftNeighbor || curArtist === rightNeighbor) continue;

        // Also check that removing order[i] doesn't leave order[i-1] and order[i+1] colliding
        if (i > 0 && i + 1 < len) {
          const beforeRemove = getArtistKey(order[i - 1]);
          const afterRemove = getArtistKey(order[i + 1]);
          if (beforeRemove && beforeRemove === afterRemove) continue;
        }

        order.splice(i, 1);
        order.splice(targetPos, 0, itemIdx);
        changed = true;
        break;
      }
    }

    if (!changed) break;
  }
}

/**
 * Balanced Dithered Shuffle (Spotify Engineering / Lukáš Poláček & Martin Fiedler algorithm).
 *
 * Accepts either:
 *   buildSmartShuffleOrder(list, startIdx)
 * or:
 *   buildSmartShuffleOrder(list, { startIdx = -1, rng = Math.random, recentKeys = null, cooldownFrontCount = 5 })
 */
export function buildSmartShuffleOrder(list, optionsOrStartIdx = -1) {
  const n = Array.isArray(list) ? list.length : 0;
  if (n <= 1) return n === 1 ? [0] : [];

  const opts =
    typeof optionsOrStartIdx === 'number'
      ? { startIdx: optionsOrStartIdx }
      : optionsOrStartIdx || {};

  const startIdx = typeof opts.startIdx === 'number' ? opts.startIdx : -1;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const cooldownFrontCount =
    typeof opts.cooldownFrontCount === 'number' ? opts.cooldownFrontCount : 5;

  const hasValidStart = startIdx >= 0 && startIdx < n;
  const getArtistKey = createArtistKeyResolver(list);

  // Build recent lookup set (only applied when starting a general random shuffle: startIdx < 0)
  const recentSet = new Set();
  if (!hasValidStart && opts.recentKeys && n > 6) {
    for (const k of opts.recentKeys) {
      if (k !== undefined && k !== null && String(k) !== '') {
        recentSet.add(String(k));
      }
    }
  }

  const isRecentIndex = idx => {
    if (recentSet.size === 0) return false;
    const track = list[idx];
    if (!track) return false;
    const fullKey = getShuffleTrackKey(track);
    const rawId = track.id !== undefined && track.id !== null ? String(track.id) : '';
    return recentSet.has(fullKey) || (rawId !== '' && recentSet.has(rawId));
  };

  // Group remaining indices by canonical artist key
  const groupsByArtist = new Map();
  let unknownCounter = 0;

  for (let i = 0; i < n; i++) {
    if (i === startIdx) continue;
    const key = getArtistKey(i) || `__unknown_${unknownCounter++}`;
    let grp = groupsByArtist.get(key);
    if (!grp) {
      grp = [];
      groupsByArtist.set(key, grp);
    }
    grp.push(i);
  }

  // Shuffle internal track order for each artist and compute dithered virtual positions in [0, 1)
  const positioned = [];
  for (const [, indices] of groupsByArtist.entries()) {
    fisherYatesInPlace(indices, rng);
    const k = indices.length;
    const offset = rng() / k;

    for (let i = 0; i < k; i++) {
      const jitter = (rng() - 0.5) * 0.3; // [-0.15, +0.15]
      const pos = wrap01(offset + (i + jitter) / k);
      positioned.push({ idx: indices[i], pos });
    }
  }

  positioned.sort((a, b) => a.pos - b.pos);

  const order = hasValidStart
    ? [startIdx, ...positioned.map(p => p.idx)]
    : positioned.map(p => p.idx);

  // Enforce recent-history cooldown in the first `protectedFront` slots when startRandom (startIdx < 0)
  let protectedFront = 0;
  if (!hasValidStart && recentSet.size > 0 && n > 6) {
    let nonRecentTotal = 0;
    for (let i = 0; i < n; i++) {
      if (!isRecentIndex(i)) nonRecentTotal++;
    }
    protectedFront = Math.min(cooldownFrontCount, nonRecentTotal);

    if (protectedFront > 0) {
      for (let i = 0; i < protectedFront; i++) {
        if (isRecentIndex(order[i])) {
          for (let j = protectedFront; j < n; j++) {
            if (!isRecentIndex(order[j])) {
              [order[i], order[j]] = [order[j], order[i]];
              break;
            }
          }
        }
      }
    }
  }

  const minMutableIdx = hasValidStart ? 1 : 0;
  const isPlacementAllowed = (trackIdx, targetPos) => {
    if (targetPos < minMutableIdx) return false;
    if (protectedFront > 0 && targetPos < protectedFront && isRecentIndex(trackIdx)) {
      return false;
    }
    return true;
  };

  repairAdjacentArtists(order, getArtistKey, minMutableIdx, isPlacementAllowed);

  return order;
}
