import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import {
  getDownloadsDir,
  getSessionUser,
  enforceStorageQuota,
  scheduleFileCleanup,
  getYtCookiesFilePath,
  registerActiveRawJob,
  unregisterActiveRawJob
} from '../../../lib/store';

if (!global.__activeDownloads) {
  global.__activeDownloads = new Map();
}
const activeDownloads = global.__activeDownloads;

function parsePositiveIntEnv(name, fallback, min = 1, max = 500) {
  const parsed = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

const MAX_NET_DOWNLOADS = parsePositiveIntEnv('MAX_NET_DOWNLOADS', 4, 1, 16);
const MAX_CPU_JOBS = parsePositiveIntEnv('MAX_CPU_JOBS', 2, 1, 8);
const MAX_PER_USER = parsePositiveIntEnv('MAX_PER_USER', 2, 1, 8);
const MAX_QUEUED_PER_USER = parsePositiveIntEnv('MAX_QUEUED_PER_USER', 50, 1, 500);

if (!global.__extractionPools) {
  global.__extractionPools = {
    netRunning: 0,
    netActiveByUser: new Map(),
    netQueuesByUser: new Map(),
    netTurnOrder: [],
    cpuRunning: 0,
    cpuActiveByUser: new Map(),
    cpuQueuesByUser: new Map(),
    cpuTurnOrder: []
  };
}
const pools = global.__extractionPools;
if (!pools.cpuActiveByUser) {
  pools.cpuActiveByUser = new Map();
}

function getUserQueuedCount(userId) {
  const uid = String(userId || 'anon');
  const q = pools.netQueuesByUser.get(uid);
  return q ? q.length : 0;
}

function pumpNetQueue() {
  while (pools.netRunning < MAX_NET_DOWNLOADS && pools.netTurnOrder.length > 0) {
    let pickedIndex = -1;
    for (let i = 0; i < pools.netTurnOrder.length; i++) {
      const candidateUid = pools.netTurnOrder[i];
      const q = pools.netQueuesByUser.get(candidateUid);
      if (!q || q.length === 0) {
        pools.netQueuesByUser.delete(candidateUid);
        pools.netTurnOrder.splice(i, 1);
        i -= 1;
        continue;
      }
      const userActive = pools.netActiveByUser.get(candidateUid) || 0;
      if (userActive < MAX_PER_USER) {
        pickedIndex = i;
        break;
      }
    }

    if (pickedIndex === -1) break;

    const [uid] = pools.netTurnOrder.splice(pickedIndex, 1);
    const q = pools.netQueuesByUser.get(uid);
    const entry = q.shift();
    if (q.length > 0) {
      pools.netTurnOrder.push(uid);
    } else {
      pools.netQueuesByUser.delete(uid);
    }

    pools.netRunning += 1;
    pools.netActiveByUser.set(uid, (pools.netActiveByUser.get(uid) || 0) + 1);

    let slotReleased = false;
    const releaseNetSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      pools.netRunning = Math.max(0, pools.netRunning - 1);
      const curUserActive = (pools.netActiveByUser.get(uid) || 1) - 1;
      if (curUserActive <= 0) {
        pools.netActiveByUser.delete(uid);
      } else {
        pools.netActiveByUser.set(uid, curUserActive);
      }
      pumpNetQueue();
    };

    Promise.resolve()
      .then(() => entry.fn(releaseNetSlot))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        releaseNetSlot();
      });
  }
}

function enqueueNetDownload(userId, downloadId, isManualRequest, taskFn) {
  const uid = String(userId || 'anon');
  return new Promise((resolve, reject) => {
    let userQueue = pools.netQueuesByUser.get(uid);
    if (!userQueue) {
      userQueue = [];
      pools.netQueuesByUser.set(uid, userQueue);
    }
    if (!pools.netTurnOrder.includes(uid)) {
      pools.netTurnOrder.push(uid);
    }

    // Server-controlled priority: a single manual download can move ahead of the same user's bulk items,
    // but never bypasses the round-robin turn order of other users.
    const hasQueuedManual = userQueue.some(e => e.isManualPriority);
    const grantLocalPriority = Boolean(isManualRequest) && !hasQueuedManual;
    const entry = {
      downloadId,
      isManualPriority: grantLocalPriority,
      fn: taskFn,
      resolve,
      reject
    };

    if (grantLocalPriority) {
      userQueue.unshift(entry);
    } else {
      userQueue.push(entry);
    }
    pumpNetQueue();
  });
}

function acquireContinuationNetSlot(userId) {
  return new Promise(resolve => {
    enqueueNetDownload(userId, null, true, releaseSlot => {
      return new Promise(done => {
        resolve(() => {
          releaseSlot();
          done();
        });
      });
    });
  });
}

function pumpCpuQueue() {
  while (pools.cpuRunning < MAX_CPU_JOBS && pools.cpuTurnOrder.length > 0) {
    const uid = pools.cpuTurnOrder.shift();
    const q = pools.cpuQueuesByUser.get(uid);
    if (!q || q.length === 0) {
      pools.cpuQueuesByUser.delete(uid);
      continue;
    }

    const entry = q.shift();
    if (q.length > 0) {
      pools.cpuTurnOrder.push(uid);
    } else {
      pools.cpuQueuesByUser.delete(uid);
    }

    pools.cpuRunning += 1;
    pools.cpuActiveByUser.set(uid, (pools.cpuActiveByUser.get(uid) || 0) + 1);
    if (typeof entry.onSlotAcquired === 'function') {
      try {
        entry.onSlotAcquired();
      } catch {}
    }
    Promise.resolve()
      .then(() => entry.fn())
      .then(entry.resolve, entry.reject)
      .finally(() => {
        pools.cpuRunning = Math.max(0, pools.cpuRunning - 1);
        const curCpuActive = (pools.cpuActiveByUser.get(uid) || 1) - 1;
        if (curCpuActive <= 0) {
          pools.cpuActiveByUser.delete(uid);
        } else {
          pools.cpuActiveByUser.set(uid, curCpuActive);
        }
        pumpCpuQueue();
      });
  }
}

function enqueueCpuJob(userId, taskFn, onSlotAcquired = null) {
  const uid = String(userId || 'anon');
  return new Promise((resolve, reject) => {
    let q = pools.cpuQueuesByUser.get(uid);
    if (!q) {
      q = [];
      pools.cpuQueuesByUser.set(uid, q);
    }
    if (!pools.cpuTurnOrder.includes(uid)) {
      pools.cpuTurnOrder.push(uid);
    }
    q.push({ fn: taskFn, onSlotAcquired, resolve, reject });
    pumpCpuQueue();
  });
}

function getPoolStatus(userId = null, downloadId = null) {
  const uid = String(userId || 'anon');
  const userNetActive = pools.netActiveByUser.get(uid) || 0;
  const userCpuActive = pools.cpuActiveByUser.get(uid) || 0;
  const userActive = userNetActive + userCpuActive;
  const userQueue = pools.netQueuesByUser.get(uid) || [];
  const userQueued = userQueue.length;

  let aheadInQueue = 0;
  const targetIdx = downloadId
    ? userQueue.findIndex(e => e.downloadId === downloadId)
    : userQueued > 0
    ? 0
    : -1;

  if (targetIdx >= 0) {
    const turnPos = pools.netTurnOrder.indexOf(uid);
    for (let i = 0; i < pools.netTurnOrder.length; i++) {
      const otherUid = pools.netTurnOrder[i];
      const otherLen = pools.netQueuesByUser.get(otherUid)?.length || 0;
      if (otherUid === uid) {
        aheadInQueue += targetIdx;
      } else if (turnPos === -1 || i < turnPos) {
        aheadInQueue += Math.min(otherLen, targetIdx + 1);
      } else {
        aheadInQueue += Math.min(otherLen, targetIdx);
      }
    }
  }

  return {
    active: userActive,
    queued: userQueued,
    aheadInQueue,
    statusText: aheadInQueue > 0 ? `${aheadInQueue} delante de ti` : null,
    max: MAX_PER_USER,
    maxQueued: MAX_QUEUED_PER_USER
  };
}

const ALLOWED_MEDIA_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'soundcloud.com',
  'www.soundcloud.com',
  'm.soundcloud.com',
  'on.soundcloud.com'
]);

export function isAllowedMediaUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_MEDIA_HOSTS.has(host);
  } catch {
    return false;
  }
}

function sanitizeSearchQuery(raw) {
  return String(raw || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[^\p{L}\p{N}\s.,'&()-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

let cachedLinuxYtDlpBin = null;

function resolveYtDlpCommand(extraArgs) {
  const configuredBin = process.env.YTDLP_BIN?.trim();
  if (configuredBin) {
    return { cmd: configuredBin, args: extraArgs };
  }
  if (process.platform === 'win32') {
    return { cmd: 'python', args: ['-m', 'yt_dlp', ...extraArgs] };
  }
  if (!cachedLinuxYtDlpBin) {
    const cwd = process.cwd();
    const home = os.homedir();
    const candidates = [
      path.join(cwd, 'venv', 'bin', 'yt-dlp'),
      path.join(cwd, '.venv', 'bin', 'yt-dlp'),
      path.join(home, 'venv', 'bin', 'yt-dlp'),
      path.join(home, '.venv', 'bin', 'yt-dlp'),
      path.join(home, '.local', 'bin', 'yt-dlp')
    ];
    cachedLinuxYtDlpBin =
      candidates.find(p => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      }) || 'yt-dlp';
  }
  return { cmd: cachedLinuxYtDlpBin, args: extraArgs };
}

function sanitizeSlug(text) {
  const clean = (text || 'track')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s\-_]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return (clean || 'track').slice(0, 60);
}

function normalizeText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripRemasterNoise(raw) {
  return String(raw || '')
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

function stripParentheticalSubtitles(raw) {
  const stripped = String(raw || '')
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 3 ? stripped : String(raw || '').trim();
}

function cleanArtistName(raw) {
  const first = String(raw || '')
    .split(/[,;&]/)[0]
    .replace(/(archive|archives|vault|topic|reupload|official)$/i, '')
    .replace(/\b(archive|archives|vault|topic|reupload|official|artista|guardado en dispositivo)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return first;
}

function getArtistTokens(rawArtist) {
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
    .filter(w => w.length >= 3 && !stopWords.has(w));
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

function extractMeaningfulTokens(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(w => w.length >= 2 && !TITLE_STOP_WORDS.has(w));
}

function getTitleCoreTokens(cleanTitle) {
  const primaryPart = stripParentheticalSubtitles(cleanTitle);
  const primaryTokens = extractMeaningfulTokens(primaryPart);
  if (primaryTokens.length > 0) {
    return primaryTokens;
  }
  const tokens = extractMeaningfulTokens(cleanTitle);
  return tokens.length > 0 ? tokens : normalizeText(cleanTitle).split(/\s+/).filter(Boolean);
}

function extractParentheticalTokenGroups(rawText) {
  const groups = [];
  const regex = /[\(\[]([^\)\]]+)[\)\]]/g;
  let match;
  while ((match = regex.exec(String(rawText || ''))) !== null) {
    const inner = stripRemasterNoise(match[1]);
    if (!inner || /\b(feat|ft|with|prod|remix|live|vivo|cover|karaoke)\b/i.test(inner)) {
      continue;
    }
    const tokens = extractMeaningfulTokens(inner);
    if (tokens.length > 0) {
      groups.push(tokens);
    }
  }
  return groups;
}

function parseDurationToSec(rawDur) {
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

// Universal catalog lookup (iTunes + Deezer in parallel):
// Resolves the canonical studio duration, canonical title/artist (even when artist was missing or combined in title),
// AND collects official alternate/parenthetical titles and album words.
async function resolveCatalogMetadata(rawDuration, cleanTitle, primaryArtist) {
  const parsed = parseDurationToSec(rawDuration);
  const extraWords = new Set();
  const extraTokenGroups = [];
  let canonicalTitle = null;
  let canonicalArtist = null;

  const query = `${stripParentheticalSubtitles(cleanTitle)} ${primaryArtist || ''}`.trim();
  if (!query) {
    return {
      durationSec: parsed || null,
      canonicalTitle: null,
      canonicalArtist: null,
      catalogWords: extraWords,
      catalogTokenGroups: extraTokenGroups
    };
  }

  const titleTokens = getTitleCoreTokens(cleanTitle);
  const artistTokens = getArtistTokens(primaryArtist);
  const wantLive = /\b(live|vivo)\b/i.test(cleanTitle);

  const matchCatalogTrack = (trackTitle, trackArtist, sec) => {
    if (!sec || sec < 45 || sec > 1200) return false;
    const hTitle = normalizeText(trackTitle);
    const hArtist = normalizeText(trackArtist);
    if (!wantLive && /\b(live|vivo)\b/i.test(hTitle)) return false;

    if (artistTokens.length > 0) {
      const tOk = titleTokens.every(t => hTitle.includes(t));
      const aOk = artistTokens.some(t => hArtist.includes(t));
      return tOk && aOk;
    }

    // When primaryArtist was empty/generic (e.g. Offline PWA "Two Door Cinema Club I Can Talk"),
    // verify that all query tokens match across the catalog track's title + artist combined
    const hCombined = `${hTitle} ${hArtist}`;
    const hTitleCore = getTitleCoreTokens(stripRemasterNoise(trackTitle));
    return (
      titleTokens.every(t => hCombined.includes(t)) &&
      hTitleCore.length > 0 &&
      hTitleCore.every(t => normalizeText(cleanTitle).includes(t))
    );
  };

  const harvestTrackMeta = (trackTitle, trackArtist, albumTitle) => {
    if (!canonicalTitle && trackTitle) {
      canonicalTitle = stripRemasterNoise(trackTitle) || trackTitle;
    }
    if (!canonicalArtist && trackArtist) {
      canonicalArtist = cleanArtistName(trackArtist) || trackArtist;
    }
    for (const w of normalizeText(`${trackTitle || ''} ${trackArtist || ''} ${albumTitle || ''}`).split(/\s+/)) {
      if (w && w.length >= 2) extraWords.add(w);
    }
    for (const grp of extractParentheticalTokenGroups(trackTitle)) {
      extraTokenGroups.push(grp);
    }
    const core = getTitleCoreTokens(stripRemasterNoise(trackTitle));
    if (core.length > 0) {
      extraTokenGroups.push(core);
    }
  };

  const fetchItunes = async () => {
    try {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
        query
      )}&media=music&entity=song&limit=6`;
      const res = await fetch(itunesUrl, { signal: AbortSignal.timeout(2200) });
      if (!res.ok) return null;
      const data = await res.json();
      const hits = Array.isArray(data?.results) ? data.results : [];
      for (const h of hits) {
        const sec = h.trackTimeMillis ? Math.round(h.trackTimeMillis / 1000) : null;
        if (matchCatalogTrack(h.trackName, h.artistName, sec)) {
          harvestTrackMeta(h.trackName, h.artistName, h.collectionName);
          return sec;
        }
      }
    } catch {}
    return null;
  };

  const fetchDeezer = async () => {
    try {
      const dzUrl = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=6`;
      const res = await fetch(dzUrl, { signal: AbortSignal.timeout(2200) });
      if (!res.ok) return null;
      const data = await res.json();
      const hits = Array.isArray(data?.data) ? data.data : [];
      for (const h of hits) {
        const sec = Number(h.duration);
        if (matchCatalogTrack(h.title, h.artist?.name, sec)) {
          harvestTrackMeta(h.title, h.artist?.name, h.album?.title);
          return sec;
        }
      }
    } catch {}
    return null;
  };

  const [itSec, dzSec] = await Promise.all([fetchItunes(), fetchDeezer()]);
  let durationSec = parsed && parsed <= 420 ? parsed : null;
  if (!durationSec) {
    if (itSec && dzSec) {
      durationSec = Math.abs(itSec - dzSec) <= 8 ? Math.min(itSec, dzSec) : dzSec;
    } else {
      durationSec = dzSec || itSec || parsed || null;
    }
  }

  return {
    durationSec,
    canonicalTitle,
    canonicalArtist,
    catalogWords: extraWords,
    catalogTokenGroups: extraTokenGroups
  };
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
  'wav',
  'flac',
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

function buildCandidateContext(rawTitle, cleanTitle, rawArtist, expectedDurationSec, catalogMeta = null) {
  const rawTitleNorm = normalizeText(rawTitle);
  const cleanTitleNorm = normalizeText(cleanTitle);
  const rawArtistNorm = normalizeText(rawArtist);
  const titleTokens = getTitleCoreTokens(cleanTitle);
  const artistTokens = getArtistTokens(rawArtist);

  // Build alternative title token groups so songs with parenthetical titles (e.g. "Title A (Title B)")
  // match uploads titled with either Title A, Title B, or both
  const titleTokenGroups = [titleTokens];
  const artistTokenSet = new Set(artistTokens);
  const nonArtistPrimary = titleTokens.filter(t => !artistTokenSet.has(t));
  if (nonArtistPrimary.length >= 2 && nonArtistPrimary.length < titleTokens.length) {
    titleTokenGroups.push(nonArtistPrimary);
  }
  for (const grp of extractParentheticalTokenGroups(rawTitle)) {
    titleTokenGroups.push(grp);
  }
  if (catalogMeta?.catalogTokenGroups) {
    for (const grp of catalogMeta.catalogTokenGroups) {
      titleTokenGroups.push(grp);
    }
  }

  const allowedWords = new Set(STANDARD_AUDIO_METADATA_WORDS);
  for (const w of `${rawTitleNorm} ${cleanTitleNorm} ${rawArtistNorm}`.split(/\s+/)) {
    if (w) allowedWords.add(w);
  }
  if (catalogMeta?.catalogWords) {
    for (const w of catalogMeta.catalogWords) {
      if (w) allowedWords.add(w);
    }
  }

  return {
    rawTitleLower: String(rawTitle || '').toLowerCase(),
    rawArtistLower: String(rawArtist || '').toLowerCase(),
    titleTokens,
    titleTokenGroups,
    artistTokens,
    allowedWords,
    expectedDurationSec
  };
}

function candidateMatchesAnyTitleGroup(candTitleWordSet, candTitleNorm, ctx) {
  const groups =
    Array.isArray(ctx.titleTokenGroups) && ctx.titleTokenGroups.length > 0
      ? ctx.titleTokenGroups
      : [ctx.titleTokens || []];

  for (const group of groups) {
    if (!group || group.length === 0) continue;
    const matchedCount = group.filter(
      t => candTitleWordSet.has(t) || candTitleNorm.includes(t)
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

function scoreCandidate(cand, ctx) {
  const dur = Number(cand.duration);
  if (!dur || isNaN(dur) || dur < 45 || dur > 900) {
    return -1;
  }

  let durDiff = 0;
  if (ctx.expectedDurationSec && ctx.expectedDurationSec >= 50) {
    durDiff = Math.abs(dur - ctx.expectedDurationSec);
    if (durDiff > 20) {
      return -1;
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
    'loop',
    'extended version',
    'extended mix'
  ];

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
      return -1;
    }
  }

  // Reject cover bands that credit the original artist via "(by Beatles)"
  if (/\(\s*by\s+[^)]+\)/i.test(cand.title || '')) {
    return -1;
  }

  const candTitleNorm = normalizeText(cand.title);
  const candUploaderNorm = normalizeText(cand.uploader);
  const candTitleWords = candTitleNorm.split(/\s+/).filter(Boolean);
  const candTitleWordSet = new Set(candTitleWords);
  const candUploaderWordSet = new Set(candUploaderNorm.split(/\s+/).filter(Boolean));

  // Verify title matches primary title OR any official parenthetical/catalog alternate title
  if (!candidateMatchesAnyTitleGroup(candTitleWordSet, candTitleNorm, ctx)) {
    return -1;
  }

  // Verify artist match with strict word boundary (so "thejukebox" doesn't count as "the")
  const uploaderMatchesArtist =
    ctx.artistTokens.length > 0 &&
    ctx.artistTokens.some(t => candUploaderWordSet.has(t));
  const titleMatchesArtist =
    ctx.artistTokens.length > 0 &&
    ctx.artistTokens.some(t => candTitleWordSet.has(t));
  const artistMatched = uploaderMatchesArtist || titleMatchesArtist;

  // Reject unlabeled covers formatted as "heaven (bryan adams)" by random uploaders
  if (!uploaderMatchesArtist && ctx.artistTokens.length > 0 && !cand.title.includes('-')) {
    const parenMatch = String(cand.title || '').match(/\(([^)]+)\)\s*$/);
    if (parenMatch) {
      const parenNorm = normalizeText(parenMatch[1]);
      if (ctx.artistTokens.some(t => parenNorm.includes(t))) {
        return -1;
      }
    }
  }

  // Count foreign words in the candidate title that don't belong to the song title, artist, album, or audio metadata
  const foreignTitleWords = candTitleWords.filter(
    w => w.length >= 3 && !/^\d+$/.test(w) && !ctx.allowedWords.has(w)
  );
  const extractorLower = String(cand.extractor || '').toLowerCase();

  // On SoundCloud, when the official artist track is a 30s Go+ preview, random users often upload
  // unlabeled home covers (14-18s off studio duration) or festival bootlegs ("Glastonbury 2019", "Deichbrand 2019").
  // For non-artist SoundCloud uploaders, require studio duration within ±8s and 0 unknown foreign words.
  if (extractorLower.includes('soundcloud') && !uploaderMatchesArtist) {
    if (ctx.expectedDurationSec && durDiff > 8) {
      return -1;
    }
    if (foreignTitleWords.length > 0) {
      return -1;
    }
  }

  // If the uploader is NOT the artist: allow up to 2 extra words on YouTube when artist+duration match closely (±10s),
  // otherwise reject at 2+ unrelated foreign words.
  const maxForeignForNonUploader =
    artistMatched && ctx.expectedDurationSec && durDiff <= 10 ? 2 : 1;
  if (!uploaderMatchesArtist && foreignTitleWords.length > maxForeignForNonUploader) {
    return -1;
  }

  // If neither uploader nor title mentions the artist, only allow when duration matches within ±4s with 0 foreign title words
  if (ctx.artistTokens.length > 0 && !artistMatched) {
    if (!ctx.expectedDurationSec || durDiff > 4 || foreignTitleWords.length > 0) {
      return -1;
    }
  }

  let score = 100;

  if (ctx.expectedDurationSec) {
    if (durDiff <= 2) score += 40;
    else if (durDiff <= 5) score += 28;
    else if (durDiff <= 10) score += 14;
    else score -= Math.round(durDiff);
  }

  if (uploaderMatchesArtist) {
    score += 32;
  } else if (titleMatchesArtist) {
    score += 18;
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
    // YouTube is #1 priority for official master recordings
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

  return score;
}

// Smart detector for anti-copyright looped uploads on SoundCloud (e.g. "Intruso - Enjambre" uploaded as 3x = 608.4s).
// When matched, returns the exact single-play duration (dur / repeatCount) so ffmpeg trims it to 1x studio length!
function scoreLoopCandidate(cand, ctx) {
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
  const candUploaderWordSet = new Set(candUploaderNorm.split(/\s+/).filter(Boolean));

  if (!candidateMatchesAnyTitleGroup(candTitleWordSet, candTitleNorm, ctx)) {
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
  const foreignWords = candTitleWords.filter(
    w =>
      w.length >= 3 &&
      !/^\d+$/.test(w) &&
      !ctx.allowedWords.has(w) &&
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

function discoverCandidatesFromSearch(searchQueries, timeoutMs = 10000) {
  return new Promise(resolve => {
    // Do NOT pass --cookies during --flat-playlist metadata search: public search metadata never
    // requires login and omitting cookies prevents Google session rotation / account flagging.
    const ytdlpArgs = [
      '--flat-playlist',
      '--ignore-errors',
      '--no-warnings',
      '--socket-timeout', '8',
      '--js-runtimes', 'node',
      '--print', '%(extractor)s\t%(id)s\t%(webpage_url)s\t%(url)s\t%(duration)s\t%(uploader)s\t%(title)s',
      '--',
      ...searchQueries
    ];

    const { cmd, args } = resolveYtDlpCommand(ytdlpArgs);
    let stdoutText = '';
    let settled = false;

    let child;
    try {
      child = spawn(cmd, args);
    } catch {
      return resolve([]);
    }

    const finish = list => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(list);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(parseCandidateLines(stdoutText));
    }, timeoutMs);

    child.stdout.on('data', d => {
      stdoutText += d.toString();
    });

    child.on('error', () => {
      finish(parseCandidateLines(stdoutText));
    });

    child.on('close', () => {
      finish(parseCandidateLines(stdoutText));
    });
  });
}

function parseCandidateLines(rawText) {
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

function buildRejectTitleRegex(rawTitle) {
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

function runYtDlpAttempt(target, outputTemplate, options, onProgress) {
  const {
    isSearchPool = false,
    minDuration = 55,
    maxDuration = 900,
    matchTitleRegex = null,
    rejectTitleRegex = null,
    useCookies = false
  } = options || {};

  return new Promise(resolve => {
    const isYouTubeTarget = /youtube\.com|youtu\.be|^ytsearch/i.test(String(target || ''));
    const isBilibiliTarget = /^bilisearch|bilibili\.com/i.test(String(target || ''));
    const masterCookiesPath = isYouTubeTarget && useCookies ? getYtCookiesFilePath() : null;
    let tempCookiesPath = null;

    if (masterCookiesPath) {
      try {
        tempCookiesPath = path.join(
          os.tmpdir(),
          `mma_ytc_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.txt`
        );
        fs.copyFileSync(masterCookiesPath, tempCookiesPath);
        try {
          fs.chmodSync(tempCookiesPath, 0o600);
        } catch {}
      } catch {
        tempCookiesPath = null;
      }
    }

    // Paso A (Network stage): Download native AAC/m4a stream (or best audio fallback) without re-encoding or fixup
    const ytdlpArgs = [
      '-f', 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best',
      '--fixup', 'never',
      '--no-simulate',
      '--progress',
      '--newline',
      '--progress-template', 'download:[download] %(progress._percent_str)s',
      '--print', 'after_move:%(acodec)s',
      '--print', 'after_move:filepath',
      '--restrict-filenames',
      '--ignore-errors',
      '--no-warnings',
      '--js-runtimes', 'node',
      '--socket-timeout', '15',
      '-o', outputTemplate
    ];

    if (tempCookiesPath) {
      ytdlpArgs.push('--cookies', tempCookiesPath);
    }

    if (isYouTubeTarget) {
      // Mobile Web (mweb) + local yt-dlp-ejs JS solver (node) + bgutil PO-Token
      ytdlpArgs.push('--extractor-args', 'youtube:player_client=mweb,web');
    }

    if (isBilibiliTarget) {
      // Prevent HTTP 412 Precondition Failed on Bilibili search API
      ytdlpArgs.push('--add-header', 'Referer:https://search.bilibili.com/');
    }

    if (isSearchPool) {
      ytdlpArgs.push('--match-filter', `duration >= ${minDuration} & duration <= ${maxDuration}`);
      if (matchTitleRegex) {
        ytdlpArgs.push('--match-title', matchTitleRegex);
      }
      if (rejectTitleRegex) {
        ytdlpArgs.push('--reject-title', rejectTitleRegex);
      }
      ytdlpArgs.push('--max-downloads', '1');
    } else {
      ytdlpArgs.push('--no-playlist');
    }

    // Use '--' separator to prevent option/flag injection
    ytdlpArgs.push('--', target);

    const { cmd, args } = resolveYtDlpCommand(ytdlpArgs);
    let stdoutText = '';
    let stderrText = '';
    let settled = false;

    const cleanupTempCookies = () => {
      if (tempCookiesPath) {
        try {
          fs.unlinkSync(tempCookiesPath);
        } catch {}
        tempCookiesPath = null;
      }
    };

    let child;
    try {
      child = spawn(cmd, args);
    } catch (err) {
      cleanupTempCookies();
      return resolve({ ok: false, error: err.message });
    }

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      cleanupTempCookies();
      resolve(result);
    };

    // 60s timeout for Paso A (Network download)
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, error: 'Tiempo de espera agotado en descarga (Paso A)' });
    }, 60000);

    const handleProgressText = text => {
      if (!onProgress) return;
      const matches = [...text.matchAll(/\[download\]\s+([\d\.]+)%/g)];
      if (matches.length > 0) {
        const pct = parseFloat(matches[matches.length - 1][1]);
        if (Number.isFinite(pct)) {
          onProgress(pct);
        }
      }
    };

    child.stdout.on('data', d => {
      const text = d.toString();
      stdoutText += text;
      handleProgressText(text);
    });

    child.stderr.on('data', d => {
      const text = d.toString();
      handleProgressText(text);
      const nonProgressLines = text
        .split(/\r?\n/)
        .filter(line => !/^\[download\]\s+[\d\.]+%\s*$/.test(line.trim()))
        .join('\n');
      if (nonProgressLines.trim()) {
        stderrText += `${nonProgressLines}\n`;
      }
    });

    child.on('error', err => {
      finish({ ok: false, error: err.message });
    });

    child.on('close', code => {
      // With --progress --newline --progress-template, yt-dlp emits progress on stdout before after_move lines
      const outLines = stdoutText
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !/^\[download\]\s+[\d\.]+%\s*$/.test(l));
      const filepath = outLines.length >= 1 ? outLines[outLines.length - 1] : null;
      const acodec = outLines.length >= 2 ? outLines[outLines.length - 2] : null;
      // Exit code 101 in yt-dlp means --max-downloads limit was reached after downloading the 1st valid full song
      finish({
        ok: code === 0 || code === 101,
        code,
        acodec,
        filepath,
        error: stderrText.slice(-300)
      });
    });
  });
}

function findRawStageFile(downloadsDir, baseSlug, reportedPath = null) {
  if (reportedPath) {
    try {
      const resolved = path.resolve(reportedPath);
      if (
        resolved.startsWith(path.resolve(downloadsDir) + path.sep) &&
        fs.existsSync(resolved) &&
        fs.statSync(resolved).size > 0
      ) {
        return resolved;
      }
    } catch {}
  }
  try {
    const files = fs.readdirSync(downloadsDir);
    const match = files.find(
      f =>
        f.startsWith(`${baseSlug}.raw.`) &&
        !/\.(part|ytdl|temp)$/i.test(f)
    );
    return match ? path.join(downloadsDir, match) : null;
  } catch {
    return null;
  }
}

function cleanupRawStageFiles(downloadsDir, baseSlug) {
  try {
    const files = fs.readdirSync(downloadsDir);
    for (const f of files) {
      if (f.startsWith(`${baseSlug}.raw.`) || f.startsWith(`${baseSlug}__`)) {
        try {
          fs.unlinkSync(path.join(downloadsDir, f));
        } catch {}
      }
    }
  } catch {}
}

function spawnFfmpegOnce(ffmpegBin, ffmpegArgs, timeoutMs = 30000) {
  return new Promise(resolve => {
    let stderrText = '';
    let settled = false;
    let child;
    try {
      child = spawn(ffmpegBin, ffmpegArgs);
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, error: 'Tiempo de espera agotado en ffmpeg (Paso B)' });
    }, timeoutMs);

    child.stderr.on('data', d => {
      stderrText += d.toString();
    });

    child.on('error', err => {
      finish({ ok: false, error: err.message });
    });

    child.on('close', code => {
      finish({ ok: code === 0, code, error: stderrText.slice(-300) });
    });
  });
}

async function runFfmpegPostProcess(rawFilePath, outputM4aPath, options = {}) {
  const {
    acodec = '',
    trimDurationSec = null,
    title = '',
    artist = '',
    album = ''
  } = options;

  const ffmpegBin = process.env.FFMPEG_BIN?.trim() || 'ffmpeg';
  const isNativeAac =
    /^(mp4a|aac)/i.test(String(acodec || '').trim()) || /\.raw\.m4a$/i.test(rawFilePath);

  const buildArgs = useCopy => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', rawFilePath, '-vn'];
    if (trimDurationSec && trimDurationSec >= 45) {
      args.push('-t', String(Math.round(trimDurationSec)));
    }
    if (useCopy) {
      args.push('-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
    } else {
      args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '44100');
    }
    args.push('-map_metadata', '0');
    if (title) args.push('-metadata', `title=${String(title)}`);
    if (artist) args.push('-metadata', `artist=${String(artist)}`);
    if (album) args.push('-metadata', `album=${String(album)}`);
    args.push('-movflags', '+faststart', outputM4aPath);
    return args;
  };

  // 30s timeout for Paso B (CPU remux or AAC conversion)
  const firstRes = await spawnFfmpegOnce(ffmpegBin, buildArgs(isNativeAac), 30000);
  if (firstRes.ok && fs.existsSync(outputM4aPath)) {
    return firstRes;
  }

  // Fallback: if stream copy failed on an unusual container, transcode to AAC 160k
  if (isNativeAac && fs.existsSync(rawFilePath)) {
    return spawnFfmpegOnce(ffmpegBin, buildArgs(false), 30000);
  }
  return firstRes;
}

function finalizeDownloadedMp3(downloadsDir, baseSlug, expectedAudioPath, expectedDurationSec = null) {
  const minValidBytes = expectedDurationSec
    ? Math.max(380 * 1024, Math.min(1050 * 1024, Math.round(expectedDurationSec * 6200)))
    : 380 * 1024;

  const validateExistingAudio = filePath => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      if (stat.size <= minValidBytes) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
        return null;
      }
      return {
        valid: true,
        filename: path.basename(filePath),
        filePath
      };
    } catch {
      return null;
    }
  };

  try {
    const files = fs.readdirSync(downloadsDir);
    const candidateName =
      files.find(f => f.startsWith(`${baseSlug}__`) && f.toLowerCase().endsWith('.m4a')) ||
      files.find(f => f.startsWith(`${baseSlug}__`) && f.toLowerCase().endsWith('.mp3'));

    // Clean up any leftover temp artifacts from failed attempts for this slug
    for (const f of files) {
      if (f.startsWith(`${baseSlug}__`) && f !== candidateName) {
        try {
          fs.unlinkSync(path.join(downloadsDir, f));
        } catch {}
      }
    }

    if (!candidateName) {
      const checkedM4a = validateExistingAudio(path.join(downloadsDir, `${baseSlug}.m4a`));
      if (checkedM4a) return checkedM4a;
      const checkedExpected = validateExistingAudio(expectedAudioPath);
      if (checkedExpected) return checkedExpected;
      return { valid: false, filename: null, filePath: null };
    }

    const candidatePath = path.join(downloadsDir, candidateName);
    const stat = fs.statSync(candidatePath);
    if (stat.size <= minValidBytes) {
      try {
        fs.unlinkSync(candidatePath);
      } catch {}
      return { valid: false, filename: null, filePath: null };
    }

    const ext = path.extname(candidateName).toLowerCase() || '.m4a';
    const finalFilename = `${baseSlug}${ext}`;
    const finalFilePath = path.join(downloadsDir, finalFilename);

    if (fs.existsSync(finalFilePath)) {
      try {
        fs.unlinkSync(finalFilePath);
      } catch {}
    }
    fs.renameSync(candidatePath, finalFilePath);
    return { valid: true, filename: finalFilename, filePath: finalFilePath };
  } catch {
    const checkedM4a = validateExistingAudio(path.join(downloadsDir, `${baseSlug}.m4a`));
    if (checkedM4a) return checkedM4a;
    const checkedExpected = validateExistingAudio(expectedAudioPath);
    if (checkedExpected) return checkedExpected;
    return { valid: false, filename: null, filePath: null };
  }
}

async function runExtractionPipeline(
  downloadId,
  rawQuery,
  downloadsDir,
  baseSlug,
  userId,
  initialReleaseNetSlot
) {
  const item = activeDownloads.get(downloadId);
  if (!item) return;

  let releaseNetSlot = initialReleaseNetSlot;
  let netSlotReleased = false;

  registerActiveRawJob(baseSlug);
  try {
    const rawOutputTemplate = path.join(downloadsDir, `${baseSlug}.raw.%(ext)s`);
    const expectedM4aName = `${baseSlug}.m4a`;
    const expectedM4aPath = path.join(downloadsDir, expectedM4aName);

    const updateProg = p => {
      const cur = activeDownloads.get(downloadId);
      if (cur) cur.progress = Math.max(cur.progress || 8, Math.min(98, p));
    };

    const rawTitle = String(item.title || rawQuery || '').trim();
    let cleanTitle = stripRemasterNoise(rawTitle) || rawTitle;
    let primaryArtist = cleanArtistName(item.artist);
    if (!primaryArtist && /\s+[-–—]\s+/.test(cleanTitle)) {
      const parts = cleanTitle.split(/\s+[-–—]\s+/);
      if (parts.length >= 2 && parts[0].trim().length >= 2) {
        primaryArtist = cleanArtistName(parts[0]);
        cleanTitle = parts.slice(1).join(' - ').trim() || cleanTitle;
      }
    }
    const rejectTitleRegex = buildRejectTitleRegex(cleanTitle);

    let targets = [];
    let expectedDurationSec = null;
    let metaTitle = cleanTitle;
    let metaArtist = primaryArtist || String(item.artist || '').trim();
    let metaAlbum = String(item.album || '').trim();

    if (/^https?:\/\//i.test(rawQuery)) {
      if (!isAllowedMediaUrl(rawQuery)) {
        item.status = 'error';
        item.error = 'Dominio de URL no permitido.';
        return;
      }
      targets = [{ url: rawQuery, isSearchPool: false }];
    } else {
      const primaryTitle = stripParentheticalSubtitles(cleanTitle);
      const artistAndCleanTitle = sanitizeSearchQuery(
        primaryArtist ? `${primaryArtist} - ${cleanTitle}` : cleanTitle
      );
      const artistAndPrimaryTitle = sanitizeSearchQuery(
        primaryArtist ? `${primaryArtist} - ${primaryTitle}` : primaryTitle
      );
      const cleanTitleOnly = sanitizeSearchQuery(primaryTitle);

      if (!artistAndCleanTitle) {
        item.status = 'error';
        item.error = 'Búsqueda inválida.';
        return;
      }

      // Step 0 & Step 1 in parallel: Resolve canonical duration + official title/artist/album words from iTunes/Deezer
      // while simultaneously running SoundCloud and YouTube candidate discovery in SEPARATE parallel processes
      // so a slow/throttled YouTube search can never delay or starve SoundCloud discovery!
      const ytDiscoveryQueries = [
        `ytsearch6:${artistAndPrimaryTitle || artistAndCleanTitle} official audio`
      ];
      const scDiscoveryQueries = [
        `scsearch15:${artistAndPrimaryTitle || artistAndCleanTitle}`
      ];
      if (artistAndCleanTitle && artistAndCleanTitle !== artistAndPrimaryTitle) {
        scDiscoveryQueries.push(`scsearch10:${artistAndCleanTitle}`);
      } else if (primaryArtist && cleanTitleOnly && cleanTitleOnly.length >= 3) {
        scDiscoveryQueries.push(`scsearch10:${cleanTitleOnly}`);
      }

      const [catalogMeta, scRawCandidates, ytRawCandidates] = await Promise.all([
        resolveCatalogMetadata(item.duration, cleanTitle, primaryArtist),
        discoverCandidatesFromSearch(scDiscoveryQueries, 10000),
        discoverCandidatesFromSearch(ytDiscoveryQueries, 7500)
      ]);
      const rawCandidates = [...ytRawCandidates, ...scRawCandidates];
      expectedDurationSec = catalogMeta.durationSec;
      const effectiveTitle =
        !primaryArtist && catalogMeta.canonicalTitle ? catalogMeta.canonicalTitle : cleanTitle;
      const effectiveArtist = primaryArtist || catalogMeta.canonicalArtist || item.artist || '';
      metaTitle = effectiveTitle || metaTitle;
      metaArtist = effectiveArtist || metaArtist;
      metaAlbum = catalogMeta.canonicalAlbum || metaAlbum;
      updateProg(18);

      const ctx = buildCandidateContext(
        rawTitle,
        effectiveTitle,
        effectiveArtist,
        expectedDurationSec,
        catalogMeta
      );

      // Tier 1: Exact 1x studio recordings
      const scoredTier1 = rawCandidates
        .map(c => ({ ...c, score: scoreCandidate(c, ctx) }))
        .filter(c => c.score >= 0)
        .sort((a, b) => b.score - a.score);

      // Tier 2: Anti-copyright N-x looped studio uploads (e.g. "Intruso - Enjambre" 3x = 608.4s or "The Ketchup Song" 4x = 867.5s on SoundCloud),
      // automatically trimmed by ffmpeg to 1x single-play duration with stream copy (-t N)
      const scoredLoopTier2 = rawCandidates
        .map(c => {
          const loopInfo = scoreLoopCandidate(c, ctx);
          return loopInfo ? { ...c, ...loopInfo } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      updateProg(22);

      const maxAllowedDur = expectedDurationSec ? expectedDurationSec + 5 : null;
      const hasCookiesConfigured = Boolean(getYtCookiesFilePath());

      const ytCands = scoredTier1.filter(c =>
        String(c.extractor || '').toLowerCase().includes('youtube')
      );
      const scCands = scoredTier1.filter(c =>
        !String(c.extractor || '').toLowerCase().includes('youtube')
      );

      const bestYtNonTopic = ytCands.find(
        c => !String(c.uploader || '').toLowerCase().endsWith('- topic')
      );
      const bestYt = bestYtNonTopic || ytCands[0] || null;

      const scDirectTargets = scCands.slice(0, 2).map(best => ({
        url: best.webpageUrl,
        isSearchPool: false,
        trimDurationSec: maxAllowedDur,
        useCookies: false
      }));

      const scLoopTargets = scoredLoopTier2.slice(0, 2).map(loopCand => ({
        url: loopCand.webpageUrl,
        isSearchPool: false,
        trimDurationSec: loopCand.trimDurationSec,
        useCookies: false
      }));

      const ytDirectTargets = bestYt
        ? [
            {
              url: bestYt.webpageUrl,
              isSearchPool: false,
              trimDurationSec: maxAllowedDur,
              useCookies: hasCookiesConfigured
            }
          ]
        : [];

      const minDur = expectedDurationSec ? Math.max(45, expectedDurationSec - 8) : 55;
      const maxDur = expectedDurationSec ? expectedDurationSec + 8 : 540;
      const searchQueryBase = sanitizeSearchQuery(
        effectiveArtist
          ? `${effectiveArtist} ${stripParentheticalSubtitles(effectiveTitle)}`
          : stripParentheticalSubtitles(effectiveTitle)
      )
        .replace(/\s*[-–—]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const titleCoreWords = getTitleCoreTokens(effectiveTitle).slice(0, 4);
      const biliMatchTitleRegex =
        titleCoreWords.length > 0
          ? `(?i)${titleCoreWords.map(w => `(?=.*${w.replace(/[^a-z0-9]/gi, '')})`).join('')}`
          : null;

      const biliTarget = {
        url: `bilisearch5:${searchQueryBase || artistAndPrimaryTitle || artistAndCleanTitle}`,
        isSearchPool: true,
        minDuration: minDur,
        maxDuration: maxDur,
        matchTitleRegex: biliMatchTitleRegex,
        rejectTitleRegex,
        trimDurationSec: maxAllowedDur,
        useCookies: false
      };

      if (hasCookiesConfigured) {
        // With valid cookies, try YouTube #1 first, then SoundCloud 1x/loop, then Bilibili studio match
        targets.push(...ytDirectTargets, ...scDirectTargets, ...scLoopTargets, biliTarget);
      } else {
        // Without cookies, prioritize SoundCloud 1x/loop and Bilibili studio match before YouTube
        targets.push(...scDirectTargets, ...scLoopTargets, biliTarget, ...ytDirectTargets);
      }

      targets.push({
        url: `ytsearch5:${searchQueryBase || artistAndPrimaryTitle} official audio`,
        isSearchPool: true,
        minDuration: minDur,
        maxDuration: maxDur,
        rejectTitleRegex,
        trimDurationSec: maxAllowedDur,
        useCookies: hasCookiesConfigured
      });
    }

    const minRawBytes = expectedDurationSec
      ? Math.max(240 * 1024, Math.min(700 * 1024, Math.round(expectedDurationSec * 4000)))
      : 240 * 1024;

    for (const t of targets) {
      let stepRes = null;
      let ffmpegErr = '';
      try {
        if (netSlotReleased) {
          releaseNetSlot = await acquireContinuationNetSlot(userId);
          netSlotReleased = false;
        }

        cleanupRawStageFiles(downloadsDir, baseSlug);
        stepRes = await runYtDlpAttempt(
          t.url,
          rawOutputTemplate,
          { ...t, useCookies: Boolean(t.useCookies) },
          pct => updateProg(Math.round(24 + pct * 0.66))
        );

        const rawFilePath = findRawStageFile(downloadsDir, baseSlug, stepRes?.filepath);
        if (rawFilePath) {
          let rawSize = 0;
          try {
            rawSize = fs.statSync(rawFilePath).size;
          } catch {}

          if (rawSize > minRawBytes) {
            updateProg(92);
            const postRes = await enqueueCpuJob(
              userId,
              () =>
                runFfmpegPostProcess(rawFilePath, expectedM4aPath, {
                  acodec: stepRes?.acodec,
                  trimDurationSec: t.trimDurationSec,
                  title: metaTitle,
                  artist: metaArtist,
                  album: metaAlbum
                }),
              () => {
                // Release Network slot as soon as the CPU slot is granted so the next queued
                // download starts Paso A while providing automatic backpressure if CPU is full
                if (releaseNetSlot) {
                  releaseNetSlot();
                  netSlotReleased = true;
                }
              }
            );
            if (!postRes.ok) {
              ffmpegErr = postRes.error || '';
            }
          }
        }
      } finally {
        cleanupRawStageFiles(downloadsDir, baseSlug);
      }

      const finalized = finalizeDownloadedMp3(
        downloadsDir,
        baseSlug,
        expectedM4aPath,
        expectedDurationSec
      );
      if (finalized.valid && finalized.filePath && fs.existsSync(finalized.filePath)) {
        console.log(`[download] OK: ${finalized.filename} <- ${t.url}`);
        enforceStorageQuota();
        scheduleFileCleanup(finalized.filePath, 90000);
        item.status = 'ready';
        item.progress = 100;
        item.filename = finalized.filename;
        return;
      }
      const lastErrLine = String(ffmpegErr || stepRes?.error || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .pop();
      console.warn(
        `[download] skip ${t.url} (code=${stepRes?.code ?? 'err'}): ${lastErrLine || 'no valid audio'}`
      );
    }

    enforceStorageQuota();
    item.status = 'error';
    item.error = 'No se encontró versión original completa de esta pista.';
  } finally {
    if (releaseNetSlot && !netSlotReleased) {
      releaseNetSlot();
      netSlotReleased = true;
    }
    cleanupRawStageFiles(downloadsDir, baseSlug);
    unregisterActiveRawJob(baseSlug);
  }
}

export async function POST(request) {
  try {
    const user = getSessionUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Inicia sesión para descargar' }, { status: 401 });
    }

    const data = await request.json();
    const rawQuery = (data.query || `${data.title || ''} ${data.artist || ''}`).trim();

    if (!rawQuery) {
      return NextResponse.json({ error: 'Nombre o búsqueda requerida' }, { status: 400 });
    }

    if (/^https?:\/\//i.test(rawQuery) && !isAllowedMediaUrl(rawQuery)) {
      return NextResponse.json(
        { error: 'Solo se permiten URLs de YouTube o SoundCloud.' },
        { status: 400 }
      );
    }

    if (getUserQueuedCount(user.id) >= MAX_QUEUED_PER_USER) {
      return NextResponse.json(
        { error: 'Tienes demasiadas descargas en cola' },
        { status: 429 }
      );
    }

    const downloadsDir = getDownloadsDir();
    const downloadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const baseSlug = `${sanitizeSlug(`${data.artist || ''} ${data.title || rawQuery}`)}_${downloadId}`;

    activeDownloads.set(downloadId, {
      id: downloadId,
      userId: user.id,
      title: data.title || rawQuery,
      artist: data.artist || '',
      duration: data.duration || null,
      artwork: data.artwork || '',
      status: 'downloading',
      progress: 8,
      filename: null
    });

    const isManualRequest = Boolean(data.priority);
    enqueueNetDownload(user.id, downloadId, isManualRequest, releaseNetSlot =>
      runExtractionPipeline(
        downloadId,
        rawQuery,
        downloadsDir,
        baseSlug,
        user.id,
        releaseNetSlot
      )
    ).catch(err => {
      const item = activeDownloads.get(downloadId);
      if (item) {
        item.status = 'error';
        item.error = err.message;
      }
    });

    return NextResponse.json({
      ok: true,
      downloadId,
      pool: getPoolStatus(user.id, downloadId)
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request) {
  const user = getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ pool: getPoolStatus(user.id) });
  }

  const item = activeDownloads.get(id);
  if (!item || (item.userId && item.userId !== user.id && !user.is_admin)) {
    return NextResponse.json(
      { error: 'Descarga no encontrada', pool: getPoolStatus(user.id) },
      { status: 404 }
    );
  }

  const { userId: _ownerId, ...publicItem } = item;
  return NextResponse.json({
    ...publicItem,
    pool: getPoolStatus(user.id, id)
  });
}
