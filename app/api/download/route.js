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

function enqueueExtraction(taskFn) {
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
    extractionPool.queue.push({ fn: taskFn, resolve, reject });
    runNext();
  });
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

function stripRemasterNoise(raw) {
  return String(raw || '')
    .replace(
      /\s*[-–—]\s*(remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|radio\s+edit|album\s+version|single\s+version|explicit|clean|solo|mono|stereo|\d+\/\d+.*).*/i,
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
    'vault',
    'topic',
    'music',
    'band',
    'dj'
  ]);
  return String(rawArtist || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));
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
    'guitar cover',
    'drum cover',
    'piano cover',
    'vocal cover',
    'bass cover',
    'acapella',
    'acappella'
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
    isSearchPool = true,
    minDuration = 60,
    maxDuration = 900,
    rejectTitleRegex = null
  } = options || {};

  return new Promise(resolve => {
    // Transparent VBR compression (LAME -V 5 ~128kbps VBR + 44.1kHz joint stereo at compression_level 0):
    // Matches the native 128kbps YouTube/SoundCloud source fidelity with zero audible loss while saving ~60% disk space (~2.4-3MB per track instead of ~8MB)
    const ytdlpArgs = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--postprocessor-args', 'ExtractAudio:-ac 2 -ar 44100 -compression_level 0',
      '--embed-metadata',
      '--restrict-filenames',
      '--no-cache-dir',
      '--ignore-errors',
      '--socket-timeout', '15',
      '--newline',
      '-o', outputTemplate
    ];

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

function findAndValidateDownloadedMp3(downloadsDir, baseSlug, expectedMp3Path, artistTokens, requireArtistMatch) {
  try {
    const files = fs.readdirSync(downloadsDir);
    const candidateName = files.find(
      f => f.startsWith(`${baseSlug}__`) && f.toLowerCase().endsWith('.mp3')
    );
    if (!candidateName) {
      return fs.existsSync(expectedMp3Path);
    }
    const candidatePath = path.join(downloadsDir, candidateName);
    const stat = fs.statSync(candidatePath);
    if (stat.size <= 400 * 1024) {
      try {
        fs.unlinkSync(candidatePath);
      } catch {}
      return false;
    }

    if (requireArtistMatch && artistTokens.length > 0) {
      const metaPart = candidateName
        .slice(baseSlug.length + 2)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ');
      const matchesArtist = artistTokens.some(tok => metaPart.includes(tok));
      if (!matchesArtist) {
        try {
          fs.unlinkSync(candidatePath);
        } catch {}
        return false;
      }
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
    if (cur) cur.progress = Math.max(cur.progress || 5, Math.min(98, p));
  };

  let targets = [];
  const rawTitle = String(item.title || rawQuery || '').trim();
  const cleanTitle = stripRemasterNoise(rawTitle) || rawTitle;
  const primaryArtist = cleanArtistName(item.artist);
  const artistTokens = getArtistTokens(item.artist);
  const expectedDurationSec = parseDurationToSec(item.duration);
  const rejectTitleRegex = buildRejectTitleRegex(rawTitle);

  if (/^https?:\/\//i.test(rawQuery)) {
    if (!isAllowedMediaUrl(rawQuery)) {
      item.status = 'error';
      item.error = 'Dominio de URL no permitido.';
      return;
    }
    targets = [{ url: rawQuery, isSearchPool: false, requireArtistMatch: false }];
  } else {
    // IMPORTANT: Strip remaster noise ONLY from title, never from the artist!
    const artistAndCleanTitle = sanitizeSearchQuery(
      primaryArtist ? `${primaryArtist} - ${cleanTitle}` : cleanTitle
    );
    const artistAndRawTitle = sanitizeSearchQuery(
      primaryArtist ? `${primaryArtist} - ${rawTitle}` : rawTitle
    );

    if (!artistAndCleanTitle) {
      item.status = 'error';
      item.error = 'Búsqueda inválida.';
      return;
    }

    // 1. If we know the track's exact duration (e.g. 3:09 = 189s from Spotify CSV),
    // first search with a tight duration window (±10s) + artist verification + cover/remix rejection
    if (expectedDurationSec && expectedDurationSec >= 65) {
      const tightMin = Math.max(55, expectedDurationSec - 10);
      const tightMax = expectedDurationSec + 10;
      targets.push({
        url: `scsearch10:${artistAndCleanTitle}`,
        isSearchPool: true,
        minDuration: tightMin,
        maxDuration: tightMax,
        rejectTitleRegex,
        requireArtistMatch: artistTokens.length > 0
      });
      targets.push({
        url: `ytsearch5:${artistAndCleanTitle} official audio`,
        isSearchPool: true,
        minDuration: Math.max(55, expectedDurationSec - 15),
        maxDuration: expectedDurationSec + 15,
        rejectTitleRegex,
        requireArtistMatch: artistTokens.length > 0
      });
    }

    // 2. Standard duration window (60s-900s), still requiring artist match and rejecting covers/remixes
    targets.push({
      url: `scsearch10:${artistAndCleanTitle}`,
      isSearchPool: true,
      minDuration: 60,
      maxDuration: 900,
      rejectTitleRegex,
      requireArtistMatch: artistTokens.length > 0
    });

    if (artistAndRawTitle.toLowerCase() !== artistAndCleanTitle.toLowerCase()) {
      targets.push({
        url: `scsearch10:${artistAndRawTitle}`,
        isSearchPool: true,
        minDuration: 60,
        maxDuration: 900,
        rejectTitleRegex,
        requireArtistMatch: artistTokens.length > 0
      });
    }

    targets.push({
      url: `ytsearch5:${artistAndCleanTitle} official audio`,
      isSearchPool: true,
      minDuration: 60,
      maxDuration: 900,
      rejectTitleRegex,
      requireArtistMatch: false
    });

    // 3. Final fallback for obscure archive/reupload tracks where the uploader name differs from the Spotify artist
    if (artistTokens.length > 0) {
      targets.push({
        url: `scsearch5:${artistAndCleanTitle}`,
        isSearchPool: true,
        minDuration: expectedDurationSec ? Math.max(55, expectedDurationSec - 20) : 60,
        maxDuration: expectedDurationSec ? expectedDurationSec + 20 : 900,
        rejectTitleRegex,
        requireArtistMatch: false
      });
    }
  }

  for (const t of targets) {
    await runYtDlpAttempt(t.url, tempOutputTemplate, t, updateProg);
    const valid = findAndValidateDownloadedMp3(
      downloadsDir,
      baseSlug,
      expectedMp3Path,
      artistTokens,
      t.requireArtistMatch
    );
    if (valid && fs.existsSync(expectedMp3Path)) {
      const stat = fs.statSync(expectedMp3Path);
      if (stat.size > 400 * 1024) {
        enforceStorageQuota();
        scheduleFileCleanup(expectedMp3Path, 90000);
        item.status = 'ready';
        item.progress = 100;
        item.filename = expectedMp3Name;
        return;
      } else {
        try {
          fs.unlinkSync(expectedMp3Path);
        } catch {}
      }
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

    enqueueExtraction(() =>
      runExtractionPipeline(downloadId, rawQuery, downloadsDir, baseSlug)
    ).catch(err => {
      const item = activeDownloads.get(downloadId);
      if (item) {
        item.status = 'error';
        item.error = err.message;
      }
    });

    return NextResponse.json({ ok: true, downloadId });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Falta id de descarga' }, { status: 400 });
  }

  const item = activeDownloads.get(id);
  if (!item) {
    return NextResponse.json({ error: 'Descarga no encontrada' }, { status: 404 });
  }

  return NextResponse.json(item);
}
