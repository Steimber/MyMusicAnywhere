import { getSessionUser } from '../../../lib/store.js';
import {
  MAX_LISTENING_BODY_BYTES,
  getUserListeningHistory,
  saveUserListeningHistory
} from '../../../lib/listening-store.js';

export const runtime = 'nodejs';

export async function GET(request) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const data = getUserListeningHistory(user.id);
  if (!data.ok) {
    return Response.json({ error: data.error }, { status: data.status || 400 });
  }

  return Response.json({
    hasSnapshot: Boolean(data.hasSnapshot),
    version: data.version,
    updatedAt: data.updatedAt,
    entries: data.entries
  });
}

export async function PUT(request) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  let rawText = '';
  try {
    rawText = await request.text();
  } catch {
    return Response.json({ error: 'Cuerpo de solicitud inválido' }, { status: 400 });
  }

  if (Buffer.byteLength(rawText, 'utf8') > MAX_LISTENING_BODY_BYTES) {
    return Response.json(
      { error: 'El historial de escucha supera el límite permitido de 1 MB.' },
      { status: 413 }
    );
  }

  let body;
  try {
    body = JSON.parse(rawText || '{}');
  } catch {
    return Response.json({ error: 'Formato JSON inválido' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Datos de escucha inválidos' }, { status: 400 });
  }

  const result = saveUserListeningHistory(user.id, {
    baseVersion: body.baseVersion,
    entries: body.entries
  });

  if (!result.ok) {
    if (result.status === 409 && result.snapshot) {
      return Response.json(
        {
          error: 'Conflicto de versión en historial de escucha.',
          conflict: true,
          hasSnapshot: Boolean(result.snapshot.hasSnapshot),
          version: result.snapshot.version,
          updatedAt: result.snapshot.updatedAt,
          entries: result.snapshot.entries
        },
        { status: 409 }
      );
    }
    return Response.json({ error: result.error }, { status: result.status || 400 });
  }

  const saved = result.snapshot;
  return Response.json({
    ok: true,
    version: saved.version,
    updatedAt: saved.updatedAt,
    entryCount: Object.keys(saved.entries || {}).length
  });
}
