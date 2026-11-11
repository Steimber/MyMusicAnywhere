// Offline network interceptor loaded via NODE_OPTIONS="--import ./tests/e2e/preload-offline-net.mjs"
// Ensures the Next.js server never touches external internet hosts during E2E runs.

const realFetch = globalThis.fetch;

const BASE_ARTISTS = [
  { name: 'Solar Echo', genre: 'Electronic', album: 'Polar Lights' },
  { name: 'Lunar Pulse', genre: 'Electronic', album: 'Midnight Orbit' },
  { name: 'Neon Drift', genre: 'Indie', album: 'City Reflections' },
  { name: 'Velvet Horizon', genre: 'Rock', album: 'Crimson Sky' },
  { name: 'Cobalt Wave', genre: 'Pop', album: 'Ocean Signal' },
  { name: 'Amber Tide', genre: 'Indie', album: 'Golden Hour' },
  { name: 'Crystal Static', genre: 'Electronic', album: 'Glass Radio' },
  { name: 'Midnight Prism', genre: 'Rock', album: 'Refraction' }
];

const MOCK_SONGS = [
  { id: 900101, title: 'Aurora Borealis', artist: 'Solar Echo', album: 'Polar Lights', genre: 'Electronic' },
  { id: 900102, title: 'Solar Wind', artist: 'Solar Echo', album: 'Polar Lights', genre: 'Electronic' },
  { id: 900103, title: 'Tidal Gravity', artist: 'Lunar Pulse', album: 'Midnight Orbit', genre: 'Electronic' },
  { id: 900104, title: 'Moonlit Boulevard', artist: 'Neon Drift', album: 'City Reflections', genre: 'Indie' },
  { id: 900105, title: 'Sunset Mirage', artist: 'Velvet Horizon', album: 'Crimson Sky', genre: 'Rock' },
  { id: 900106, title: 'Deep Current', artist: 'Cobalt Wave', album: 'Ocean Signal', genre: 'Pop' },
  { id: 900107, title: 'Warm Coastline', artist: 'Amber Tide', album: 'Golden Hour', genre: 'Indie' },
  { id: 900108, title: 'Clear Frequency', artist: 'Crystal Static', album: 'Glass Radio', genre: 'Electronic' },
  { id: 900109, title: 'Spectrum Line', artist: 'Midnight Prism', album: 'Refraction', genre: 'Rock' },
  { id: 900110, title: 'Northern Star', artist: 'Lunar Pulse', album: 'Midnight Orbit', genre: 'Electronic' },
  { id: 900111, title: 'Paper Lanterns', artist: 'Neon Drift', album: 'City Reflections', genre: 'Indie' },
  { id: 900112, title: 'Desert Highway', artist: 'Velvet Horizon', album: 'Crimson Sky', genre: 'Rock' },
  { id: 900113, title: 'Blue Horizon', artist: 'Cobalt Wave', album: 'Ocean Signal', genre: 'Pop' },
  { id: 900114, title: 'Summer Breeze', artist: 'Amber Tide', album: 'Golden Hour', genre: 'Indie' },
  { id: 900115, title: 'Analog Dreams', artist: 'Crystal Static', album: 'Glass Radio', genre: 'Electronic' },
  { id: 900116, title: 'Silver Echo', artist: 'Midnight Prism', album: 'Refraction', genre: 'Rock' },
  { id: 900117, title: 'Magnetic North', artist: 'Solar Echo', album: 'Polar Lights', genre: 'Electronic' },
  { id: 900118, title: 'Starlight Drive', artist: 'Cobalt Wave', album: 'Ocean Signal', genre: 'Pop' },
  { id: 900119, title: 'Quiet Harbor', artist: 'Amber Tide', album: 'Golden Hour', genre: 'Indie' },
  { id: 900120, title: 'Glass Horizon', artist: 'Crystal Static', album: 'Glass Radio', genre: 'Electronic' }
];

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function toItunesItem(song, origin) {
  return {
    trackId: song.id,
    trackName: song.title,
    artistName: song.artist,
    collectionName: song.album,
    primaryGenreName: song.genre,
    trackTimeMillis: 62000,
    artworkUrl100: `${origin}/icon.svg`,
    previewUrl: null
  };
}

globalThis.fetch = async function offlineMockFetch(input, init) {
  let rawUrl = '';
  if (typeof input === 'string') {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.href;
  } else if (input && typeof input.url === 'string') {
    rawUrl = input.url;
  }

  let parsed = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return realFetch(input, init);
  }

  if (isLocalHost(parsed.hostname)) {
    return realFetch(input, init);
  }

  const localOrigin = process.env.E2E_BASE_URL || 'http://127.0.0.1:3199';
  const host = parsed.hostname.toLowerCase();

  if (host.includes('itunes.apple.com')) {
    const term = String(parsed.searchParams.get('term') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(parsed.searchParams.get('limit')) || 20));
    const tokens = term.split(/\s+/).filter(Boolean);
    const matched = tokens.length
      ? MOCK_SONGS.filter(s => {
          const hay = `${s.title} ${s.artist} ${s.album} ${s.genre}`.toLowerCase();
          return tokens.every(t => hay.includes(t));
        })
      : [];

    const finalSongs = matched.length > 0 ? matched : MOCK_SONGS;
    return jsonResponse({
      resultCount: Math.min(limit, finalSongs.length),
      results: finalSongs.slice(0, limit).map(s => toItunesItem(s, localOrigin))
    });
  }

  if (host.includes('api.deezer.com')) {
    const p = parsed.pathname;
    if (p.includes('/search/artist')) {
      const q = String(parsed.searchParams.get('q') || 'Solar Echo').trim();
      return jsonResponse({
        data: [{ id: 501, name: q || 'Solar Echo', picture_medium: `${localOrigin}/icon.svg` }]
      });
    }
    if (p.includes('/related')) {
      return jsonResponse({
        data: BASE_ARTISTS.slice(0, 4).map((a, idx) => ({
          id: 600 + idx,
          name: a.name,
          picture_medium: `${localOrigin}/icon.svg`
        }))
      });
    }
    if (p.includes('/top') || p.includes('/search')) {
      return jsonResponse({
        data: MOCK_SONGS.slice(0, 8).map(s => ({
          id: s.id,
          title: s.title,
          title_short: s.title,
          duration: 62,
          preview: null,
          artist: { name: s.artist },
          album: {
            title: s.album,
            cover_small: `${localOrigin}/icon.svg`,
            cover_medium: `${localOrigin}/icon.svg`,
            cover_big: `${localOrigin}/icon.svg`
          }
        }))
      });
    }
    return jsonResponse({ data: [] });
  }

  if (host.includes('youtube.com') || host.includes('soundcloud.com')) {
    return jsonResponse({
      title: 'Solar Echo - Aurora Borealis',
      author_name: 'Solar Echo',
      thumbnail_url: `${localOrigin}/icon.svg`
    });
  }

  return jsonResponse({});
};
