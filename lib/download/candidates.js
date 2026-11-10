const DRM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
if (!global.__drmBlockedUrls) {
  global.__drmBlockedUrls = new Map();
}
const drmBlockedUrls = global.__drmBlockedUrls;

export function isUrlDrmBlocked(url, cacheMap = drmBlockedUrls, now = Date.now()) {
  if (!url) return false;
  const ts = cacheMap.get(url);
  if (!ts) return false;
  if (now - ts > DRM_CACHE_TTL_MS) {
    cacheMap.delete(url);
    return false;
  }
  return true;
}

export function markUrlDrmBlocked(url, cacheMap = drmBlockedUrls, now = Date.now()) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (cacheMap.size >= 2000) {
    const oldestKey = cacheMap.keys().next().value;
    if (oldestKey) cacheMap.delete(oldestKey);
  }
  cacheMap.set(url, now);
}

export function sanitizeSlug(text) {
  const clean = (text || 'track')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s\-_]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return (clean || 'track').slice(0, 60);
}

export function normalizeText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function stripMediaExtensionNoise(raw) {
  return String(raw || '')
    .replace(
      /(?<=[\p{L}\p{N}]{2})[._](?:avi|mp4|mp3|mkv|wmv|flv|mov|m4a|m4v|wav|flac|ogg|opus|webm|mpg|mpeg|3gp|aac|wma)(?=$|\s|[\(\[\)\]\-–—|])/giu,
      ''
    )
    .replace(
      /([\p{L}]{2,})(?:mp3|mp4|m4a|m4v|3gp|mkv|wmv|flv|webm)(?=$|\s|[\(\[\)\]\-–—|])/giu,
      '$1'
    )
    .replace(
      /(\p{Lu}{2,})(?:avi|mov|wav|flac|mpg|mpeg|ogg|opus|aac|wma)(?=$|\s|[\(\[\)\]\-–—|])/gu,
      '$1'
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripYouTubeTitleNoise(rawTitle) {
  const withoutExt = stripMediaExtensionNoise(rawTitle);
  const stripped = withoutExt
    .replace(/\*[^*]{1,40}\*/g, ' ')
    .replace(
      /\s*[\(\[](official\s*(music\s*)?video|video\s*oficial|audio\s*oficial|official\s*audio|official\s*lyric\s*video|fanmade\s*lyric\s*video|lyric\s*video|lyrics?|con\s*letra|letra|visualizer|visualiser|hd(\s*\d{3,4}p)?|4k|8k|hq|1080p|720p|reupload|sub\s*espa[ñn]ol|flash\s*warning|epilepsy\s*warning)[\)\]]/gi,
      ' '
    )
    .replace(
      /\s+[-–—|]?\s*\b(fanmade\s+lyric\s+video|official\s+lyric\s+video|lyric\s+video|official\s+music\s+video|official\s+video|official\s+audio|music\s+video|video\s+oficial|audio\s+oficial|visualizer|visualiser)\s*$/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
  return stripMediaExtensionNoise(stripped);
}

const NON_TITLE_RIGHT_SUFFIX_RE =
  /^(demo(\s+\d+)?|extended(\s+(version|mix))?|radio\s+edit|interlude|intro|outro|live(\s+.*)?|en\s+vivo(\s+.*)?|remix|instrumental|acoustic|ac[uú]stico|remaster(ed)?(\s+\d{4})?|version|part\s+\d+|pt\.?\s*\d+)$/i;

export function cleanYouTubeOembedMetadata(rawTitle, rawAuthor = '') {
  const isTopicAuthor = /\s*-\s*Topic$/i.test(String(rawAuthor || '').trim());
  let author = String(rawAuthor || '')
    .replace(/\*[^*]{1,40}\*/g, ' ')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  let cleaned = stripYouTubeTitleNoise(rawTitle);

  if (!isTopicAuthor && /\s+[-–—]\s+/.test(cleaned)) {
    const parts = cleaned.split(/\s+[-–—]\s+/);
    const left = parts[0].trim();
    const right = parts.slice(1).join(' - ').trim();
    if (left.length >= 2 && right.length >= 2 && !NON_TITLE_RIGHT_SUFFIX_RE.test(right)) {
      const restAfterSecond = parts.slice(2).join(' - ').trim();
      if (
        parts.length >= 3 &&
        author &&
        normalizeText(left) === normalizeText(author) &&
        parts[1].trim().length >= 2 &&
        restAfterSecond.length >= 2 &&
        !NON_TITLE_RIGHT_SUFFIX_RE.test(restAfterSecond)
      ) {
        author = parts[1].trim();
        cleaned = restAfterSecond;
      } else {
        author = left;
        cleaned = right;
      }
    }
  }

  return {
    title: cleaned || String(rawTitle || '').trim() || null,
    artist: author || 'YouTube'
  };
}

export function stripRemasterNoise(raw) {
  return stripMediaExtensionNoise(raw)
    .replace(
      /\s*[-–—]\s*(remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|radio\s+edit|album\s+version|single\s+version|spanglish\s+version|spanish\s+version|english\s+version|original\s+version|video\s+version|vocal\s+version|explicit|clean|mono|stereo|\d+\/\d+.*).*/i,
      ''
    )
    .replace(
      /\s*\((remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|feat\.?[^)]+|ft\.?[^)]+|spanglish(\s+version)?|spanish(\s+version)?|english(\s+version)?|original(\s+version)?|video(\s+version)?|vocal(\s+version)?|explicit|clean|mono|stereo)\)/gi,
      ''
    )
    .replace(/\s*\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripParentheticalSubtitles(raw) {
  const stripped = String(raw || '')
    .replace(/\s*[\(\[]([^\)\]]*)[\)\]]/g, (full, inner) => {
      if (
        /\b(demo|extended|remix|live|vivo|cover|acoustic|acustico|instrumental|vip|slowed|sped\s*up|nightcore)\b/i.test(
          inner
        )
      ) {
        return ` (${inner.trim()})`;
      }
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 3 ? stripped : String(raw || '').trim();
}

export function cleanArtistName(raw) {
  const first = String(raw || '')
    .split(/[,;&]/)[0]
    .replace(/(archive|archives|vault|topic|reupload|official)$/i, '')
    .replace(
      /\b(archive|archives|vault|topic|reupload|official|artista|guardado en dispositivo)\b/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
  return first;
}

export function getArtistTokens(rawArtist) {
  const stopWords = new Set([
    'the',
    'los',
    'las',
    'les',
    'and',
    'con',
    'del',
    'por',
    'para',
    'feat',
    'with',
    'official',
    'archive',
    'archives',
    'vault',
    'topic',
    'music',
    'band',
    'dj'
  ]);
  return normalizeText(
    String(rawArtist || '').replace(/(archive|archives|vault|topic|reupload)$/gi, ' ')
  )
    .split(/\s+/)
    .filter(w => (w.length >= 3 || /[^\x00-\x7f]/.test(w)) && !stopWords.has(w));
}

const TITLE_STOP_WORDS = new Set([
  'the',
  'los',
  'las',
  'les',
  'and',
  'con',
  'del',
  'por',
  'para',
  'una',
  'uno',
  'feat',
  'ft',
  'with',
  'remaster',
  'remastered',
  'remasterizado',
  'version',
  'spanglish',
  'spanish',
  'espanol',
  'english',
  'original',
  'official',
  'oficial',
  'audio',
  'video',
  'radio',
  'single',
  'album',
  'edit',
  'mix',
  'vol',
  'volumen',
  'volume',
  'pt',
  'part',
  'parte'
]);

export function extractMeaningfulTokens(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(
      w => (w.length >= 2 || /^\d+$/.test(w) || /[^\x00-\x7f]/.test(w)) && !TITLE_STOP_WORDS.has(w)
    );
}

export function getTitleCoreTokens(cleanTitle) {
  const primaryPart = stripParentheticalSubtitles(cleanTitle);
  const primaryTokens = extractMeaningfulTokens(primaryPart);
  if (primaryTokens.length > 0) {
    return primaryTokens;
  }
  const tokens = extractMeaningfulTokens(cleanTitle);
  return tokens.length > 0 ? tokens : normalizeText(cleanTitle).split(/\s+/).filter(Boolean);
}

export function extractParentheticalTokenGroups(rawText) {
  const groups = [];
  const regex = /[\(\[]([^\)\]]+)[\)\]]/g;
  let match;
  while ((match = regex.exec(String(rawText || ''))) !== null) {
    const inner = stripRemasterNoise(match[1]);
    if (
      !inner ||
      /\b(feat|ft|with|prod|remix|live|vivo|cover|karaoke|demo|extended|acoustic|acustico|instrumental|vip|slowed|reverb|sped\s*up|nightcore)\b/i.test(
        inner
      )
    ) {
      continue;
    }
    const tokens = extractMeaningfulTokens(inner);
    if (tokens.length > 0) {
      groups.push(tokens);
    }
  }
  return groups;
}

export function parseDurationToSec(rawDur) {
  if (!rawDur) return null;
  if (typeof rawDur === 'number' && rawDur >= 45 && rawDur <= 1200) {
    return Math.round(rawDur);
  }
  const str = String(rawDur).trim();
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  let sec = 0;
  if (parts.length === 2) {
    sec = parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return sec >= 45 && sec <= 1200 ? sec : null;
}

const STANDARD_AUDIO_METADATA_WORDS = new Set([
  'official',
  'oficial',
  'audio',
  'video',
  'music',
  'lyrics',
  'lyric',
  'letra',
  'sub',
  'espanol',
  'spanish',
  'spanglish',
  'english',
  'hd',
  'hq',
  '4k',
  '8k',
  'remaster',
  'remastered',
  'remasterizado',
  'mix',
  'stereo',
  'mono',
  'original',
  'version',
  'single',
  'album',
  'edit',
  'radio',
  'explicit',
  'clean',
  'solo',
  'feat',
  'ft',
  'with',
  'prod',
  'ncs',
  'release',
  'rooftop',
  'fotage',
  'footage',
  'mp3',
  'm4a',
  'wav',
  'flac',
  'ogg',
  'opus',
  'mp4',
  'avi',
  'mkv',
  'wmv',
  'flv',
  'mov',
  'webm',
  'topic',
  'visualizer',
  'deluxe',
  'bonus',
  'track',
  'completo',
  'full',
  'vol',
  'volumen',
  'volume',
  'sessions',
  'session',
  'the',
  'and',
  'con',
  'del',
  'las',
  'los',
  'por',
  'para'
]);

export function buildWordCompounds(words, maxSpan = 3) {
  const compounds = new Set();
  if (!Array.isArray(words) || words.length < 2) return compounds;
  for (let i = 0; i < words.length; i++) {
    let acc = words[i];
    if (!acc) continue;
    for (let j = i + 1; j < Math.min(words.length, i + maxSpan); j++) {
      if (!words[j]) break;
      acc += words[j];
      if (acc.length >= 4) {
        compounds.add(acc);
      }
    }
  }
  return compounds;
}

function computeCompoundCoveredIndices(words, allowedWords, maxSpan = 3) {
  const covered = new Set();
  if (!Array.isArray(words) || words.length < 2 || !allowedWords) return covered;
  for (let i = 0; i < words.length; i++) {
    if (!words[i]) continue;
    let acc = words[i];
    for (let j = i + 1; j < Math.min(words.length, i + maxSpan); j++) {
      if (!words[j]) break;
      acc += words[j];
      if (acc.length >= 4 && allowedWords.has(acc)) {
        for (let k = i; k <= j; k++) covered.add(k);
      }
    }
  }
  return covered;
}

export function buildCandidateContext(
  rawTitle,
  cleanTitle,
  rawArtist,
  expectedDurationSec,
  catalogMeta = null
) {
  const cleanedRawTitle = stripMediaExtensionNoise(rawTitle);
  const cleanedTitle = stripMediaExtensionNoise(cleanTitle);
  const rawTitleNorm = normalizeText(cleanedRawTitle);
  const cleanTitleNorm = normalizeText(cleanedTitle);
  const rawArtistNorm = normalizeText(rawArtist);
  const titleTokens = getTitleCoreTokens(cleanedTitle);
  const artistTokens = getArtistTokens(rawArtist);

  const titleTokenGroups = [titleTokens];
  const artistTokenSet = new Set(artistTokens);
  const nonArtistPrimary = titleTokens.filter(t => !artistTokenSet.has(t));
  if (nonArtistPrimary.length >= 2 && nonArtistPrimary.length < titleTokens.length) {
    titleTokenGroups.push(nonArtistPrimary);
  }
  for (const grp of extractParentheticalTokenGroups(cleanedRawTitle)) {
    titleTokenGroups.push(grp);
  }
  if (catalogMeta?.catalogTokenGroups) {
    for (const grp of catalogMeta.catalogTokenGroups) {
      titleTokenGroups.push(grp);
    }
  }

  const allowedWords = new Set(STANDARD_AUDIO_METADATA_WORDS);
  const rawTitleWords = rawTitleNorm.split(/\s+/).filter(Boolean);
  const cleanTitleWords = cleanTitleNorm.split(/\s+/).filter(Boolean);
  const rawArtistWords = rawArtistNorm.split(/\s+/).filter(Boolean);
  for (const w of [...rawTitleWords, ...cleanTitleWords, ...rawArtistWords]) {
    allowedWords.add(w);
  }
  for (const c of [
    ...buildWordCompounds(rawTitleWords),
    ...buildWordCompounds(cleanTitleWords),
    ...buildWordCompounds(rawArtistWords)
  ]) {
    allowedWords.add(c);
  }
  if (catalogMeta?.catalogWords) {
    for (const w of catalogMeta.catalogWords) {
      if (w) allowedWords.add(w);
    }
  }

  return {
    rawTitleLower: String(cleanedRawTitle || '').toLowerCase(),
    rawArtistLower: String(rawArtist || '').toLowerCase(),
    titleTokens,
    titleTokenGroups,
    artistTokens,
    allowedWords,
    expectedDurationSec
  };
}

export function candidateMatchesAnyTitleGroup(
  candTitleWordSet,
  candTitleNorm,
  ctx,
  candTitleCompounds = null
) {
  const groups =
    Array.isArray(ctx.titleTokenGroups) && ctx.titleTokenGroups.length > 0
      ? ctx.titleTokenGroups
      : [ctx.titleTokens || []];

  for (const group of groups) {
    if (!group || group.length === 0) continue;
    const numericTokens = group.filter(t => /^\d+$/.test(t));
    if (numericTokens.length > 0 && !numericTokens.every(num => candTitleWordSet.has(num))) {
      continue;
    }
    const matchedCount = group.filter(
      t =>
        candTitleWordSet.has(t) ||
        (candTitleCompounds && candTitleCompounds.has(t)) ||
        candTitleNorm.includes(t)
    ).length;
    const minRequired =
      group.length === 1 ? 1 : Math.max(2, Math.ceil(group.length * 0.7));
    if (matchedCount >= minRequired) {
      return true;
    }
  }
  return false;
}

const CORE_ALTERED_AUDIO_TERMS = [
  'cover',
  'covered',
  'tribute',
  'karaoke',
  'originally performed',
  'in the style of',
  'made famous',
  'backing track',
  'instrumental',
  'nightcore',
  '8d',
  'slowed',
  'reverb',
  'sped up',
  'speed up',
  '1.1x',
  'distorted',
  'chopped',
  'parody',
  'tutorial',
  'lesson',
  'how to play',
  'reaction',
  'podcast',
  'interview',
  'trailer',
  'teaser',
  '1s preview',
  'best part',
  'ringtone',
  'snippet',
  'screenrecording',
  'animatic',
  'fanmade',
  'ai cover',
  'drum cover',
  'guitar cover',
  'bass cover',
  'piano cover',
  'vocal cover',
  'sax cover',
  'acoustic cover',
  'myvoice',
  'deep house',
  'reggae version',
  'gregorian',
  'jukebox',
  'bornagen',
  'the-rooftop-beatles',
  'rooftopsdd',
  'electric-beatles',
  'electric beatles',
  'bootleg',
  'mashup',
  'rework',
  'flip',
  'hoodtrap',
  'mylancore',
  'hardstyle',
  'dubstep',
  'tiktok'
];

const EMBEDDED_ARTIST_DISALLOWED_SINGLE = new Set([
  'para',
  'como',
  'este',
  'esta',
  'todo',
  'toda',
  'solo',
  'sola',
  'amor',
  'vida',
  'noche',
  'cuando',
  'donde',
  'desde',
  'hasta',
  'entre',
  'sobre',
  'cancion',
  'song',
  'love',
  'life',
  'night',
  'from',
  'into',
  'over'
]);

function evaluateEmbeddedArtistPrefix(
  rawCandTitle,
  candTitleWordSet,
  candTitleCompounds,
  candUploaderWords,
  ctx
) {
  if (ctx.expectedDurationSec || !Array.isArray(ctx.titleTokens) || ctx.titleTokens.length < 3) {
    return { matched: false, viaUploader: false, viaTitlePrefix: false };
  }

  const candUploaderSet = new Set(candUploaderWords);
  const candUploaderCompounds = buildWordCompounds(candUploaderWords);

  let candLeftSet = null;
  let candLeftCompounds = null;
  if (/\s+[-–—]\s+/.test(String(rawCandTitle || ''))) {
    const leftWords = normalizeText(String(rawCandTitle).split(/\s+[-–—]\s+/)[0])
      .split(/\s+/)
      .filter(Boolean);
    if (leftWords.length > 0) {
      candLeftSet = new Set(leftWords);
      candLeftCompounds = buildWordCompounds(leftWords);
    }
  }

  for (const prefixLen of [1, 2]) {
    if (ctx.titleTokens.length - prefixLen < 2) continue;
    const prefixTokens = ctx.titleTokens.slice(0, prefixLen);
    const remainingTokens = ctx.titleTokens.slice(prefixLen);
    const prefixJoined = prefixTokens.join('');
    if (prefixJoined.length < 4 || /^\d+$/.test(prefixJoined)) continue;
    if (prefixLen === 1 && EMBEDDED_ARTIST_DISALLOWED_SINGLE.has(prefixTokens[0])) continue;

    const numericRemaining = remainingTokens.filter(t => /^\d+$/.test(t));
    if (numericRemaining.length > 0 && !numericRemaining.every(n => candTitleWordSet.has(n))) {
      continue;
    }

    const allRemainingInTitle = remainingTokens.every(
      t => candTitleWordSet.has(t) || candTitleCompounds.has(t)
    );
    if (!allRemainingInTitle) continue;

    const viaUploader =
      candUploaderWords.length > 0 &&
      (prefixTokens.every(pt => candUploaderSet.has(pt) || candUploaderCompounds.has(pt)) ||
        candUploaderSet.has(prefixJoined) ||
        candUploaderCompounds.has(prefixJoined));

    const viaTitlePrefix =
      Boolean(candLeftSet) &&
      (prefixTokens.every(pt => candLeftSet.has(pt) || candLeftCompounds.has(pt)) ||
        candLeftSet.has(prefixJoined) ||
        candLeftCompounds.has(prefixJoined));

    if (viaUploader || viaTitlePrefix) {
      return { matched: true, viaUploader, viaTitlePrefix };
    }
  }

  return { matched: false, viaUploader: false, viaTitlePrefix: false };
}

export function evaluateCandidate(cand, ctx, options = {}) {
  const { allowRelaxedDuration = false } = options || {};
  if (cand.webpageUrl && isUrlDrmBlocked(cand.webpageUrl)) {
    return { score: -1, reason: 'drm_cached_24h' };
  }
  const dur = Number(cand.duration);
  const extractorLower = String(cand.extractor || '').toLowerCase();
  if (!dur || isNaN(dur)) {
    return { score: -1, reason: 'no_duration' };
  }
  if (extractorLower.includes('soundcloud') && dur >= 28 && dur <= 32) {
    return { score: -1, reason: `sc_drm_preview_30s(${Math.round(dur)}s)` };
  }
  if (dur < 45 || dur > 900) {
    return { score: -1, reason: `duration_bounds(${Math.round(dur)}s)` };
  }

  let durDiff = 0;
  const maxDurDiff = allowRelaxedDuration ? 65 : 20;
  if (ctx.expectedDurationSec && ctx.expectedDurationSec >= 50) {
    durDiff = Math.abs(dur - ctx.expectedDurationSec);
    if (durDiff > maxDurDiff) {
      return {
        score: -1,
        reason: `duration_diff(${Math.round(dur)}s vs ${ctx.expectedDurationSec}s)`
      };
    }
  }

  const titleLower = String(cand.title || '').toLowerCase();
  const uploaderLower = String(cand.uploader || '').toLowerCase();
  const urlLower = String(cand.webpageUrl || '').toLowerCase();
  const combinedLower = `${titleLower} ${uploaderLower} ${urlLower}`;

  const bannedTerms = [
    ...CORE_ALTERED_AUDIO_TERMS,
    '10min',
    '10 min',
    '10 minutes',
    '10 minutos',
    '1 hour',
    '1 hora',
    'loop'
  ];
  if (!allowRelaxedDuration) {
    bannedTerms.push('extended version', 'extended mix');
  }

  if (!ctx.rawTitleLower.includes('remix')) {
    bannedTerms.push('remix');
  }
  if (!ctx.rawTitleLower.includes('demo')) {
    bannedTerms.push('(demo)', '[demo]', ' demo');
  }
  if (!ctx.rawTitleLower.includes('live') && !ctx.rawTitleLower.includes('vivo')) {
    bannedTerms.push('live at', 'live in', 'live from', 'en vivo', '(live)', '[live]');
  }
  if (!ctx.rawTitleLower.includes('fast')) {
    bannedTerms.push('fast version');
  }

  for (const term of bannedTerms) {
    if (ctx.rawTitleLower.includes(term) || ctx.rawArtistLower.includes(term)) continue;
    if (combinedLower.includes(term)) {
      return { score: -1, reason: `banned_term(${term.trim()})` };
    }
  }

  if (/\(\s*by\s+[^)]+\)/i.test(cand.title || '')) {
    return { score: -1, reason: 'by_credit_cover' };
  }

  const candTitleNorm = normalizeText(cand.title);
  const candUploaderNorm = normalizeText(cand.uploader);
  const candTitleWords = candTitleNorm.split(/\s+/).filter(Boolean);
  const candTitleWordSet = new Set(candTitleWords);
  const candTitleCompounds = buildWordCompounds(candTitleWords);
  const candUploaderWords = candUploaderNorm.split(/\s+/).filter(Boolean);
  const candUploaderWordSet = new Set(candUploaderWords);

  const titleGroupMatched = candidateMatchesAnyTitleGroup(
    candTitleWordSet,
    candTitleNorm,
    ctx,
    candTitleCompounds
  );
  const embeddedArtist = evaluateEmbeddedArtistPrefix(
    cand.title,
    candTitleWordSet,
    candTitleCompounds,
    candUploaderWords,
    ctx
  );

  if (!titleGroupMatched && !embeddedArtist.matched) {
    return { score: -1, reason: 'title_mismatch' };
  }

  const uploaderMatchesArtist =
    ctx.artistTokens.length > 0 &&
    ctx.artistTokens.some(t => candUploaderWordSet.has(t));
  const titleMatchesArtist =
    ctx.artistTokens.length > 0 &&
    ctx.artistTokens.some(t => candTitleWordSet.has(t));
  const artistMatched = uploaderMatchesArtist || titleMatchesArtist;

  if (!uploaderMatchesArtist && ctx.artistTokens.length > 0 && !cand.title.includes('-')) {
    const parenMatch = String(cand.title || '').match(/\(([^)]+)\)\s*$/);
    if (parenMatch) {
      const parenNorm = normalizeText(parenMatch[1]);
      if (ctx.artistTokens.some(t => parenNorm.includes(t))) {
        return { score: -1, reason: 'paren_artist_cover' };
      }
    }
  }

  const compoundCoveredTitleIdx = computeCompoundCoveredIndices(candTitleWords, ctx.allowedWords);
  const foreignTitleWords = candTitleWords.filter(
    (w, idx) =>
      w.length >= 3 &&
      !/^\d+$/.test(w) &&
      !ctx.allowedWords.has(w) &&
      !compoundCoveredTitleIdx.has(idx) &&
      !(allowRelaxedDuration && w === 'extended')
  );

  const embeddedArtistVerified = embeddedArtist.matched && foreignTitleWords.length === 0;
  if (!titleGroupMatched && !embeddedArtistVerified) {
    return { score: -1, reason: 'title_mismatch' };
  }

  const effectiveUploaderArtist = uploaderMatchesArtist || (embeddedArtistVerified && embeddedArtist.viaUploader);
  const effectiveArtistMatched = artistMatched || embeddedArtistVerified;

  if (extractorLower.includes('soundcloud') && !effectiveUploaderArtist) {
    const maxScDurDiff =
      allowRelaxedDuration && (titleMatchesArtist || embeddedArtistVerified) && foreignTitleWords.length === 0
        ? 65
        : 8;
    if (ctx.expectedDurationSec && durDiff > maxScDurDiff) {
      return {
        score: -1,
        reason: `sc_non_uploader_dur_diff(${Math.round(durDiff)}s>${maxScDurDiff}s)`
      };
    }
    if (foreignTitleWords.length > 0) {
      return {
        score: -1,
        reason: `sc_non_uploader_foreign_words(${foreignTitleWords.slice(0, 3).join(',')})`
      };
    }
  }

  const maxForeignForNonUploader =
    effectiveArtistMatched && ctx.expectedDurationSec && durDiff <= 10 ? 2 : 1;
  if (!effectiveUploaderArtist && foreignTitleWords.length > maxForeignForNonUploader) {
    return {
      score: -1,
      reason: `foreign_words(${foreignTitleWords.slice(0, 3).join(',')}>${maxForeignForNonUploader})`
    };
  }

  const exactCleanTitleMatch =
    allowRelaxedDuration &&
    !ctx.expectedDurationSec &&
    foreignTitleWords.length === 0 &&
    Array.isArray(ctx.titleTokens) &&
    ctx.titleTokens.length >= 2 &&
    ctx.titleTokens.every(t => candTitleWordSet.has(t) || candTitleCompounds.has(t));

  if (ctx.artistTokens.length > 0 && !effectiveArtistMatched && !exactCleanTitleMatch) {
    if (!ctx.expectedDurationSec || durDiff > 4 || foreignTitleWords.length > 0) {
      return {
        score: -1,
        reason: `artist_mismatch(durDiff=${Math.round(durDiff)}s,foreign=${foreignTitleWords.length})`
      };
    }
  }

  let score = 100;
  if (exactCleanTitleMatch && !effectiveArtistMatched) {
    score -= 18;
  }

  if (ctx.expectedDurationSec) {
    if (durDiff <= 2) score += 40;
    else if (durDiff <= 5) score += 28;
    else if (durDiff <= 10) score += 14;
    else score -= Math.round(durDiff);
  }

  if (uploaderMatchesArtist) {
    score += 32;
  } else if (embeddedArtistVerified && embeddedArtist.viaUploader) {
    score += 24;
  } else if (titleMatchesArtist) {
    score += 18;
  } else if (embeddedArtistVerified && embeddedArtist.viaTitlePrefix) {
    score += 14;
  }

  if (uploaderLower.endsWith('- topic') || uploaderLower.includes('release - topic')) {
    score += 24;
  }

  if (
    /\b(remaster|remastered|official audio|original audio|radio edit|ncs release)\b/i.test(
      titleLower
    )
  ) {
    score += 14;
  }

  score -= foreignTitleWords.length * 15;

  if (extractorLower.includes('youtube')) {
    score += 38;
    if (
      uploaderMatchesArtist ||
      uploaderLower.endsWith('- topic') ||
      uploaderLower.includes('release - topic')
    ) {
      score += 26;
    }
  } else if (extractorLower.includes('soundcloud')) {
    score += 10;
  }

  return { score, reason: 'ok' };
}

export function scoreCandidate(cand, ctx) {
  return evaluateCandidate(cand, ctx).score;
}

export function scoreLoopCandidate(cand, ctx) {
  if (cand.webpageUrl && isUrlDrmBlocked(cand.webpageUrl)) {
    return null;
  }
  const dur = Number(cand.duration);
  const exp = Number(ctx.expectedDurationSec);
  if (!dur || isNaN(dur) || !exp || exp < 60 || dur < exp * 1.8 || dur > exp * 7.5) {
    return null;
  }

  const repeatCount = Math.round(dur / exp);
  if (repeatCount < 2 || repeatCount > 7) return null;

  const singleCycleSec = dur / repeatCount;
  const cycleDiff = Math.abs(singleCycleSec - exp);
  if (cycleDiff > 10) return null;

  const titleLower = String(cand.title || '').toLowerCase();
  const uploaderLower = String(cand.uploader || '').toLowerCase();
  const urlLower = String(cand.webpageUrl || '').toLowerCase();
  const combinedLower = `${titleLower} ${uploaderLower} ${urlLower}`;

  const bannedLoopTerms = [...CORE_ALTERED_AUDIO_TERMS];
  if (!ctx.rawTitleLower.includes('remix')) bannedLoopTerms.push('remix');
  if (!ctx.rawTitleLower.includes('demo')) bannedLoopTerms.push('(demo)', '[demo]', ' demo');
  if (!ctx.rawTitleLower.includes('live') && !ctx.rawTitleLower.includes('vivo')) {
    bannedLoopTerms.push('live at', 'live in', 'live from', 'en vivo', '(live)', '[live]');
  }

  for (const term of bannedLoopTerms) {
    if (ctx.rawTitleLower.includes(term) || ctx.rawArtistLower.includes(term)) continue;
    if (combinedLower.includes(term)) return null;
  }

  const candTitleNorm = normalizeText(cand.title);
  const candUploaderNorm = normalizeText(cand.uploader);
  const candTitleWords = candTitleNorm.split(/\s+/).filter(Boolean);
  const candTitleWordSet = new Set(candTitleWords);
  const candTitleCompounds = buildWordCompounds(candTitleWords);
  const candUploaderWordSet = new Set(candUploaderNorm.split(/\s+/).filter(Boolean));

  if (!candidateMatchesAnyTitleGroup(candTitleWordSet, candTitleNorm, ctx, candTitleCompounds)) {
    return null;
  }

  const uploaderMatchesArtist =
    ctx.artistTokens.length > 0 &&
    ctx.artistTokens.some(t => candUploaderWordSet.has(t));
  const titleMatchesArtist =
    ctx.artistTokens.length > 0 &&
    ctx.artistTokens.some(t => candTitleWordSet.has(t));
  if (ctx.artistTokens.length > 0 && !uploaderMatchesArtist && !titleMatchesArtist) {
    return null;
  }

  const loopMetaWords = new Set(['10min', 'min', 'minutes', 'minutos', 'loop', 'extended']);
  const compoundCoveredIdx = computeCompoundCoveredIndices(candTitleWords, ctx.allowedWords);
  const foreignWords = candTitleWords.filter(
    (w, idx) =>
      w.length >= 3 &&
      !/^\d+$/.test(w) &&
      !ctx.allowedWords.has(w) &&
      !compoundCoveredIdx.has(idx) &&
      !loopMetaWords.has(w)
  );
  if (foreignWords.length > 1) return null;

  const trimDurationSec = Math.max(
    45,
    Math.floor(Math.min(singleCycleSec, exp))
  );

  return {
    score: Math.round(90 - cycleDiff * 3 - repeatCount * 2 - foreignWords.length * 8),
    trimDurationSec
  };
}

export function evaluateCandidatePool(rawCandidates, ctx, sourceLabel, queryLabel) {
  const tier1 = [];
  const loopTier2 = [];
  const rejections = [];

  for (const c of rawCandidates) {
    const evalRes = evaluateCandidate(c, ctx);
    if (evalRes.score >= 0) {
      tier1.push({ ...c, score: evalRes.score });
      continue;
    }
    const loopInfo = scoreLoopCandidate(c, ctx);
    if (loopInfo) {
      loopTier2.push({ ...c, ...loopInfo });
      continue;
    }
    const shortTitle = String(c.title || '').slice(0, 38);
    rejections.push(`${evalRes.reason}["${shortTitle}"]`);
  }

  if (tier1.length === 0 && loopTier2.length === 0 && rawCandidates.length > 0) {
    for (const c of rawCandidates) {
      const relaxedRes = evaluateCandidate(c, ctx, { allowRelaxedDuration: true });
      if (relaxedRes.score >= 0) {
        tier1.push({ ...c, score: relaxedRes.score, relaxedDuration: true });
      }
    }
  }

  tier1.sort((a, b) => b.score - a.score);
  loopTier2.sort((a, b) => b.score - a.score);

  if (rawCandidates.length === 0) {
    console.log(`[search-filter] ${sourceLabel} "${queryLabel}": 0 raw results returned by yt-dlp`);
  } else if (tier1.length === 0 && loopTier2.length === 0) {
    console.warn(
      `[search-filter] ${sourceLabel} "${queryLabel}": 0/${rawCandidates.length} accepted | rejected: ${rejections.slice(0, 6).join('; ')}`
    );
  } else if (rejections.length > 0) {
    console.log(
      `[search-filter] ${sourceLabel} "${queryLabel}": ${tier1.length}+${loopTier2.length}loop/${rawCandidates.length} accepted | rejected: ${rejections.slice(0, 4).join('; ')}`
    );
  }

  return { tier1, loopTier2 };
}

export function parseCandidateLines(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const seenUrls = new Set();
  const candidates = [];

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [extractor, id, webpageUrl, rawUrl, durationStr, uploader, title] = parts;
    const targetUrl =
      webpageUrl && webpageUrl.startsWith('http')
        ? webpageUrl
        : rawUrl && rawUrl.startsWith('http')
        ? rawUrl
        : null;
    if (!targetUrl || seenUrls.has(targetUrl)) continue;
    seenUrls.add(targetUrl);

    const duration = parseFloat(durationStr);
    candidates.push({
      extractor: extractor || '',
      id: id || '',
      webpageUrl: targetUrl,
      duration: isNaN(duration) ? 0 : duration,
      uploader: uploader && uploader !== 'NA' ? uploader : '',
      title: title && title !== 'NA' ? title : ''
    });
  }

  return candidates;
}

export function buildRejectTitleRegex(rawTitle) {
  const lower = String(rawTitle || '').toLowerCase();
  const banned = [
    'cover',
    'covered',
    'tribute',
    'karaoke',
    'instrumental',
    'nightcore',
    '8d',
    'slowed',
    'reverb',
    'parody',
    'tutorial',
    'lesson',
    '10min',
    '10 minutes',
    'best part',
    'ringtone',
    'animatic',
    'guitar cover',
    'drum cover',
    'piano cover',
    'vocal cover',
    'bass cover',
    'acapella',
    'acappella',
    'jukebox',
    'bornagen',
    'hoodtrap',
    'mylancore'
  ];
  if (!lower.includes('remix')) {
    banned.push('remix', 'bootleg', 'mashup', 'flip', 'rework');
  }
  if (!lower.includes('live') && !lower.includes('vivo')) {
    banned.push('live at', 'live in', 'live from', 'en vivo');
  }
  const activeBanned = banned.filter(w => !lower.includes(w));
  if (activeBanned.length === 0) return null;
  return `(?i)\\b(${activeBanned.join('|')})\\b`;
}
