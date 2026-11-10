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
  return Response.json({
    ok: true,
    hasSnapshot: snapshot.hasSnapshot,
    likedTracks: snapshot.likedTracks,
    customPlaylists: snapshot.customPlaylists,
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
    (!Array.isArray(parsed.likedTracks) && !Array.isArray(parsed.customPlaylists))
  ) {
    return Response.json(
      { error: 'Se requiere al menos likedTracks o customPlaylists como arreglo.' },
      { status: 400 }
    );
  }

  const saved = saveUserCollections(user.id, parsed);
  return Response.json({
    ok: true,
    updatedAt: saved?.updatedAt || Date.now(),
    counts: {
      liked: saved?.likedTracks?.length || 0,
      playlists: saved?.customPlaylists?.length || 0
    }
  });
}
