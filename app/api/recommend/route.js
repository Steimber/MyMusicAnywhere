import { buildSmartShuffleOrder } from '../../../lib/shuffle.js';
import { createSeededRng, isCleanTerm } from '../../../lib/autoplaylists.js';

const CURATED_DISCOVERY_POOLS = [
  { label: ' Tendencias Globales & Pop', artists: ['The Weeknd', 'Dua Lipa', 'Bruno Mars', 'Billie Eilish', 'Calvin Harris'] },
  { label: 'Urbano & Latino Hits', artists: ['Bad Bunny', 'Feid', 'Karol G', 'Rauw Alejandro', 'Quevedo'] },
  { label: 'Rock & Alternativo', artists: ['Arctic Monkeys', 'The Strokes', 'Soda Stereo', 'Queen', 'Gorillaz'] },
  { label: 'Electrónica & Dance', artists: ['Daft Punk', 'Fred again..', 'RÜFÜS DU SOL', 'Disclosure', 'Justice'] },
  { label: 'R&B, Soul & Chill', artists: ['SZA', 'Frank Ocean', 'Daniel Caesar', 'Kali Uchis', 'Anderson .Paak'] }
];

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

async function fetchJsonWithTimeout(url, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getDeezerRelatedTracksForArtist(artistName, genreLabel = 'Recomendado') {
  const primaryArtist = artistName.split(/[,&feat.]/i)[0].trim();
  if (!isCleanTerm(primaryArtist)) return { relatedNames: [], tracks: [] };

  const searchData = await fetchJsonWithTimeout(
    `https://api.deezer.com/search/artist?q=${encodeURIComponent(primaryArtist)}&limit=1`
  );
  const artistObj = searchData?.data?.[0];
  if (!artistObj?.id) return { relatedNames: [], tracks: [] };

  const [relatedData, ownTopData] = await Promise.all([
    fetchJsonWithTimeout(`https://api.deezer.com/artist/${artistObj.id}/related?limit=6`),
    fetchJsonWithTimeout(`https://api.deezer.com/artist/${artistObj.id}/top?limit=4`)
  ]);

  const relatedArtists = (relatedData?.data || []).slice(0, 4);
  const relatedTopLists = await Promise.all(
    relatedArtists.map(rel =>
      fetchJsonWithTimeout(`https://api.deezer.com/artist/${rel.id}/top?limit=4`)
    )
  );

  const rawTracks = [
    ...(ownTopData?.data || []),
    ...relatedTopLists.flatMap(d => d?.data || [])
  ];

  const mapped = rawTracks.map(item => ({
    id: `dz_${item.id}`,
    title: item.title_short || item.title,
    artist: item.artist?.name || primaryArtist,
    album: item.album?.title || '',
    artwork:
      item.album?.cover_big ||
      item.album?.cover_medium ||
      artistObj.picture_medium ||
      '/icon.svg',
    previewUrl: null,
    duration: formatDuration(item.duration),
    genre: genreLabel
  }));

  return {
    relatedNames: relatedArtists.map(r => r.name),
    tracks: mapped
  };
}

async function getItunesTracksForQuery(term, limit = 10) {
  const data = await fetchJsonWithTimeout(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`
  );
  if (!data?.results) return [];
  return data.results.map(item => ({
    id: item.trackId,
    title: item.trackName,
    artist: item.artistName,
    album: item.collectionName,
    artwork: item.artworkUrl100
      ? item.artworkUrl100.replace('100x100bb', '600x600bb')
      : '/icon.svg',
    previewUrl: item.previewUrl || null,
    duration: formatDuration(Math.round((item.trackTimeMillis || 0) / 1000)),
    genre: item.primaryGenreName || 'Música'
  }));
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'random' ? 'random' : 'recommended';
    const rng =
      typeof body.seed === 'string' && body.seed.trim()
        ? createSeededRng(body.seed.trim())
        : Math.random;
    const rawArtists = Array.isArray(body.artists) ? body.artists.filter(isCleanTerm) : [];
    const rawGenres = Array.isArray(body.genres) ? body.genres.filter(isCleanTerm) : [];
    const excludeKeys = new Set(
      Array.isArray(body.excludeKeys) ? body.excludeKeys.map(k => String(k).toLowerCase()) : []
    );

    let seedArtists = [];
    let label = '';
    let finalMode = mode;

    if (mode === 'recommended' && (rawArtists.length > 0 || rawGenres.length > 0)) {
      // Pick up to 3 top affinity artists deterministically when seeded, or varied from top 6
      const topPool = [...new Set(rawArtists)].slice(0, 6);
      const shuffledSeeds = [...topPool];
      for (let i = shuffledSeeds.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffledSeeds[i], shuffledSeeds[j]] = [shuffledSeeds[j], shuffledSeeds[i]];
      }
      seedArtists = shuffledSeeds.slice(0, 3);
      const topGenre = rawGenres[0] || '';
      label =
        seedArtists.length > 0
          ? `Similares a ${seedArtists.slice(0, 2).join(', ')}`
          : topGenre;
    } else {
      finalMode = 'random';
      const chosenPool =
        CURATED_DISCOVERY_POOLS[Math.floor(rng() * CURATED_DISCOVERY_POOLS.length)];
      const shuffledArtists = [...chosenPool.artists];
      for (let i = shuffledArtists.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffledArtists[i], shuffledArtists[j]] = [shuffledArtists[j], shuffledArtists[i]];
      }
      seedArtists = shuffledArtists.slice(0, 3);
      label = chosenPool.label.trim();
    }

    const genreTag = rawGenres[0] || 'Recomendado';
    let collected = [];

    if (seedArtists.length > 0) {
      const deezerBatches = await Promise.all(
        seedArtists.map(art => getDeezerRelatedTracksForArtist(art, genreTag))
      );
      for (const batch of deezerBatches) {
        collected.push(...batch.tracks);
      }
    }

    // Fallback or supplement with iTunes catalog if Deezer returned fewer than 10 tracks
    if (collected.length < 10) {
      const fallbackSeeds =
        seedArtists.length > 0 ? seedArtists : rawGenres.length > 0 ? rawGenres.slice(0, 2) : ['Top Hits'];
      const itunesBatches = await Promise.all(
        fallbackSeeds.map(q => getItunesTracksForQuery(q, 12))
      );
      for (const list of itunesBatches) {
        collected.push(...list);
      }
    }

    // Deduplicate by title|artist and exclude tracks already in user's library
    const seen = new Set();
    const uniqueTracks = [];
    for (const t of collected) {
      if (!t.title || !t.artist) continue;
      const key = `${t.title.trim().toLowerCase()}|${t.artist.trim().toLowerCase()}`;
      if (seen.has(key) || excludeKeys.has(key)) continue;
      seen.add(key);
      uniqueTracks.push(t);
    }

    const orderIndices = buildSmartShuffleOrder(uniqueTracks, { rng });
    const smartOrdered = orderIndices.map(i => uniqueTracks[i]).slice(0, 32);

    return Response.json({
      mode: finalMode,
      label: label || 'Mix descubierto',
      results: smartOrdered,
      tracks: smartOrdered
    });
  } catch (err) {
    return Response.json({ error: err.message, results: [], tracks: [] }, { status: 500 });
  }
}
