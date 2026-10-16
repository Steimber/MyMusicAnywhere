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
    .replace(/\s*[-–—]\s*(remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|radio\s+edit|album\s+version|single\s+version|explicit|clean).*/i, '')
    .replace(/\s*\((remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|feat\.?[^)]+|ft\.?[^)]+)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function runYtDlpAttempt(target, outputTemplate, isSearchPool, onProgress) {
  return new Promise(resolve => {
    // Transparent VBR compression (LAME -V 5 ~128kbps VBR + 44.1kHz joint stereo at compression_level 0):
    // Matches the native 128kbps YouTube/SoundCloud source fidelity with zero audible loss while saving ~60% disk space (~2.4-3MB per track instead of ~8MB)
    const ytdlpArgs = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--postprocessor-args', 'ExtractAudio:-ac 2 -ar 44100 -compression_level 0',
      '--embed-metadata',
      '--no-cache-dir',
      '--ignore-errors',
      '--socket-timeout', '15',
      '--newline',
      '-o', outputTemplate
    ];

    if (isSearchPool) {
      // Skip 30-second SoundCloud Go+ previews and overly long mixes (>15 min)
      ytdlpArgs.push('--match-filter', 'duration > 60 & duration < 900');
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

async function runExtractionPipeline(downloadId, rawQuery, downloadsDir, baseSlug) {
  const item = activeDownloads.get(downloadId);
  if (!item) return;

  const outputTemplate = path.join(downloadsDir, `${baseSlug}.%(ext)s`);
  const expectedMp3Name = `${baseSlug}.mp3`;
  const expectedMp3Path = path.join(downloadsDir, expectedMp3Name);

  const updateProg = p => {
    const cur = activeDownloads.get(downloadId);
    if (cur) cur.progress = Math.max(cur.progress || 5, Math.min(98, p));
  };

  let targets = [];
  if (/^https?:\/\//i.test(rawQuery)) {
    if (!isAllowedMediaUrl(rawQuery)) {
      item.status = 'error';
      item.error = 'Dominio de URL no permitido.';
      return;
    }
    targets = [{ url: rawQuery, isSearchPool: false }];
  } else {
    const safeQuery = sanitizeSearchQuery(rawQuery);
    if (!safeQuery) {
      item.status = 'error';
      item.error = 'Búsqueda inválida.';
      return;
    }
    const strippedQuery = sanitizeSearchQuery(stripRemasterNoise(rawQuery));
    targets = [
      { url: `scsearch10:${safeQuery}`, isSearchPool: true }
    ];
    if (strippedQuery && strippedQuery.toLowerCase() !== safeQuery.toLowerCase()) {
      targets.push({ url: `scsearch10:${strippedQuery}`, isSearchPool: true });
    }
    targets.push({ url: `ytsearch5:${strippedQuery || safeQuery} audio`, isSearchPool: true });
  }

  for (const t of targets) {
    await runYtDlpAttempt(t.url, outputTemplate, t.isSearchPool, updateProg);
    if (fs.existsSync(expectedMp3Path)) {
      const stat = fs.statSync(expectedMp3Path);
      // Verify it's a real full track (> 400 KB at VBR V5) and not a 29-second preview snippet
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
  item.error = 'No se encontró versión completa de esta pista.';
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
