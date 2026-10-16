import { NextResponse } from 'next/server';

function formatMillis(ms) {
  if (!ms || isNaN(ms)) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q');

  if (!q) {
    return NextResponse.json({ error: 'Falta término de búsqueda' }, { status: 400 });
  }

  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=30`;
    const response = await fetch(itunesUrl, { next: { revalidate: 3600 } });
    const data = await response.json();

    const results = (data.results || []).map(r => ({
      id: r.trackId,
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName,
      genre: r.primaryGenreName || 'Música',
      artwork: (r.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
      previewUrl: r.previewUrl,
      duration: formatMillis(r.trackTimeMillis),
      durationSec: Math.round((r.trackTimeMillis || 0) / 1000)
    }));

    return NextResponse.json({ results, tracks: results });
  } catch (err) {
    console.error('Search error:', err);
    return NextResponse.json({ error: 'Error al consultar catálogo de música' }, { status: 500 });
  }
}
