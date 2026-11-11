import fs from 'fs';
import path from 'path';
import {
  deleteUserUploadRecord,
  getDownloadsDir,
  getSessionUser,
  getUploadRecordById,
  markUploadFileDeleted,
  updateUserUploadMetadata
} from '../../../../lib/store.js';
import { UPLOAD_ID_REGEX } from '../../../../lib/upload.js';

export const runtime = 'nodejs';

const MAX_PATCH_BYTES = 64 * 1024;

export async function PATCH(request, context) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const resolvedParams = await context?.params;
  const id = String(resolvedParams?.id || '').trim();
  if (!UPLOAD_ID_REGEX.test(id)) {
    return Response.json({ error: 'Identificador de subida inválido.' }, { status: 400 });
  }

  let rawBody = '';
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: 'Cuerpo de solicitud inválido.' }, { status: 400 });
  }

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_PATCH_BYTES) {
    return Response.json({ error: 'Los metadatos enviados exceden el tamaño permitido.' }, { status: 413 });
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return Response.json({ error: 'Formato JSON inválido.' }, { status: 400 });
  }

  const updated = updateUserUploadMetadata(id, user.id, body || {});
  if (!updated.ok) {
    return Response.json({ error: updated.error }, { status: updated.status || 400 });
  }

  return Response.json({
    ok: true,
    id,
    track: updated.record
  });
}

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

  let deleteRecord = false;
  try {
    deleteRecord = new URL(request.url).searchParams.get('record') === '1';
  } catch {}

  if (deleteRecord) {
    const removed = deleteUserUploadRecord(id, user.id);
    if (!removed.ok) {
      return Response.json({ error: removed.error }, { status: removed.status || 400 });
    }
    return Response.json({
      ok: true,
      id,
      deleted: true,
      recordDeleted: true,
      coverDeleted: removed.coverDeleted,
      removedFromDisk: removed.removedFromDisk
    });
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
