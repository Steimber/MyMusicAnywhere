import { useEffect, useMemo } from 'react';
import {
  formatLocalDateKey,
  generateAutoPlaylists,
  getTopAffinityArtists,
  isRealGenre
} from '../../lib/autoplaylists';
import {
  FORYOU_RECS_STORAGE_KEY,
  EXPLORE_CHIPS,
  getTrackDedupKey,
  sanitizeLikedTracksList
} from './trackUtils';

export function useExploreSearch({
  apiRef,
  user,
  isOffline,
  activeTab,
  likedTracks,
  customPlaylists,
  offlineCatalog,
  offlineUrls,
  listeningEntries,
  forYouRecommendations,
  setForYouRecommendations,
  forYouRefreshNonce,
  setForYouRefreshNonce,
  setForYouRefreshing,
  setForYouSavedMap,
  forYouLastFetchKeyRef,
  setLoading,
  setFeedInfo,
  setResults,
  isTrackAvailableOffline,
  openDownloadPromptModal,
  createCustomPlaylist
}) {
  function isIgnoredTasteTerm(val) {
    if (!val || typeof val !== 'string') return true;
    const norm = val.trim().toLowerCase();
    if (norm.length < 2) return true;
    const ignored = new Set([
      'offline',
      'música',
      'musica',
      'music',
      'unknown',
      'desconocido',
      'general',
      'mp3',
      'audio',
      'track',
      'pista',
      'spotify',
      'spotify csv',
      'importado de spotify',
      'guardado en dispositivo',
      'archivo propio',
      'mi música',
      'mi musica',
      'audio subido',
      'artista'
    ]);
    return ignored.has(norm) || norm.startsWith('offline_');
  }

  function getLikedCategories(tracksList = likedTracks) {
    const counts = {};
    const cleanTracks = sanitizeLikedTracksList(tracksList);
    const playlistTracks = customPlaylists.flatMap(p => p.tracks || []);
    const pool = cleanTracks.length > 0 ? cleanTracks : sanitizeLikedTracksList(playlistTracks);
    for (const t of pool) {
      const artist = !isIgnoredTasteTerm(t.artist) ? t.artist.split(',')[0].trim() : null;
      if (artist) {
        counts[artist] = (counts[artist] || 0) + 2;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }

  async function loadRecommendedOrRandomFeed(tracksList = likedTracks, forceRandom = false) {
    const cleanLikes = sanitizeLikedTracksList(tracksList);
    const playlistTracks = customPlaylists.flatMap(p => p.tracks || []);
    const tastePool = cleanLikes.length > 0 ? cleanLikes : sanitizeLikedTracksList(playlistTracks);

    const artistCounts = {};
    const genreCounts = {};
    for (const t of tastePool) {
      if (!isIgnoredTasteTerm(t.artist)) {
        const a = t.artist.split(',')[0].trim();
        artistCounts[a] = (artistCounts[a] || 0) + 1;
      }
      if (!isIgnoredTasteTerm(t.genre)) {
        const g = t.genre.trim();
        genreCounts[g] = (genreCounts[g] || 0) + 1;
      }
    }

    const topArtists = Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .slice(0, 6);
    const topGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .slice(0, 4);

    const allKnownTracks = [...cleanLikes, ...playlistTracks, ...offlineCatalog];
    const excludeKeys = Array.from(
      new Set(
        allKnownTracks
          .flatMap(t => [
            `${String(t.title || '').trim().toLowerCase()}|${String(t.artist || '')
              .trim()
              .toLowerCase()}`,
            getTrackDedupKey(t)
          ])
          .filter(k => k && k !== '|')
      )
    ).slice(0, 400);

    const filterOutDownloaded = list =>
      (Array.isArray(list) ? list : []).filter(t => !isTrackAvailableOffline(t));

    const mode =
      !forceRandom && (topArtists.length > 0 || topGenres.length > 0)
        ? 'recommended'
        : 'random';

    setLoading(true);
    try {
      const res = await fetch('/api/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          artists: topArtists,
          genres: topGenres,
          excludeKeys
        })
      });
      if (res.ok) {
        const data = await res.json();
        const freshTracks = filterOutDownloaded(data.tracks);
        if (freshTracks.length > 0) {
          setFeedInfo({
            mode: data.mode || mode,
            label: data.label || (mode === 'recommended' ? topArtists.slice(0, 2).join(', ') : '')
          });
          setResults(freshTracks);
          setLoading(false);
          return;
        }
      }
    } catch {}

    if (mode === 'recommended' && topArtists.length > 0) {
      const chosen = topArtists[Math.floor(Math.random() * topArtists.length)];
      await searchTracks(chosen, { mode: 'recommended', label: chosen });
    } else {
      const fallbackChip = EXPLORE_CHIPS[Math.floor(Math.random() * (EXPLORE_CHIPS.length - 1)) + 1];
      await searchTracks(fallbackChip.term, { mode: 'random', label: fallbackChip.label });
    }
    setLoading(false);
  }

  async function searchTracks(searchTerm, meta = null) {
    if (!searchTerm || !searchTerm.trim()) return;
    setLoading(true);
    const effectiveMeta = meta || { mode: 'search', label: searchTerm.trim() };
    setFeedInfo(effectiveMeta);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchTerm)}`);
      const data = await res.json();
      const rawList = data.results || data.tracks || [];
      setResults(
        effectiveMeta.mode === 'search'
          ? rawList
          : rawList.filter(t => !isTrackAvailableOffline(t))
      );
    } catch {}
    setLoading(false);
  }

  const topAffinityArtistsList = useMemo(() => {
    const likedSet = new Set(likedTracks.filter(Boolean).map(t => String(t.id)));
    const combinedPool = [
      ...likedTracks,
      ...customPlaylists.flatMap(p => p?.tracks || []),
      ...offlineCatalog
    ];
    return getTopAffinityArtists(combinedPool, listeningEntries, { likedIds: likedSet }, 6).map(
      a => a.displayName
    );
  }, [likedTracks, customPlaylists, offlineCatalog, listeningEntries]);

  const topRealGenresList = useMemo(() => {
    const counts = new Map();
    const combinedPool = [
      ...likedTracks,
      ...customPlaylists.flatMap(p => p?.tracks || []),
      ...offlineCatalog
    ];
    for (const tr of combinedPool) {
      if (!tr || !isRealGenre(tr.genre)) continue;
      const g = tr.genre.trim();
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([g]) => g)
      .slice(0, 4);
  }, [likedTracks, customPlaylists, offlineCatalog]);

  useEffect(() => {
    if (!user || isOffline) return;
    if (activeTab !== 'foryou' && forYouRecommendations.length > 0) return;

    const dateKey = formatLocalDateKey(new Date());
    const uid = String(user.id || user.username || 'anon');
    const seedSignature = `${uid}:${dateKey}:${topAffinityArtistsList
      .slice(0, 3)
      .join('|')}:${forYouRefreshNonce}`;
    if (forYouLastFetchKeyRef.current === seedSignature) return;
    forYouLastFetchKeyRef.current = seedSignature;

    const allKnown = [
      ...likedTracks,
      ...customPlaylists.flatMap(p => p?.tracks || []),
      ...offlineCatalog
    ];
    const excludeKeys = Array.from(
      new Set(
        allKnown
          .map(
            t =>
              `${String(t?.title || '').trim().toLowerCase()}|${String(t?.artist || '')
                .trim()
                .toLowerCase()}`
          )
          .filter(k => k && k !== '|')
      )
    ).slice(0, 400);

    let cancelled = false;
    setForYouRefreshing(true);

    fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: topAffinityArtistsList.length > 0 ? 'recommended' : 'random',
        seed: `${uid}:${dateKey}:${forYouRefreshNonce}`,
        artists: topAffinityArtistsList,
        genres: topRealGenresList,
        excludeKeys
      })
    })
      .then(async res => {
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const nextTracks = Array.isArray(data.tracks) ? data.tracks : [];
        if (nextTracks.length > 0) {
          setForYouRecommendations(nextTracks);
          try {
            localStorage.setItem(FORYOU_RECS_STORAGE_KEY, JSON.stringify(nextTracks));
          } catch {}
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setForYouRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    user,
    isOffline,
    activeTab,
    topAffinityArtistsList,
    topRealGenresList,
    forYouRefreshNonce
  ]);

  const autoPlaylistsData = useMemo(() => {
    const uid = String(user?.id || user?.username || 'anon');
    const dateKey = formatLocalDateKey(new Date());
    const filterIfOffline = list =>
      isOffline
        ? (Array.isArray(list) ? list : []).filter(t => isTrackAvailableOffline(t))
        : Array.isArray(list)
        ? list
        : [];

    const scopedCustomPlaylists = isOffline
      ? customPlaylists.map(pl => ({
          ...pl,
          tracks: filterIfOffline(pl?.tracks)
        }))
      : customPlaylists;

    return generateAutoPlaylists({
      userId: uid,
      dateKey,
      tracksPool: filterIfOffline(offlineCatalog),
      likedTracks: filterIfOffline(likedTracks),
      customPlaylists: scopedCustomPlaylists,
      listeningEntries,
      recommendedTracks: filterIfOffline(forYouRecommendations),
      refreshNonce: forYouRefreshNonce
    });
  }, [
    user?.id,
    user?.username,
    isOffline,
    offlineCatalog,
    likedTracks,
    customPlaylists,
    listeningEntries,
    forYouRecommendations,
    forYouRefreshNonce,
    offlineUrls
  ]);

  function handleRefreshForYou() {
    setForYouSavedMap({});
    setForYouRefreshNonce(n => n + 1);
  }

  function handlePlayAutoPlaylist(playlist, startRandom = false) {
    const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
    if (tracks.length === 0) return;

    const offlineReady = tracks.filter(t => isTrackAvailableOffline(t));
    if (offlineReady.length > 0) {
      apiRef.current.playFromList?.(tracks, 0, startRandom, { preserveOrder: !startRandom });
      return;
    }

    if (!isOffline) {
      const targetIdx = startRandom ? Math.floor(Math.random() * tracks.length) : 0;
      openDownloadPromptModal(tracks[targetIdx], tracks, targetIdx);
    }
  }

  function handleSelectForYouTrack(track, list, idx) {
    if (!track) return;
    if (isTrackAvailableOffline(track)) {
      apiRef.current.playFromList?.(list, idx, false, { preserveOrder: true });
      return;
    }
    if (!isOffline) {
      openDownloadPromptModal(track, list, idx);
    }
  }

  function handleSaveAutoPlaylist(playlist) {
    if (!playlist || !Array.isArray(playlist.tracks) || playlist.tracks.length === 0) return;
    const saved = createCustomPlaylist(playlist.title, playlist.tracks);
    if (saved) {
      setForYouSavedMap(prev => ({ ...prev, [playlist.id]: true }));
    }
  }

  const exposed = {
    isIgnoredTasteTerm,
    getLikedCategories,
    loadRecommendedOrRandomFeed,
    searchTracks,
    autoPlaylistsData,
    handleRefreshForYou,
    handlePlayAutoPlaylist,
    handleSelectForYouTrack,
    handleSaveAutoPlaylist
  };

  if (apiRef) {
    Object.assign(apiRef.current, exposed);
  }

  return exposed;
}
