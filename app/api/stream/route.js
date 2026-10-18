import fs from 'fs';
import path from 'path';
import { getDownloadsDir, getSessionUser, scheduleFileCleanup } from '../../../lib/store';

const AUDIO_MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac'
};

function getAudioMimeType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return AUDIO_MIME_BY_EXT[ext] || 'audio/mpeg';
}

function createSafeFileStream(filePath, streamOpts, onStreamClosed) {
  let nodeStream = null;
  let closed = false;
  let cleanupCalled = false;

  const triggerCleanupOnce = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    if (typeof onStreamClosed === 'function') {
      onStreamClosed();
    }
  };

  return new ReadableStream({
    start(controller) {
      try {
        nodeStream = fs.createReadStream(/*turbopackIgnore: true*/ filePath, streamOpts);
      } catch (err) {
        closed = true;
        triggerCleanupOnce();
        try {
          controller.error(err);
        } catch {}
        return;
      }

      nodeStream.on('data', chunk => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
          nodeStream.destroy();
        }
      });

      nodeStream.on('end', () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      });

      nodeStream.on('error', () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      });

      nodeStream.on('close', () => {
        closed = true;
        triggerCleanupOnce();
      });
    },
    cancel() {
      closed = true;
      if (nodeStream) {
        nodeStream.destroy();
      }
      triggerCleanupOnce();
    }
  });
}

export async function GET(request) {
  const user = getSessionUser(request);
  if (!user) {
    return new Response('No autorizado', { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const file = searchParams.get('file');
  const isDownload = searchParams.get('download') === '1';

  if (!file) {
    return new Response('Archivo no especificado', { status: 400 });
  }

  const cleanFile = path.basename(file);
  if (cleanFile !== file || !/\.(mp3|m4a|opus|wav|flac)$/i.test(cleanFile)) {
    return new Response('Nombre de archivo inválido', { status: 400 });
  }

  const downloadsDir = getDownloadsDir();
  const safePath = path.resolve(downloadsDir, cleanFile);
  if (!safePath.startsWith(path.resolve(downloadsDir) + path.sep) || !fs.existsSync(safePath)) {
    return new Response('Archivo no encontrado', { status: 404 });
  }

  const stat = fs.statSync(safePath);
  const range = request.headers.get('range');

  const headers = {
    'Content-Type': getAudioMimeType(cleanFile),
    'Accept-Ranges': 'bytes',
    'Content-Length': stat.size
  };

  if (isDownload) {
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(cleanFile)}"`;
  }

  // Always schedule server file deletion once it has been served to the client
  scheduleFileCleanup(safePath, 15000);

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunksize = end - start + 1;

    const webStream = createSafeFileStream(
      safePath,
      { start, end },
      end >= stat.size - 1 ? () => scheduleFileCleanup(safePath, 5000) : null
    );

    return new Response(webStream, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': chunksize
      }
    });
  }

  const webStream = createSafeFileStream(safePath, undefined, () =>
    scheduleFileCleanup(safePath, 5000)
  );
  return new Response(webStream, { headers });
}
