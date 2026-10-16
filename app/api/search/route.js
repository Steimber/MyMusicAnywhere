import { NextResponse } from 'next/server';

function formatMillis(ms) {
  if (!ms || isNaN(ms)) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

async function searchDeezerFallback(q) {
  try {
    const deezerUrl = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=15`;
    const res = await fetch(deezerUrl, { next: { revalidate: 3600 } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(item => {
      const sec = Number(item.duration) || 0;
      return {
        id: `dz_${item.id}`,
        title: item.title || 'Canción',
        artist: item.artist?.name || 'Artista',
        album: item.album?.title || 'Single',
        genre: 'Música',
        artwork:
          item.album?.cover_medium ||
          item.album?.cover_big ||
          item.album?.cover_small ||
          '/icon.svg',
        previewUrl: item.preview || null,
        duration: formatMillis(sec * 1000),
        durationSec: sec
      };
    });
  } catch {
    return [];
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q');

  if (!q) {
    return NextResponse.json({ error: 'Falta término de búsqueda' }, { status: 400 });
  }

  let results = [];
  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=25`;
    const response = await fetch(itunesUrl, { next: { revalidate: 3600 } });
    if (response.ok) {
      const data = await response.json();
      results = (data.results || []).map(r => ({
        id: r.trackId,
        title: r.trackName,
        artist: r.artistName,
        album: r.collectionName,
        genre: r.primaryGenreName || 'Música',
        artwork: (r.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
        previewUrl: r.previewUrl,
        duration: formatMillis(r.trackTimeMillis),
        durationSec: Math.round((r.trackTimeMillis || 0) / 1000)
      }));
    }
  } catch {}

  if (results.length === 0) {
    results = await searchDeezerFallback(q);
  }

  return NextResponse.json({ results, tracks: results });
}
