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

function runYtDlpAttempt(target, outputTemplate, isSearchPool, onProgress) {
  return new Promise(resolve => {
    const ytdlpArgs = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-metadata',
      '--no-cache-dir',
      '--newline',
      '-o', outputTemplate
    ];

    if (isSearchPool) {
      // Skip 30-second SoundCloud Go+ previews and overly long mixes (>15 min)
      ytdlpArgs.push('--match-filter', 'duration > 65 & duration < 900');
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

    let child;
    try {
      child = spawn(cmd, args);
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }

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
      resolve({ ok: false, error: err.message });
    });

    child.on('close', code => {
      // Exit code 101 in yt-dlp means --max-downloads limit was reached after downloading the 1st valid full song
      resolve({ ok: code === 0 || code === 101, code, error: stderrText.slice(-300) });
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
    targets = [
      { url: `scsearch8:${safeQuery}`, isSearchPool: true },
      { url: `ytsearch5:${safeQuery}`, isSearchPool: true }
    ];
  }

  for (const t of targets) {
    const res = await runYtDlpAttempt(t.url, outputTemplate, t.isSearchPool, updateProg);
    if (res.ok && fs.existsSync(expectedMp3Path)) {
      const stat = fs.statSync(expectedMp3Path);
      // Verify it's a real full track (> 1.1 MB) and not a 29-second preview snippet
      if (stat.size > 1100 * 1024) {
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

    runExtractionPipeline(downloadId, rawQuery, downloadsDir, baseSlug).catch(err => {
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
