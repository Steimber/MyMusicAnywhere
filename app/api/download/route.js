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
import {
  MAX_QUEUED_PER_USER,
  getUserQueuedCount,
  enqueueNetDownload,
  acquireContinuationNetSlot,
  enqueueCpuJob,
  getPoolStatus
} from '../../../lib/download/queue';
import {
  markUrlDrmBlocked,
  sanitizeSlug,
  normalizeText,
  stripYouTubeTitleNoise,
  cleanYouTubeOembedMetadata,
  stripRemasterNoise,
  stripParentheticalSubtitles,
  cleanArtistName,
  getArtistTokens,
  getTitleCoreTokens,
  extractParentheticalTokenGroups,
  parseDurationToSec,
  buildCandidateContext,
  evaluateCandidatePool,
  parseCandidateLines,
  buildRejectTitleRegex
} from '../../../lib/download/candidates';

if (!global.__activeDownloads) {
  global.__activeDownloads = new Map();
}
const activeDownloads = global.__activeDownloads;

function parseBooleanEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

const ENABLE_BILIBILI = parseBooleanEnv('ENABLE_BILIBILI', true);

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

export function normalizeDirectMediaUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password) {
      return String(rawUrl || '').trim();
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      if (id && /^[\w-]{11}$/.test(id)) {
        return `https://www.youtube.com/watch?v=${id}`;
      }
    }
    if (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com'
    ) {
      const v = parsed.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) {
        return `https://www.youtube.com/watch?v=${v}`;
      }
      const parts = parsed.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && parts[1]) {
        if (/^[\w-]{11}$/.test(parts[1])) {
          return `https://www.youtube.com/watch?v=${parts[1]}`;
        }
      }
    }
    return parsed.href;
  } catch {
    return String(rawUrl || '').trim();
  }
}

async function resolveDirectUrlOembedMeta(directUrl) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      directUrl
    )}&format=json`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch(oembedUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const cleaned = cleanYouTubeOembedMetadata(data.title, data.author_name);
    return {
      title: cleaned.title,
      artist: cleaned.artist,
      artwork: data.thumbnail_url || null
    };
  } catch {
    return null;
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
  const wantDemo = /\bdemo\b/i.test(cleanTitle);
  const wantExtended = /\bextended\b/i.test(cleanTitle);

  const matchCatalogTrack = (trackTitle, trackArtist, sec) => {
    if (!sec || sec < 45 || sec > 1200) return false;
    const hTitle = normalizeText(trackTitle);
    const hArtist = normalizeText(trackArtist);
    if (!wantLive && /\b(live|vivo)\b/i.test(hTitle)) return false;
    if (wantDemo !== /\bdemo\b/i.test(hTitle)) return false;
    if (wantExtended && !/\bextended\b/i.test(hTitle)) return false;

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

  const fetchCatalogJson = async (url, timeoutMs = 2200) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchItunes = async () => {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
      query
    )}&media=music&entity=song&limit=6`;
    const data = await fetchCatalogJson(itunesUrl, 2200);
    const hits = Array.isArray(data?.results) ? data.results : [];
    for (const h of hits) {
      const sec = h.trackTimeMillis ? Math.round(h.trackTimeMillis / 1000) : null;
      if (matchCatalogTrack(h.trackName, h.artistName, sec)) {
        harvestTrackMeta(h.trackName, h.artistName, h.collectionName);
        return sec;
      }
    }
    return null;
  };

  const fetchDeezer = async () => {
    const dzUrl = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=6`;
    const data = await fetchCatalogJson(dzUrl, 2200);
    const hits = Array.isArray(data?.data) ? data.data : [];
    for (const h of hits) {
      const sec = Number(h.duration);
      if (matchCatalogTrack(h.title, h.artist?.name, sec)) {
        harvestTrackMeta(h.title, h.artist?.name, h.album?.title);
        return sec;
      }
    }
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

function runFlatSearchOnce(searchQueries, timeoutMs = 10000) {
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
      child = spawn(/*turbopackIgnore: true*/ cmd, args);
    } catch {
      return resolve({ candidates: [], timedOut: false });
    }

    const finish = (candidates, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ candidates, timedOut });
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(parseCandidateLines(stdoutText), true);
    }, timeoutMs);

    child.stdout.on('data', d => {
      stdoutText += d.toString();
    });

    child.on('error', () => {
      finish(parseCandidateLines(stdoutText), false);
    });

    child.on('close', () => {
      finish(parseCandidateLines(stdoutText), false);
    });
  });
}

async function discoverCandidatesFromSearch(searchQueries, timeoutMs = 10000) {
  const first = await runFlatSearchOnce(searchQueries, timeoutMs);
  if (first.candidates.length > 0 || first.timedOut) {
    return first.candidates;
  }

  const isYtSearch =
    Array.isArray(searchQueries) &&
    searchQueries.some(q => /^ytsearch/i.test(String(q || '')));
  if (isYtSearch) {
    await new Promise(r => setTimeout(r, 1500));
    console.log(
      `[search-filter] yt retry after 1.5s (0 raw results on first attempt): ${searchQueries[0]}`
    );
    const second = await runFlatSearchOnce(searchQueries, timeoutMs);
    return second.candidates;
  }

  return first.candidates;
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
      child = spawn(/*turbopackIgnore: true*/ cmd, args);
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

    // 15s timeout for Bilibili, 60s timeout for standard Paso A (Network download)
    const attemptTimeoutMs = isBilibiliTarget ? 15000 : 60000;
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({
        ok: false,
        error: `Tiempo de espera agotado en descarga (${Math.round(attemptTimeoutMs / 1000)}s)`
      });
    }, attemptTimeoutMs);

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
      const resolved = path.resolve(/*turbopackIgnore: true*/ reportedPath);
      if (
        resolved.startsWith(path.resolve(downloadsDir) + path.sep) &&
        fs.existsSync(/*turbopackIgnore: true*/ resolved) &&
        fs.statSync(/*turbopackIgnore: true*/ resolved).size > 0
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
    return match ? path.join(/*turbopackIgnore: true*/ downloadsDir, match) : null;
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
          fs.unlinkSync(path.join(/*turbopackIgnore: true*/ downloadsDir, f));
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
      child = spawn(/*turbopackIgnore: true*/ ffmpegBin, ffmpegArgs);
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

  let lastRejectReason = null;

  const validateExistingAudio = filePath => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      if (stat.size <= minValidBytes) {
        lastRejectReason = `final_size_too_small(${stat.size}B<=${minValidBytes}B)`;
        try {
          fs.unlinkSync(filePath);
        } catch {}
        return null;
      }
      return {
        valid: true,
        filename: path.basename(filePath),
        filePath,
        reason: null
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
      return { valid: false, filename: null, filePath: null, reason: lastRejectReason };
    }

    const candidatePath = path.join(downloadsDir, candidateName);
    const stat = fs.statSync(candidatePath);
    if (stat.size <= minValidBytes) {
      lastRejectReason = `final_size_too_small(${stat.size}B<=${minValidBytes}B)`;
      try {
        fs.unlinkSync(candidatePath);
      } catch {}
      return { valid: false, filename: null, filePath: null, reason: lastRejectReason };
    }

    const ext = path.extname(candidateName).toLowerCase() || '.m4a';
    const finalFilename = `${baseSlug}${ext}`;
    const finalFilePath = path.join(/*turbopackIgnore: true*/ downloadsDir, finalFilename);

    if (fs.existsSync(/*turbopackIgnore: true*/ finalFilePath)) {
      try {
        fs.unlinkSync(/*turbopackIgnore: true*/ finalFilePath);
      } catch {}
    }
    fs.renameSync(/*turbopackIgnore: true*/ candidatePath, finalFilePath);
    return { valid: true, filename: finalFilename, filePath: finalFilePath, reason: null };
  } catch {
    const checkedM4a = validateExistingAudio(path.join(downloadsDir, `${baseSlug}.m4a`));
    if (checkedM4a) return checkedM4a;
    const checkedExpected = validateExistingAudio(expectedAudioPath);
    if (checkedExpected) return checkedExpected;
    return { valid: false, filename: null, filePath: null, reason: lastRejectReason };
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
    if (!/^https?:\/\//i.test(rawQuery) && !primaryArtist && /\s+[-–—]\s+/.test(cleanTitle)) {
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
    let discoveryCtx = null;
    let maxAllowedDur = null;
    const hasCookiesConfigured = Boolean(getYtCookiesFilePath());
    let ytDiscoveryQueries = [];
    let scDiscoveryQueries = [];
    let queryLabel = '';

    const buildScTargetsFromPool = scPool => {
      const scDirectTargets = scPool.tier1.slice(0, 2).map(best => ({
        url: best.webpageUrl,
        isSearchPool: false,
        trimDurationSec: best.relaxedDuration ? null : maxAllowedDur,
        useCookies: false
      }));
      const scLoopTargets = scPool.loopTier2.slice(0, 2).map(loopCand => ({
        url: loopCand.webpageUrl,
        isSearchPool: false,
        trimDurationSec: loopCand.trimDurationSec,
        useCookies: false
      }));
      return [...scDirectTargets, ...scLoopTargets];
    };

    const buildYtTargetsFromPool = ytPool => {
      const ytCands = ytPool.tier1;
      const bestYtNonTopic = ytCands.find(
        c => !String(c.uploader || '').toLowerCase().endsWith('- topic')
      );
      const orderedYt = [];
      if (bestYtNonTopic) orderedYt.push(bestYtNonTopic);
      for (const c of ytCands) {
        if (!orderedYt.some(existing => existing.webpageUrl === c.webpageUrl)) {
          orderedYt.push(c);
        }
      }
      return orderedYt.slice(0, 2).map(best => ({
        url: best.webpageUrl,
        isSearchPool: false,
        trimDurationSec: best.relaxedDuration ? null : maxAllowedDur,
        useCookies: hasCookiesConfigured
      }));
    };

    if (/^https?:\/\//i.test(rawQuery)) {
      const directUrl = normalizeDirectMediaUrl(rawQuery);
      if (!isAllowedMediaUrl(directUrl)) {
        item.status = 'error';
        item.error = 'Dominio de URL no permitido.';
        return;
      }
      const isPlaceholderYtTitle =
        !metaTitle ||
        /^https?:\/\//i.test(metaTitle) ||
        /^youtube\s*\(/i.test(metaTitle);
      const isPlaceholderYtArtist =
        !metaArtist || metaArtist.toLowerCase() === 'youtube';
      if (isPlaceholderYtTitle || isPlaceholderYtArtist) {
        const oembed = await resolveDirectUrlOembedMeta(directUrl);
        if (oembed) {
          if (oembed.title && isPlaceholderYtTitle) {
            metaTitle = oembed.title;
            item.title = oembed.title;
          }
          if (oembed.artist && isPlaceholderYtArtist) {
            metaArtist = oembed.artist;
            item.artist = oembed.artist;
          }
          if (oembed.artwork && !item.artwork) {
            item.artwork = oembed.artwork;
          }
        }
      } else {
        const strippedTitle = stripYouTubeTitleNoise(metaTitle);
        if (strippedTitle && !/^https?:\/\//i.test(strippedTitle)) {
          metaTitle = strippedTitle;
          item.title = strippedTitle;
        }
        const strippedArtist = String(metaArtist || '')
          .replace(/\*[^*]{1,40}\*/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (strippedArtist) {
          metaArtist = strippedArtist;
          item.artist = strippedArtist;
        }
      }
      if (!metaAlbum) metaAlbum = 'YouTube';
      targets = [{ url: directUrl, isSearchPool: false, useCookies: hasCookiesConfigured }];
      if (hasCookiesConfigured) {
        targets.push({ url: directUrl, isSearchPool: false, useCookies: false });
      }
      if (/youtube\.com|youtu\.be/i.test(directUrl)) {
        targets.push({ lazyDiscovery: 'sc-direct-fallback', directUrl });
      }
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

      queryLabel = artistAndPrimaryTitle || artistAndCleanTitle;
      ytDiscoveryQueries = [`ytsearch6:${queryLabel} official audio`];
      scDiscoveryQueries = [`scsearch15:${queryLabel}`];
      if (artistAndCleanTitle && artistAndCleanTitle !== artistAndPrimaryTitle) {
        scDiscoveryQueries.push(`scsearch10:${artistAndCleanTitle}`);
      } else if (primaryArtist && cleanTitleOnly && cleanTitleOnly.length >= 3) {
        scDiscoveryQueries.push(`scsearch10:${cleanTitleOnly}`);
      }

      // Staggered discovery by cookie state: launch only the primary source alongside catalog metadata
      // (1 yt-dlp search process instead of 2), and only query the secondary source on fallback.
      let catalogMeta;
      let ytRawCandidates = [];
      let scRawCandidates = [];

      if (hasCookiesConfigured) {
        [catalogMeta, ytRawCandidates] = await Promise.all([
          resolveCatalogMetadata(item.duration, cleanTitle, primaryArtist),
          discoverCandidatesFromSearch(ytDiscoveryQueries, 7500)
        ]);
      } else {
        [catalogMeta, scRawCandidates] = await Promise.all([
          resolveCatalogMetadata(item.duration, cleanTitle, primaryArtist),
          discoverCandidatesFromSearch(scDiscoveryQueries, 10000)
        ]);
      }

      expectedDurationSec = catalogMeta.durationSec;
      maxAllowedDur = expectedDurationSec ? expectedDurationSec + 5 : null;
      const effectiveTitle =
        !primaryArtist && catalogMeta.canonicalTitle ? catalogMeta.canonicalTitle : cleanTitle;
      const effectiveArtist = primaryArtist || catalogMeta.canonicalArtist || item.artist || '';
      metaTitle = effectiveTitle || metaTitle;
      metaArtist = effectiveArtist || metaArtist;
      metaAlbum = catalogMeta.canonicalAlbum || metaAlbum;
      updateProg(18);

      discoveryCtx = buildCandidateContext(
        rawTitle,
        effectiveTitle,
        effectiveArtist,
        expectedDurationSec,
        catalogMeta
      );

      let ytDirectTargets = [];
      let scCombinedTargets = [];

      if (hasCookiesConfigured) {
        const ytPool = evaluateCandidatePool(ytRawCandidates, discoveryCtx, 'yt', queryLabel);
        ytDirectTargets = buildYtTargetsFromPool(ytPool);
        if (ytDirectTargets.length === 0) {
          scRawCandidates = await discoverCandidatesFromSearch(scDiscoveryQueries, 10000);
          const scPool = evaluateCandidatePool(
            scRawCandidates,
            discoveryCtx,
            'sc-fallback',
            queryLabel
          );
          scCombinedTargets = buildScTargetsFromPool(scPool);
        } else {
          // Defer SoundCloud search unless all direct YouTube URLs fail during download
          scCombinedTargets = [{ lazyDiscovery: 'sc' }];
        }
      } else {
        const scPool = evaluateCandidatePool(scRawCandidates, discoveryCtx, 'sc', queryLabel);
        scCombinedTargets = buildScTargetsFromPool(scPool);
        if (scCombinedTargets.length === 0) {
          ytRawCandidates = await discoverCandidatesFromSearch(ytDiscoveryQueries, 7500);
          const ytPool = evaluateCandidatePool(
            ytRawCandidates,
            discoveryCtx,
            'yt-fallback',
            queryLabel
          );
          ytDirectTargets = buildYtTargetsFromPool(ytPool);
        } else {
          // Defer YouTube search unless all direct SoundCloud URLs fail during download
          ytDirectTargets = [{ lazyDiscovery: 'yt' }];
        }
      }

      updateProg(22);

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

      const titleCoreWords = getTitleCoreTokens(effectiveTitle)
        .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
        .filter(Boolean)
        .slice(0, 4);
      const biliMatchTitleRegex =
        titleCoreWords.length > 0
          ? `(?i)${titleCoreWords.map(w => `(?=.*${w})`).join('')}`
          : null;

      const biliTarget = {
        url: `bilisearch1:${searchQueryBase || artistAndPrimaryTitle || artistAndCleanTitle}`,
        isSearchPool: true,
        minDuration: minDur,
        maxDuration: maxDur,
        matchTitleRegex: biliMatchTitleRegex,
        rejectTitleRegex,
        trimDurationSec: maxAllowedDur,
        useCookies: false
      };

      if (hasCookiesConfigured) {
        targets.push(...ytDirectTargets, ...scCombinedTargets);
      } else {
        targets.push(...scCombinedTargets, ...ytDirectTargets);
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

      if (ENABLE_BILIBILI) {
        targets.push(biliTarget);
      }
    }

    const minRawBytes = expectedDurationSec
      ? Math.max(240 * 1024, Math.min(700 * 1024, Math.round(expectedDurationSec * 4000)))
      : 240 * 1024;

    for (let idx = 0; idx < targets.length; idx++) {
      const t = targets[idx];
      if (t.lazyDiscovery) {
        if (netSlotReleased) {
          releaseNetSlot = await acquireContinuationNetSlot(userId);
          netSlotReleased = false;
        }
        if (t.lazyDiscovery === 'sc' && discoveryCtx && scDiscoveryQueries.length > 0) {
          const lazyScRaw = await discoverCandidatesFromSearch(scDiscoveryQueries, 10000);
          const scPool = evaluateCandidatePool(
            lazyScRaw,
            discoveryCtx,
            'sc-lazy-fallback',
            queryLabel
          );
          const discoveredScTargets = buildScTargetsFromPool(scPool);
          if (discoveredScTargets.length > 0) {
            targets.splice(idx + 1, 0, ...discoveredScTargets);
          }
        } else if (t.lazyDiscovery === 'yt' && discoveryCtx && ytDiscoveryQueries.length > 0) {
          const lazyYtRaw = await discoverCandidatesFromSearch(ytDiscoveryQueries, 7500);
          const ytPool = evaluateCandidatePool(
            lazyYtRaw,
            discoveryCtx,
            'yt-lazy-fallback',
            queryLabel
          );
          const discoveredYtTargets = buildYtTargetsFromPool(ytPool);
          if (discoveredYtTargets.length > 0) {
            targets.splice(idx + 1, 0, ...discoveredYtTargets);
          }
        } else if (t.lazyDiscovery === 'sc-direct-fallback') {
          let fallbackTitle = stripRemasterNoise(metaTitle) || metaTitle;
          let fallbackArtist = cleanArtistName(metaArtist);
          if (
            !fallbackTitle ||
            /^https?:\/\//i.test(fallbackTitle) ||
            /^youtube\s*\(/i.test(fallbackTitle)
          ) {
            const oembed = await resolveDirectUrlOembedMeta(t.directUrl);
            if (oembed?.title) {
              fallbackTitle = stripRemasterNoise(oembed.title) || oembed.title;
              metaTitle = oembed.title;
              item.title = oembed.title;
            }
            if (oembed?.artist && (!fallbackArtist || fallbackArtist.toLowerCase() === 'youtube')) {
              fallbackArtist = cleanArtistName(oembed.artist);
              metaArtist = oembed.artist;
              item.artist = oembed.artist;
            }
          }
          const primaryFallbackTitle = stripParentheticalSubtitles(fallbackTitle);
          const hasRealArtist =
            fallbackArtist && fallbackArtist.toLowerCase() !== 'youtube';
          const artistAndTitleQuery = sanitizeSearchQuery(
            hasRealArtist ? `${fallbackArtist} - ${primaryFallbackTitle}` : primaryFallbackTitle
          );
          const titleOnlyQuery = sanitizeSearchQuery(primaryFallbackTitle);
          const fallbackQueries = [];
          if (artistAndTitleQuery) fallbackQueries.push(`scsearch15:${artistAndTitleQuery}`);
          if (titleOnlyQuery && titleOnlyQuery !== artistAndTitleQuery && titleOnlyQuery.length >= 3) {
            fallbackQueries.push(`scsearch10:${titleOnlyQuery}`);
          }
          if (fallbackQueries.length > 0) {
            const [catalogMeta, lazyScRaw] = await Promise.all([
              resolveCatalogMetadata(item.duration, fallbackTitle, hasRealArtist ? fallbackArtist : ''),
              discoverCandidatesFromSearch(fallbackQueries, 10000)
            ]);
            expectedDurationSec = catalogMeta.durationSec;
            maxAllowedDur = expectedDurationSec ? expectedDurationSec + 5 : null;
            const fallbackCtx = buildCandidateContext(
              fallbackTitle,
              fallbackTitle,
              hasRealArtist ? fallbackArtist : '',
              expectedDurationSec,
              catalogMeta
            );
            const scPool = evaluateCandidatePool(
              lazyScRaw,
              fallbackCtx,
              'sc-yt-url-fallback',
              artistAndTitleQuery || titleOnlyQuery
            );
            const discoveredScTargets = buildScTargetsFromPool(scPool);
            if (discoveredScTargets.length > 0) {
              targets.splice(idx + 1, 0, ...discoveredScTargets);
            }
          }
        }
        continue;
      }

      let stepRes = null;
      let ffmpegErr = '';
      let sizeSkipReason = '';
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
            rawSize = fs.statSync(/*turbopackIgnore: true*/ rawFilePath).size;
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
          } else {
            sizeSkipReason = `raw_size_too_small(${rawSize}B<=${minRawBytes}B)`;
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
      if (lastErrLine && /drm protected/i.test(lastErrLine)) {
        markUrlDrmBlocked(t.url);
      }
      const fallbackFilterInfo = t.isSearchPool
        ? `filtered_all_search_results(dur=${t.minDuration}-${t.maxDuration}s${t.matchTitleRegex ? ',matchTitle' : ''}${t.rejectTitleRegex ? ',rejectTitle' : ''})`
        : 'no valid audio';
      const skipDetail =
        sizeSkipReason ||
        finalized.reason ||
        (lastErrLine && /drm protected/i.test(lastErrLine)
          ? `soundcloud_drm_protected (${lastErrLine})`
          : lastErrLine) ||
        fallbackFilterInfo;
      console.warn(`[download] skip ${t.url} (code=${stepRes?.code ?? 'err'}): ${skipDetail}`);
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
    scheduleActiveDownloadCleanup(downloadId);
  }
}

const ACTIVE_DOWNLOAD_TTL_MS = 10 * 60 * 1000; // 10 minutes after finishing
const MAX_ACTIVE_DOWNLOAD_ENTRIES = 1000;

function scheduleActiveDownloadCleanup(downloadId, delayMs = ACTIVE_DOWNLOAD_TTL_MS) {
  const timer = setTimeout(() => {
    const entry = activeDownloads.get(downloadId);
    if (entry && entry.status !== 'downloading') {
      activeDownloads.delete(downloadId);
    }
  }, delayMs);
  if (typeof timer?.unref === 'function') {
    timer.unref();
  }
}

function pruneFinishedActiveDownloadsIfNeeded() {
  if (activeDownloads.size < MAX_ACTIVE_DOWNLOAD_ENTRIES) return;
  for (const [key, val] of activeDownloads.entries()) {
    if (val.status !== 'downloading') {
      activeDownloads.delete(key);
      if (activeDownloads.size < MAX_ACTIVE_DOWNLOAD_ENTRIES) break;
    }
  }
}

export async function POST(request) {
  try {
    const user = getSessionUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Inicia sesión para descargar' }, { status: 401 });
    }

    const data = await request.json();
    const rawCandidate = (
      data.sourceUrl ||
      data.query ||
      `${data.title || ''} ${data.artist || ''}`
    ).trim();
    const rawQuery = /^https?:\/\//i.test(rawCandidate)
      ? normalizeDirectMediaUrl(rawCandidate)
      : rawCandidate;

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

    pruneFinishedActiveDownloadsIfNeeded();
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
      scheduleActiveDownloadCleanup(downloadId);
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
