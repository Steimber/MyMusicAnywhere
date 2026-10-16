import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Global state in Node memory across requests
if (!global.__activeDownloads) {
  global.__activeDownloads = new Map();
}
const activeDownloads = global.__activeDownloads;

export async function POST(request) {
  try {
    const data = await request.json();
    const query = data.query || `${data.title || ''} ${data.artist || ''}`.trim();

    if (!query) {
      return NextResponse.json({ error: 'Nombre o búsqueda requerida' }, { status: 400 });
    }

    const downloadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    activeDownloads.set(downloadId, {
      id: downloadId,
      title: data.title || query,
      artist: data.artist || '',
      artwork: data.artwork || '',
      status: 'downloading',
      progress: 0,
      filename: null
    });

    const isUrl = /^https?:\/\//i.test(query);
    const target = isUrl ? query : `ytsearch1:${query}`;
    const outputTemplate = path.join(DOWNLOADS_DIR, '%(title)s.%(ext)s');

    const args = [
      '-m', 'yt_dlp',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-metadata',
      '--embed-thumbnail',
      '--no-playlist',
      '-o', outputTemplate,
      target
    ];

    const child = spawn('python', args);
    let detectedFilename = null;

    child.stdout.on('data', d => {
      const text = d.toString();
      const destMatch = text.match(/\[ExtractAudio\] Destination: (.+\.mp3)/i) || text.match(/\[download\] Destination: (.+\.mp3)/i);
      if (destMatch) {
        detectedFilename = path.basename(destMatch[1]);
      }
      const progMatch = text.match(/\[download\]\s+([\d\.]+)%/);
      if (progMatch) {
        const item = activeDownloads.get(downloadId);
        if (item) item.progress = parseFloat(progMatch[1]);
      }
    });

    child.on('close', code => {
      const item = activeDownloads.get(downloadId);
      if (!item) return;

      if (code === 0) {
        if (!detectedFilename) {
          const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => f.endsWith('.mp3'))
            .map(f => ({ name: f, time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
          if (files.length > 0) detectedFilename = files[0].name;
        }
        item.status = 'ready';
        item.progress = 100;
        item.filename = detectedFilename;
      } else {
        item.status = 'error';
        item.error = `yt-dlp exited with code ${code}`;
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
