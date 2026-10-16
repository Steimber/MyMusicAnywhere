import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../lib/store';

function formatMillis(ms) {
  if (!ms || isNaN(ms)) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function parseSpotifyTarget(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'open.spotify.com') {
      return null;
    }
    // Supports /playlist/{id}, /intl-es/playlist/{id}, /album/{id}, /track/{id}
    const match = u.pathname.match(/\/(?:intl-[a-z]{2}\/)?(playlist|album|track)\/([a-zA-Z0-9]{15,32})/);
    if (!match) return null;
    return { type: match[1], id: match[2] };
  } catch {
    return null;
  }
}

export async function POST(request) {
  try {
    const user = getSessionUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Inicia sesión para importar' }, { status: 401 });
    }

    const body = await request.json();
    const target = parseSpotifyTarget(body.url);
    if (!target) {
      return NextResponse.json(
        {
          error:
            'Pega un enlace válido de Spotify (https://open.spotify.com/playlist/..., /album/... o /track/...).'
        },
        { status: 400 }
      );
    }

    // Safe hardcoded origin + validated type & alphanumeric ID
    const embedUrl = `https://open.spotify.com/embed/${target.type}/${target.id}`;
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: 'No se pudo leer la lista de Spotify. Verifica que la playlist sea pública.' },
        { status: 400 }
      );
    }

    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) {
      return NextResponse.json(
        { error: 'No se encontraron pistas en el enlace de Spotify.' },
        { status: 400 }
      );
    }

    const data = JSON.parse(match[1]);
    const entity = data?.props?.pageProps?.state?.data?.entity;
    if (!entity) {
      return NextResponse.json(
        { error: 'La playlist o álbum parece ser privado o no existe.' },
        { status: 400 }
      );
    }

    const coverArt =
      entity.coverArt?.sources?.[0]?.url ||
      entity.visualIdentity?.image?.[0]?.url ||
      '/icon.svg';

    let tracks = [];
    if (Array.isArray(entity.trackList) && entity.trackList.length > 0) {
      tracks = entity.trackList.map((t, idx) => ({
        id: `sp_${target.id}_${t.uri?.split(':').pop() || idx}`,
        title: (t.title || 'Canción').trim(),
        artist: (t.subtitle || '').replace(/\u00a0/g, ' ').trim(),
        album: entity.name || 'Spotify Import',
        genre: 'Spotify',
        artwork: coverArt,
        previewUrl: t.audioPreview?.url || null,
        duration: formatMillis(t.duration),
        durationSec: Math.round((t.duration || 0) / 1000)
      }));
    } else if (entity.type === 'track' || target.type === 'track') {
      const artists = Array.isArray(entity.artists)
        ? entity.artists.map(a => a.name).join(', ')
        : entity.subtitle || '';
      tracks = [
        {
          id: `sp_track_${target.id}`,
          title: entity.name || entity.title || 'Canción',
          artist: artists.replace(/\u00a0/g, ' ').trim(),
          album: 'Spotify Import',
          genre: 'Spotify',
          artwork: coverArt,
          previewUrl: entity.audioPreview?.url || null,
          duration: formatMillis(entity.duration),
          durationSec: Math.round((entity.duration || 0) / 1000)
        }
      ];
    }

    if (tracks.length === 0) {
      return NextResponse.json(
        { error: 'No se encontraron canciones en esa playlist de Spotify.' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      playlistName: entity.name || 'Spotify',
      count: tracks.length,
      tracks
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
