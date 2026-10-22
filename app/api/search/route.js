import { NextResponse } from 'next/server';
import { cleanYouTubeOembedMetadata } from '../../../lib/download/candidates';

function formatMillis(ms) {
  if (!ms || isNaN(ms)) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function extractYouTubeVideoId(rawInput) {
  const str = String(rawInput || '').trim();
  if (!str) return null;
  try {
    const parsed = new URL(str);
    const host = parsed.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com'
    ) {
      const v = parsed.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const parts = parsed.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && parts[1]) {
        return /^[\w-]{11}$/.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {}
  const match = str.match(
    /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i
  );
  return match ? match[1] : null;
}

async function resolveYouTubeLinkTrack(videoId) {
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const defaultArtwork = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  let rawTitle = `YouTube (${videoId})`;
  let authorName = 'YouTube';
  let artwork = defaultArtwork;

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      canonicalUrl
    )}&format=json`;
    const res = await fetch(oembedUrl, { next: { revalidate: 3600 } });
    if (res.ok) {
      const data = await res.json();
      if (data.title) rawTitle = String(data.title).trim();
      if (data.author_name) {
        authorName = String(data.author_name).trim();
      }
      if (data.thumbnail_url) artwork = data.thumbnail_url;
    }
  } catch {}

  const cleanedMeta = cleanYouTubeOembedMetadata(rawTitle, authorName);

  return {
    id: `yt_${videoId}`,
    title: cleanedMeta.title || rawTitle,
    artist: cleanedMeta.artist || 'YouTube',
    album: 'YouTube',
    genre: 'YouTube',
    artwork,
    previewUrl: null,
    duration: '—',
    durationSec: 0,
    sourceUrl: canonicalUrl
  };
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

  const ytVideoId = extractYouTubeVideoId(q);
  if (ytVideoId) {
    const ytTrack = await resolveYouTubeLinkTrack(ytVideoId);
    return NextResponse.json({ results: [ytTrack], tracks: [ytTrack] });
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
