import {
  getSessionUser,
  getUserCollections,
  saveUserCollections
} from '../../../lib/store.js';

export const runtime = 'nodejs';

const MAX_COLLECTIONS_BYTES = 2 * 1024 * 1024; // 2 MB cap for lightweight metadata JSON

export async function GET(request) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const snapshot = getUserCollections(user.id);
  if (!snapshot.ok) {
    return Response.json({ error: snapshot.error }, { status: snapshot.status || 400 });
  }

  return Response.json({
    ok: true,
    hasSnapshot: snapshot.hasSnapshot,
    version: snapshot.version,
    likedTracks: snapshot.likedTracks,
    deletedLikes: snapshot.deletedLikes,
    customPlaylists: snapshot.customPlaylists,
    deletedPlaylists: snapshot.deletedPlaylists,
    updatedAt: snapshot.updatedAt
  });
}

export async function PUT(request) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const declaredLen = parseInt(request.headers.get('content-length') || '0', 10);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_COLLECTIONS_BYTES) {
    return Response.json(
      { error: 'El respaldo de librerías supera el tamaño máximo permitido (2 MB).' },
      { status: 413 }
    );
  }

  let rawBody = '';
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: 'No se pudo leer el cuerpo de la solicitud.' }, { status: 400 });
  }

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_COLLECTIONS_BYTES) {
    return Response.json(
      { error: 'El respaldo de librerías supera el tamaño máximo permitido (2 MB).' },
      { status: 413 }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody || '{}');
  } catch {
    return Response.json({ error: 'Formato JSON inválido.' }, { status: 400 });
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (!Array.isArray(parsed.likedTracks) && !Array.isArray(parsed.customPlaylists))
  ) {
    return Response.json(
      { error: 'Se requiere al menos likedTracks o customPlaylists como arreglo.' },
      { status: 400 }
    );
  }

  const result = saveUserCollections(user.id, parsed);
  if (!result.ok) {
    if (result.status === 409 && result.snapshot) {
      return Response.json(
        {
          error: 'Conflicto de versión en colecciones.',
          conflict: true,
          hasSnapshot: result.snapshot.hasSnapshot,
          version: result.snapshot.version,
          likedTracks: result.snapshot.likedTracks,
          deletedLikes: result.snapshot.deletedLikes,
          customPlaylists: result.snapshot.customPlaylists,
          deletedPlaylists: result.snapshot.deletedPlaylists,
          updatedAt: result.snapshot.updatedAt
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
    counts: {
      liked: saved.likedTracks.length,
      playlists: saved.customPlaylists.length
    }
  });
}
