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

const ALLOWED_PREVIEW_HOSTS = new Set([
  'audio-ssl.itunes.apple.com',
  'p.scdn.co'
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

export function isAllowedPreviewUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (ALLOWED_PREVIEW_HOSTS.has(host)) return true;
    if (host.endsWith('.mzstatic.com') && host.length > '.mzstatic.com'.length) {
      return /^[a-z0-9.-]+\.mzstatic\.com$/.test(host);
    }
    return false;
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

function runYtDlpAttempt(target, outputTemplate, onProgress) {
  return new Promise(resolve => {
    const ytdlpArgs = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-metadata',
      '--no-playlist',
      '--no-cache-dir',
      '--newline',
      '-o', outputTemplate
    ];

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
      resolve({ ok: code === 0, code, error: stderrText.slice(-300) });
    });
  });
}

async function runExtractionPipeline(downloadId, rawQuery, previewUrl, downloadsDir, baseSlug) {
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
    targets = [rawQuery];
  } else {
    const safeQuery = sanitizeSearchQuery(rawQuery);
    if (!safeQuery) {
      item.status = 'error';
      item.error = 'Búsqueda inválida.';
      return;
    }
    targets = [
      `scsearch1:${safeQuery}`,
      `ytsearch1:${safeQuery}`
    ];
  }

  for (const target of targets) {
    const res = await runYtDlpAttempt(target, outputTemplate, updateProg);
    if (res.ok && fs.existsSync(expectedMp3Path)) {
      enforceStorageQuota();
      scheduleFileCleanup(expectedMp3Path, 90000);
      item.status = 'ready';
      item.progress = 100;
      item.filename = expectedMp3Name;
      return;
    }
  }

  // Final fallback: only allow verified Apple Music / iTunes CDN preview URLs
  if (previewUrl && isAllowedPreviewUrl(previewUrl)) {
    const res = await runYtDlpAttempt(previewUrl, outputTemplate, updateProg);
    if (res.ok && fs.existsSync(expectedMp3Path)) {
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
  item.error = 'No se pudo extraer el MP3 en el servidor.';
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

    if (data.previewUrl && !isAllowedPreviewUrl(data.previewUrl)) {
      return NextResponse.json(
        { error: 'Dominio de previewUrl no permitido.' },
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

    runExtractionPipeline(downloadId, rawQuery, data.previewUrl, downloadsDir, baseSlug).catch(err => {
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
