import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  getDownloadsDir,
  getSessionUser,
  enforceStorageQuota,
  scheduleFileCleanup
} from '../../../lib/store';

if (!global.__activeDownloads) {
  global.__activeDownloads = new Map();
}
const activeDownloads = global.__activeDownloads;

const MAX_CONCURRENT_EXTRACTIONS = 2;
if (!global.__extractionQueue) {
  global.__extractionQueue = { running: 0, queue: [] };
}
const extractionPool = global.__extractionQueue;

function enqueueExtraction(taskFn, priority = false) {
  return new Promise((resolve, reject) => {
    const runNext = () => {
      if (extractionPool.running >= MAX_CONCURRENT_EXTRACTIONS || extractionPool.queue.length === 0) {
        return;
      }
      extractionPool.running += 1;
      const next = extractionPool.queue.shift();
      Promise.resolve()
        .then(() => next.fn())
        .then(next.resolve, next.reject)
        .finally(() => {
          extractionPool.running = Math.max(0, extractionPool.running - 1);
          runNext();
        });
    };
    const entry = { fn: taskFn, resolve, reject };
    if (priority) {
      extractionPool.queue.unshift(entry);
    } else {
      extractionPool.queue.push(entry);
    }
    runNext();
  });
}

function getPoolStatus() {
  return {
    active: extractionPool.running,
    queued: extractionPool.queue.length,
    max: MAX_CONCURRENT_EXTRACTIONS
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

function resolveYtDlpCommand(extraArgs) {
  const configuredBin = process.env.YTDLP_BIN?.trim();
  if (configuredBin) {
    return { cmd: configuredBin, args: extraArgs };
  }
  if (process.platform === 'win32') {
    return { cmd: 'python', args: ['-m', 'yt_dlp', ...extraArgs] };
  }
  return { cmd: 'yt-dlp', args: extraArgs };
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
      /\s*[-–—]\s*(remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|radio\s+edit|album\s+version|single\s+version|explicit|clean|mono|stereo|\d+\/\d+.*).*/i,
      ''
    )
    .replace(
      /\s*\((remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|feat\.?[^)]+|ft\.?[^)]+|explicit|clean|mono|stereo)\)/gi,
      ''
    )
    .replace(/\s*\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function getTitleCoreTokens(cleanTitle) {
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
    'una',
    'uno',
    'feat',
    'ft',
    'with',
    'remaster',
    'remastered',
    'version',
    'edit',
    'mix'
  ]);
  const tokens = normalizeText(cleanTitle)
    .split(/\s+/)
    .filter(w => w.length >= 2 && !stopWords.has(w));
  return tokens.length > 0 ? tokens : normalizeText(cleanTitle).split(/\s+/).filter(Boolean);
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

async function resolveExpectedDurationSec(rawDuration, cleanTitle, primaryArtist) {
  const parsed = parseDurationToSec(rawDuration);
  if (parsed && parsed <= 420) return parsed;

  const query = `${cleanTitle} ${primaryArtist || ''}`.trim();
  if (!query) return parsed || null;

  const titleTokens = getTitleCoreTokens(cleanTitle);
  const artistTokens = getArtistTokens(primaryArtist);
  const wantLive = /\b(live|vivo)\b/i.test(cleanTitle);

  const matchCatalogTrack = (trackTitle, trackArtist, sec) => {
    if (!sec || sec < 45 || sec > 1200) return false;
    const hTitle = normalizeText(trackTitle);
    const hArtist = normalizeText(trackArtist);
    if (!wantLive && /\b(live|vivo)\b/i.test(hTitle)) return false;
    const tOk = titleTokens.every(t => hTitle.includes(t));
    const aOk = artistTokens.length === 0 || artistTokens.some(t => hArtist.includes(t));
    return tOk && aOk;
  };

  const fetchItunesSec = async () => {
    try {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
        query
      )}&media=music&entity=song&limit=6`;
      const res = await fetch(itunesUrl, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const data = await res.json();
      const hits = Array.isArray(data?.results) ? data.results : [];
      for (const h of hits) {
        const sec = h.trackTimeMillis ? Math.round(h.trackTimeMillis / 1000) : null;
        if (matchCatalogTrack(h.trackName, h.artistName, sec)) return sec;
      }
    } catch {}
    return null;
  };

  const fetchDeezerSec = async () => {
    try {
      const dzUrl = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=6`;
      const res = await fetch(dzUrl, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const data = await res.json();
      const hits = Array.isArray(data?.data) ? data.data : [];
      for (const h of hits) {
        const sec = Number(h.duration);
        if (matchCatalogTrack(h.title, h.artist?.name, sec)) return sec;
      }
    } catch {}
    return null;
  };

  const [itSec, dzSec] = await Promise.all([fetchItunesSec(), fetchDeezerSec()]);
  if (itSec && dzSec) {
    return Math.abs(itSec - dzSec) <= 8 ? Math.min(itSec, dzSec) : dzSec;
  }
  return dzSec || itSec || parsed || null;
}

const STANDARD_AUDIO_METADATA_WORDS = new Set([
  'official',
  'audio',
  'video',
  'music',
  'lyrics',
  'lyric',
  'letra',
  'sub',
  'espanol',
  'english',
  'hd',
  'hq',
  '4k',
  '8k',
  'remaster',
  'remastered',
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
  'the',
  'and',
  'con',
  'del',
  'las',
  'los',
  'por',
  'para'
]);

function buildCandidateContext(rawTitle, cleanTitle, rawArtist, expectedDurationSec) {
  const rawTitleNorm = normalizeText(rawTitle);
  const cleanTitleNorm = normalizeText(cleanTitle);
  const rawArtistNorm = normalizeText(rawArtist);
  const titleTokens = getTitleCoreTokens(cleanTitle);
  const artistTokens = getArtistTokens(rawArtist);

  const allowedWords = new Set(STANDARD_AUDIO_METADATA_WORDS);
  for (const w of `${rawTitleNorm} ${cleanTitleNorm} ${rawArtistNorm}`.split(/\s+/)) {
    if (w) allowedWords.add(w);
  }

  return {
    rawTitleLower: String(rawTitle || '').toLowerCase(),
    rawArtistLower: String(rawArtist || '').toLowerCase(),
    titleTokens,
    artistTokens,
    allowedWords,
    expectedDurationSec
  };
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

  // Verify title core tokens
  if (ctx.titleTokens.length > 0) {
    const matchedTitleCount = ctx.titleTokens.filter(
      t => candTitleWordSet.has(t) || candTitleNorm.includes(t)
    ).length;
    const minRequired =
      ctx.titleTokens.length === 1 ? 1 : Math.max(2, Math.ceil(ctx.titleTokens.length * 0.7));
    if (matchedTitleCount < minRequired) {
      return -1;
    }
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

  // Count foreign words in the candidate title that don't belong to the song title, artist, or audio metadata
  const foreignTitleWords = candTitleWords.filter(
    w => w.length >= 3 && !/^\d+$/.test(w) && !ctx.allowedWords.has(w)
  );

  // If the uploader is NOT the artist and the title has 2+ unrelated foreign words (e.g. "GET BACK BEATLES KOVAH OF THE GODZ"), reject!
  if (!uploaderMatchesArtist && foreignTitleWords.length >= 2) {
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

  const extractorLower = String(cand.extractor || '').toLowerCase();
  if (extractorLower.includes('soundcloud')) {
    score += 10;
  } else if (extractorLower.includes('youtube') && uploaderMatchesArtist) {
    score += 24;
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

  if (ctx.titleTokens.length > 0) {
    const matchedTitleCount = ctx.titleTokens.filter(
      t => candTitleWordSet.has(t) || candTitleNorm.includes(t)
    ).length;
    if (matchedTitleCount < ctx.titleTokens.length) return null;
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
  if (foreignWords.length > 0) return null;

  const trimDurationSec = Math.max(
    45,
    Math.floor(Math.min(singleCycleSec, exp))
  );

  return {
    score: Math.round(90 - cycleDiff * 3 - repeatCount * 2),
    trimDurationSec,
    fadeOutSec: 2
  };
}

function discoverCandidatesFromSearch(searchQueries) {
  return new Promise(resolve => {
    const ytdlpArgs = [
      '--flat-playlist',
      '--ignore-errors',
      '--no-warnings',
      '--socket-timeout', '10',
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
    }, 14000);

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
    rejectTitleRegex = null,
    trimDurationSec = null,
    fadeOutSec = 0
  } = options || {};

  return new Promise(resolve => {
    let extractAudioArgs = 'ExtractAudio:-ac 2 -ar 44100 -compression_level 0';
    if (trimDurationSec && trimDurationSec >= 45) {
      const tSec = Math.round(trimDurationSec);
      extractAudioArgs += ` -t ${tSec}`;
      if (fadeOutSec && fadeOutSec > 0 && tSec > fadeOutSec + 6) {
        const stSec = Math.round(tSec - fadeOutSec);
        extractAudioArgs += ` -af afade=t=out:st=${stSec}:d=${Math.round(fadeOutSec)}`;
      }
    }

    // Transparent VBR compression (LAME -V 5 ~128kbps VBR + 44.1kHz joint stereo at compression_level 0):
    // Matches the native 128kbps YouTube/SoundCloud source fidelity with zero audible loss while saving ~60% disk space (~2.4-3MB per track instead of ~8MB)
    const ytdlpArgs = [
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--postprocessor-args', extractAudioArgs,
      '--embed-metadata',
      '--restrict-filenames',
      '--no-cache-dir',
      '--ignore-errors',
      '--no-warnings',
      '--js-runtimes', 'node',
      '--socket-timeout', '15',
      '--newline',
      '-o', outputTemplate
    ];

    if (/youtube\.com|youtu\.be|^ytsearch/i.test(String(target || ''))) {
      ytdlpArgs.push('--extractor-args', 'youtube:player_client=tv,ios,mweb,web');
    }

    if (isSearchPool) {
      ytdlpArgs.push('--match-filter', `duration >= ${minDuration} & duration <= ${maxDuration}`);
      if (rejectTitleRegex) {
        ytdlpArgs.push('--reject-title', rejectTitleRegex);
      }
      ytdlpArgs.push('--max-downloads', '1');
    } else {
      ytdlpArgs.push('--no-playlist');
    }

    if (process.env.FFMPEG_BIN?.trim()) {
      ytdlpArgs.push('--ffmpeg-location', process.env.FFMPEG_BIN.trim());
    }

    // Use '--' separator to prevent option/flag injection
    ytdlpArgs.push('--', target);

    const { cmd, args } = resolveYtDlpCommand(ytdlpArgs);
    let stderrText = '';
    let settled = false;

    let child;
    try {
      child = spawn(cmd, args);
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    // Guard against stuck connections so the extraction pool never deadlocks
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, error: 'Tiempo de espera agotado en extracción' });
    }, 45000);

    child.stdout.on('data', d => {
      const text = d.toString();
      const progMatch = text.match(/\[download\]\s+([\d\.]+)%/);
      if (progMatch && onProgress) {
        onProgress(parseFloat(progMatch[1]));
      }
    });

    child.stderr.on('data', d => {
      stderrText += d.toString();
    });

    child.on('error', err => {
      finish({ ok: false, error: err.message });
    });

    child.on('close', code => {
      // Exit code 101 in yt-dlp means --max-downloads limit was reached after downloading the 1st valid full song
      finish({ ok: code === 0 || code === 101, code, error: stderrText.slice(-300) });
    });
  });
}

function finalizeDownloadedMp3(downloadsDir, baseSlug, expectedMp3Path, expectedDurationSec = null) {
  try {
    const files = fs.readdirSync(downloadsDir);
    const candidateName = files.find(
      f => f.startsWith(`${baseSlug}__`) && f.toLowerCase().endsWith('.mp3')
    );

    // Clean up any leftover non-mp3 temp artifacts from failed attempts for this slug
    for (const f of files) {
      if (f.startsWith(`${baseSlug}__`) && f !== candidateName) {
        try {
          fs.unlinkSync(path.join(downloadsDir, f));
        } catch {}
      }
    }

    if (!candidateName) {
      return fs.existsSync(expectedMp3Path);
    }
    const candidatePath = path.join(downloadsDir, candidateName);
    const stat = fs.statSync(candidatePath);
    const minValidBytes = expectedDurationSec
      ? Math.max(380 * 1024, Math.min(1050 * 1024, Math.round(expectedDurationSec * 6200)))
      : 380 * 1024;

    if (stat.size <= minValidBytes) {
      try {
        fs.unlinkSync(candidatePath);
      } catch {}
      return false;
    }

    if (fs.existsSync(expectedMp3Path)) {
      try {
        fs.unlinkSync(expectedMp3Path);
      } catch {}
    }
    fs.renameSync(candidatePath, expectedMp3Path);
    return true;
  } catch {
    return fs.existsSync(expectedMp3Path);
  }
}

async function runExtractionPipeline(downloadId, rawQuery, downloadsDir, baseSlug) {
  const item = activeDownloads.get(downloadId);
  if (!item) return;

  const tempOutputTemplate = path.join(
    downloadsDir,
    `${baseSlug}__%(title).60s__%(uploader).40s.%(ext)s`
  );
  const expectedMp3Name = `${baseSlug}.mp3`;
  const expectedMp3Path = path.join(downloadsDir, expectedMp3Name);

  const updateProg = p => {
    const cur = activeDownloads.get(downloadId);
    if (cur) cur.progress = Math.max(cur.progress || 8, Math.min(98, p));
  };

  const rawTitle = String(item.title || rawQuery || '').trim();
  const cleanTitle = stripRemasterNoise(rawTitle) || rawTitle;
  const primaryArtist = cleanArtistName(item.artist);
  const rejectTitleRegex = buildRejectTitleRegex(rawTitle);

  let targets = [];
  let expectedDurationSec = null;

  if (/^https?:\/\//i.test(rawQuery)) {
    if (!isAllowedMediaUrl(rawQuery)) {
      item.status = 'error';
      item.error = 'Dominio de URL no permitido.';
      return;
    }
    targets = [{ url: rawQuery, isSearchPool: false }];
  } else {
    const artistAndCleanTitle = sanitizeSearchQuery(
      primaryArtist ? `${primaryArtist} - ${cleanTitle}` : cleanTitle
    );
    const cleanTitleOnly = sanitizeSearchQuery(cleanTitle);

    if (!artistAndCleanTitle) {
      item.status = 'error';
      item.error = 'Búsqueda inválida.';
      return;
    }

    // Step 0: Resolve canonical track duration (from Spotify CSV metadata or parallel iTunes/Deezer API)
    expectedDurationSec = await resolveExpectedDurationSec(
      item.duration,
      cleanTitle,
      primaryArtist
    );
    updateProg(14);

    // Step 1: Fast candidate discovery across SoundCloud (top 25) + YouTube (top 8)
    const discoveryQueries = [
      `scsearch25:${artistAndCleanTitle}`,
      `ytsearch8:${artistAndCleanTitle} official audio`
    ];
    if (primaryArtist && cleanTitleOnly && cleanTitleOnly.length >= 3) {
      discoveryQueries.push(`scsearch10:${cleanTitleOnly}`);
    }

    const ctx = buildCandidateContext(rawTitle, cleanTitle, item.artist, expectedDurationSec);
    const rawCandidates = await discoverCandidatesFromSearch(discoveryQueries);

    // Tier 1: Exact 1x studio recordings (within ±20s of canonical duration)
    const scoredTier1 = rawCandidates
      .map(c => ({ ...c, score: scoreCandidate(c, ctx) }))
      .filter(c => c.score >= 0)
      .sort((a, b) => b.score - a.score);

    // Tier 2: Anti-copyright N-x looped studio uploads (e.g. "Intruso - Enjambre" 3x = 608.4s on SoundCloud),
    // automatically trimmed by ffmpeg to 1x single-play duration with a smooth 2s fade-out
    const scoredLoopTier2 = rawCandidates
      .map(c => {
        const loopInfo = scoreLoopCandidate(c, ctx);
        return loopInfo ? { ...c, ...loopInfo } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    updateProg(22);

    const maxAllowedDur = expectedDurationSec ? expectedDurationSec + 5 : null;

    for (const best of scoredTier1.slice(0, 4)) {
      targets.push({
        url: best.webpageUrl,
        isSearchPool: false,
        trimDurationSec: maxAllowedDur,
        fadeOutSec: 0
      });
    }

    for (const loopCand of scoredLoopTier2.slice(0, 2)) {
      targets.push({
        url: loopCand.webpageUrl,
        isSearchPool: false,
        trimDurationSec: loopCand.trimDurationSec,
        fadeOutSec: loopCand.fadeOutSec
      });
    }

    // Fallback search pools if direct URLs all failed
    const minDur = expectedDurationSec ? Math.max(45, expectedDurationSec - 15) : 55;
    const maxDur = expectedDurationSec ? expectedDurationSec + 15 : 540;
    targets.push({
      url: `scsearch15:${artistAndCleanTitle}`,
      isSearchPool: true,
      minDuration: minDur,
      maxDuration: maxDur,
      rejectTitleRegex,
      trimDurationSec: maxAllowedDur
    });
    targets.push({
      url: `ytsearch5:${artistAndCleanTitle} official audio`,
      isSearchPool: true,
      minDuration: minDur,
      maxDuration: maxDur,
      rejectTitleRegex,
      trimDurationSec: maxAllowedDur
    });
    targets.push({
      url: `bilisearch3:${artistAndCleanTitle}`,
      isSearchPool: true,
      minDuration: minDur,
      maxDuration: maxDur,
      rejectTitleRegex,
      trimDurationSec: maxAllowedDur
    });
  }

  for (const t of targets) {
    await runYtDlpAttempt(t.url, tempOutputTemplate, t, updateProg);
    const valid = finalizeDownloadedMp3(
      downloadsDir,
      baseSlug,
      expectedMp3Path,
      expectedDurationSec
    );
    if (valid && fs.existsSync(expectedMp3Path)) {
      enforceStorageQuota();
      scheduleFileCleanup(expectedMp3Path, 90000);
      item.status = 'ready';
      item.progress = 100;
      item.filename = expectedMp3Name;
      return;
    }
  }

  enforceStorageQuota();
  item.status = 'error';
  item.error = 'No se encontró versión original completa de esta pista.';
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

    const downloadsDir = getDownloadsDir();
    const downloadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const baseSlug = `${sanitizeSlug(`${data.artist || ''} ${data.title || rawQuery}`)}_${downloadId}`;

    activeDownloads.set(downloadId, {
      id: downloadId,
      title: data.title || rawQuery,
      artist: data.artist || '',
      duration: data.duration || null,
      artwork: data.artwork || '',
      status: 'downloading',
      progress: 8,
      filename: null
    });

    const isPriority = Boolean(data.priority);
    enqueueExtraction(
      () => runExtractionPipeline(downloadId, rawQuery, downloadsDir, baseSlug),
      isPriority
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
      pool: getPoolStatus()
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ pool: getPoolStatus() });
  }

  const item = activeDownloads.get(id);
  if (!item) {
    return NextResponse.json({ error: 'Descarga no encontrada', pool: getPoolStatus() }, { status: 404 });
  }

  return NextResponse.json({
    ...item,
    pool: getPoolStatus()
  });
}
