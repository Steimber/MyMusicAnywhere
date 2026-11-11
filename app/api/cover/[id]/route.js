import {
  getSessionUser,
  getUploadRecordById,
  readUploadCoverBuffer,
  resolveSafeCoverPath
} from '../../../../lib/store.js';
import { UPLOAD_ID_REGEX } from '../../../../lib/upload.js';

export const runtime = 'nodejs';

export async function GET(request, context) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const resolvedParams = await context?.params;
  const id = String(resolvedParams?.id || '').trim();
  if (!UPLOAD_ID_REGEX.test(id) || !resolveSafeCoverPath(id)) {
    return Response.json({ error: 'Identificador de portada inválido.' }, { status: 400 });
  }

  const record = getUploadRecordById(id);
  if (!record) {
    return Response.json({ error: 'Canción subida no encontrada.' }, { status: 404 });
  }

  if (record.userId !== user.id) {
    return Response.json(
      { error: 'No tienes permiso para acceder a esta portada.' },
      { status: 403 }
    );
  }

  const cover = readUploadCoverBuffer(id);
  if (!cover.ok) {
    return Response.json({ error: cover.error }, { status: cover.status || 404 });
  }

  return new Response(cover.buffer, {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(cover.buffer.length),
      'Cache-Control': 'private, max-age=86400'
    }
  });
}
