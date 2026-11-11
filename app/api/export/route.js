import { getSessionUser, getUserCollections } from '../../../lib/store.js';
import { getUserListeningHistory } from '../../../lib/listening-store.js';

export const runtime = 'nodejs';

export async function GET(request) {
  const user = getSessionUser(request);
  if (!user) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const collections = getUserCollections(user.id);
  if (!collections.ok) {
    return Response.json({ error: collections.error }, { status: collections.status || 400 });
  }

  const listening = getUserListeningHistory(user.id);
  if (!listening.ok) {
    return Response.json({ error: listening.error }, { status: listening.status || 400 });
  }

  const exportedAt = new Date().toISOString();
  const dateStamp = exportedAt.slice(0, 10);
  const safeUsername =
    String(user.username || 'usuario')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'usuario';

  const payload = {
    app: 'MyMusicAnywhere',
    version: 1,
    exportedAt,
    user: {
      id: user.id,
      username: user.username
    },
    likedTracks: collections.likedTracks,
    customPlaylists: collections.customPlaylists,
    listening: {
      version: listening.version,
      updatedAt: listening.updatedAt,
      entries: listening.entries
    }
  };

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="mymusic-datos-${safeUsername}-${dateStamp}.json"`,
      'Cache-Control': 'no-store'
    }
  });
}
