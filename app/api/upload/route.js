import { getSessionUser, getUserUploadRecords } from '../../../lib/store.js';
import {
  ensureUploadCleanupScheduler,
  handleChunkedUploadRequest,
  handleMultipartUploadRequest
} from '../../../lib/upload.js';

export const runtime = 'nodejs';

export async function GET(request) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  ensureUploadCleanupScheduler();
  const tracks = getUserUploadRecords(user.id);
  return Response.json({ ok: true, tracks });
}

export async function POST(request) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  ensureUploadCleanupScheduler();

  try {
    const isChunked =
      request.headers.get('x-upload-mode') === 'chunk' ||
      request.headers.get('x-chunk-index') !== null;

    const result = isChunked
      ? await handleChunkedUploadRequest(request, user)
      : await handleMultipartUploadRequest(request, user);

    const status = result.status || (result.ok ? 200 : 400);
    return Response.json(result, { status });
  } catch {
    return Response.json(
      { ok: false, error: 'Error interno procesando el archivo de audio.' },
      { status: 500 }
    );
  }
}
