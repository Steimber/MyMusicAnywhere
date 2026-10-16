import fs from 'fs';
import path from 'path';
import { getDownloadsDir, scheduleFileCleanup } from '../../../lib/store';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const file = searchParams.get('file');
  const isDownload = searchParams.get('download') === '1';

  if (!file) {
    return new Response('Archivo no especificado', { status: 400 });
  }

  const downloadsDir = getDownloadsDir();
  const safePath = path.normalize(path.join(downloadsDir, file));
  if (!safePath.startsWith(downloadsDir) || !fs.existsSync(safePath)) {
    return new Response('Archivo no encontrado', { status: 404 });
  }

  const stat = fs.statSync(safePath);
  const range = request.headers.get('range');

  const headers = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Content-Length': stat.size
  };

  if (isDownload) {
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(safePath))}"`;
    scheduleFileCleanup(safePath, 25000);
  }

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunksize = end - start + 1;

    const stream = fs.createReadStream(safePath, { start, end });

    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': chunksize
      }
    });
  }

  const stream = fs.createReadStream(safePath);
  return new Response(stream, { headers });
}
