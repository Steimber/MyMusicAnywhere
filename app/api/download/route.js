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
      '-o', outputTemplate,
      target
    ];

    if (process.env.FFMPEG_BIN?.trim()) {
      ytdlpArgs.splice(ytdlpArgs.length - 1, 0, '--ffmpeg-location', process.env.FFMPEG_BIN.trim());
    }

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

async function runExtractionPipeline(downloadId, query, previewUrl, downloadsDir, baseSlug) {
  const item = activeDownloads.get(downloadId);
  if (!item) return;

  const outputTemplate = path.join(downloadsDir, `${baseSlug}.%(ext)s`);
  const expectedMp3Name = `${baseSlug}.mp3`;
  const expectedMp3Path = path.join(downloadsDir, expectedMp3Name);

  const updateProg = p => {
    const cur = activeDownloads.get(downloadId);
    if (cur) cur.progress = Math.max(cur.progress || 5, Math.min(98, p));
  };

  const isDirectUrl = /^https?:\/\//i.test(query);
  const targets = isDirectUrl
    ? [query]
    : [
        `scsearch1:${query}`, // Works reliably on VPS datacenter IPs without YouTube bot blocks
        `ytsearch1:${query}`  // Secondary fallback
      ];

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

  // Final fallback: if previewUrl is provided, convert/fetch preview audio so download never fails
  if (previewUrl && /^https?:\/\//i.test(previewUrl)) {
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
    const query = (data.query || `${data.title || ''} ${data.artist || ''}`).trim();

    if (!query) {
      return NextResponse.json({ error: 'Nombre o búsqueda requerida' }, { status: 400 });
    }

    const downloadsDir = getDownloadsDir();
    const downloadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const baseSlug = `${sanitizeSlug(`${data.artist || ''} ${data.title || query}`)}_${downloadId}`;

    activeDownloads.set(downloadId, {
      id: downloadId,
      title: data.title || query,
      artist: data.artist || '',
      artwork: data.artwork || '',
      status: 'downloading',
      progress: 8,
      filename: null
    });

    // Launch non-blocking extraction pipeline
    runExtractionPipeline(downloadId, query, data.previewUrl, downloadsDir, baseSlug).catch(err => {
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
