import fs from 'fs';
import path from 'path';
import {
  getDownloadsDir,
  getSessionUser,
  getUploadRecordById,
  markUploadFileDeleted
} from '../../../../lib/store.js';
import { UPLOAD_ID_REGEX } from '../../../../lib/upload.js';

export const runtime = 'nodejs';

export async function DELETE(request, context) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const resolvedParams = await context?.params;
  const id = String(resolvedParams?.id || '').trim();
  if (!UPLOAD_ID_REGEX.test(id)) {
    return Response.json({ error: 'Identificador de subida inválido.' }, { status: 400 });
  }

  const record = getUploadRecordById(id);
  if (!record) {
    return Response.json({ error: 'Canción subida no encontrada.' }, { status: 404 });
  }

  if (record.userId !== user.id) {
    return Response.json(
      { error: 'No tienes permiso para eliminar este archivo.' },
      { status: 403 }
    );
  }

  const downloadsDir = path.resolve(getDownloadsDir());
  const cleanFilename = path.basename(String(record.filename || `${id}.m4a`));
  const targetPath = path.resolve(downloadsDir, cleanFilename);

  if (!targetPath.startsWith(downloadsDir + path.sep)) {
    return Response.json({ error: 'Ruta inválida.' }, { status: 400 });
  }

  let removedFromDisk = false;
  try {
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      removedFromDisk = true;
    }
  } catch {
    return Response.json(
      { error: 'No se pudo borrar el archivo temporal del servidor.' },
      { status: 500 }
    );
  }

  const updated = markUploadFileDeleted(id);
  return Response.json({
    ok: true,
    id,
    deleted: true,
    removedFromDisk,
    track: updated
  });
}
