'use client';

import { useState, useEffect, useRef } from 'react';

const AUDIO_CACHE_NAME = 'my-music-offline-audio-v1';
const SHELL_CACHE_NAME = 'mymusic-shell-v3';
const USER_STORAGE_KEY = 'mma_cached_user_v1';
const LIKES_STORAGE_KEY = 'mma_liked_tracks_v1';
const OFFLINE_CATALOG_KEY = 'mma_offline_catalog_v1';
const PLAYLISTS_STORAGE_KEY = 'mma_custom_playlists_v1';

const DISCOVERY_SEEDS = [
  { term: 'Pop Latino Hits', label: 'Pop Latino' },
  { term: 'Rock Clásico Español', label: 'Rock en Español' },
  { term: 'Daft Punk Electronic Synth', label: 'Electrónica & Synth' },
  { term: 'Indie Alternative Hits', label: 'Indie & Alternativo' },
  { term: 'Reggaeton Urbano Latino', label: 'Urbano & Reggaetón' },
  { term: 'The Weeknd R&B Soul', label: 'R&B & Soul' },
  { term: 'Lo-Fi Chill Jazz Beats', label: 'Lo-Fi & Jazz' },
  { term: 'Hip-Hop Rap Classics', label: 'Hip-Hop & Rap' }
];

export default function HomePage() {
  // Auth state
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // Navigation: 'explore' | 'library' | 'files' | 'settings' | 'admin'
  const [activeTab, setActiveTab] = useState('explore');

  // Sub-library selector inside 'library': 'liked' | 'offline' | <customPlaylistId>
  const [selectedLibrary, setSelectedLibrary] = useState('liked');

  // Explore, Recommendations & Search
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [feedInfo, setFeedInfo] = useState({ mode: 'random', label: 'Descubrimiento aleatorio' });

  // Libraries & Offline Cache (strictly separated!)
  const [likedTracks, setLikedTracks] = useState([]); // ONLY tracks with heart ♥
  const [offlineCatalog, setOfflineCatalog] = useState([]); // Metadata for tracks stored in device CacheStorage
  const [customPlaylists, setCustomPlaylists] = useState([]); // [{ id, name, createdAt, tracks: [] }]
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);

  // Save-to-Library Modal Dialog state
  const [trackToSave, setTrackToSave] = useState(null);
  const [modalNewPlaylistName, setModalNewPlaylistName] = useState('');
  const saveDialogRef = useRef(null);

  // Downloads & Server Files
  const [downloads, setDownloads] = useState({});
  const [libraryFiles, setLibraryFiles] = useState([]);
  const [offlineUrls, setOfflineUrls] = useState({});
  const [deviceQuota, setDeviceQuota] = useState(null);
  const [syncingAll, setSyncingAll] = useState(false);

  // Settings: Spotify Importer state
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [spotifyMsg, setSpotifyMsg] = useState({ type: '', text: '' });
  const [spotifyTargetLib, setSpotifyTargetLib] = useState('ask'); // 'ask' | 'liked' | 'new_playlist' | <playlistId>
  const [pendingSpotifyImport, setPendingSpotifyImport] = useState(null); // { tracks: [], sourceName: '' }
  const [spotifyNewLibName, setSpotifyNewLibName] = useState('');
  const spotifyDialogRef = useRef(null);

  // Admin Panel state
  const [adminData, setAdminData] = useState({ users: [], invites: [], storage: null });
  const [inviteLabel, setInviteLabel] = useState('');
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [adminMsg, setAdminMsg] = useState('');
  const [copiedCode, setCopiedCode] = useState('');

  // PWA Install Prompt
  const [deferredPrompt, setDeferredPrompt] = useState(null);

  // Audio Player State
  const [queue, setQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState('off'); // 'off' | 'all' | 'one'
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef(null);
  const savedDeviceIdsRef = useRef(new Set());
  const accountRef = useRef(null);

  const currentTrack = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

  // Warm PWA App Shell cache so reopening the app after closing it works 100% offline
  async function warmAppShellCache() {
    if (typeof window === 'undefined' || !('caches' in window)) return;
    try {
      const cache = await caches.open(SHELL_CACHE_NAME);
      const urlsToWarm = new Set(['/', '/manifest.json', '/icon.svg']);
      document
        .querySelectorAll('script[src], link[rel="stylesheet"][href]')
        .forEach(el => {
          const rawUrl = el.src || el.href;
          if (rawUrl && rawUrl.startsWith(window.location.origin)) {
            urlsToWarm.add(rawUrl);
          }
        });
      for (const u of urlsToWarm) {
        try {
          const existing = await cache.match(u);
          if (!existing) {
            const resp = await fetch(u, { cache: 'force-cache' });
            if (resp && resp.ok) await cache.put(u, resp);
          }
        } catch {}
      }
    } catch {}
  }

  // Fallback for browsers without native <dialog closedby="any"> support (e.g. iOS Safari)
  useEffect(() => {
    if (typeof HTMLDialogElement === 'undefined' || 'closedBy' in HTMLDialogElement.prototype) return;
    const dialogs = [saveDialogRef.current, spotifyDialogRef.current].filter(Boolean);
    const handlers = dialogs.map(dialog => {
      const fn = event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (isDialogContent) return;
        dialog.close();
      };
      dialog.addEventListener('click', fn);
      return { dialog, fn };
    });
    return () => {
      handlers.forEach(({ dialog, fn }) => dialog.removeEventListener('click', fn));
    };
  }, [user]);

  // Check session & hydrate local collections on mount
  useEffect(() => {
    let cachedUser = null;
    try {
      const rawUser = localStorage.getItem(USER_STORAGE_KEY);
      if (rawUser) {
        cachedUser = JSON.parse(rawUser);
        setUser(cachedUser);
        setAuthChecked(true);
      }
    } catch {}

    try {
      const savedLikes = localStorage.getItem(LIKES_STORAGE_KEY);
      if (savedLikes) {
        // Filter out old auto-injected 'offline_' entries so Favoritos only has hearted tracks
        const parsed = JSON.parse(savedLikes).filter(
          t => !String(t.id).startsWith('offline_')
        );
        setLikedTracks(parsed);
      }
    } catch {}

    try {
      const savedOffline = localStorage.getItem(OFFLINE_CATALOG_KEY);
      if (savedOffline) setOfflineCatalog(JSON.parse(savedOffline));
    } catch {}

    try {
      const savedPlaylists = localStorage.getItem(PLAYLISTS_STORAGE_KEY);
      if (savedPlaylists) setCustomPlaylists(JSON.parse(savedPlaylists));
    } catch {}

    const offlineNow = typeof navigator !== 'undefined' && !navigator.onLine;
    setIsOffline(offlineNow);
    if (offlineNow) {
      setActiveTab('library');
      setSelectedLibrary('offline');
      if (!cachedUser) {
        setUser({ username: 'Modo Offline', is_admin: false, offline: true });
      }
      setAuthChecked(true);
    }

    fetch('/api/auth')
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.user) {
          setUser(data.user);
          try {
            localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
          } catch {}
        } else if (r.status === 401 || (r.ok && !data.user)) {
          setUser(null);
          try {
            localStorage.removeItem(USER_STORAGE_KEY);
          } catch {}
        }
      })
      .catch(() => {
        setIsOffline(true);
        setActiveTab('library');
        setSelectedLibrary('offline');
        setUser(prev => prev || cachedUser || { username: 'Modo Offline', is_admin: false, offline: true });
      })
      .finally(() => setAuthChecked(true));

    refreshOfflineCacheList();
    warmAppShellCache();

    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => {
      setIsOffline(true);
      setActiveTab('library');
      setSelectedLibrary('offline');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const handleBeforeInstall = e => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    };
  }, []);

  // Load initial catalog & server files once logged in
  useEffect(() => {
    if (!user) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setActiveTab('library');
      setSelectedLibrary('offline');
      return;
    }
    fetchLibraryFiles();
    let initialLikes = likedTracks;
    try {
      const raw = localStorage.getItem(LIKES_STORAGE_KEY);
      if (raw) initialLikes = JSON.parse(raw);
    } catch {}
    loadRecommendedOrRandomFeed(initialLikes, false);
    if (user.is_admin) {
      fetchAdminData();
    }
  }, [user]);

  // Close account dropdown on outside click
  useEffect(() => {
    function onDocClick(e) {
      if (accountRef.current && !accountRef.current.contains(e.target)) {
        setAccountOpen(false);
      }
    }
    if (accountOpen) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [accountOpen]);

  // Poll active downloads: when ready, save to Offline Cache & Offline Catalog ONLY (never force a heart!)
  useEffect(() => {
    const activeIds = Object.values(downloads)
      .filter(d => d.status === 'downloading')
      .map(d => d.downloadId);

    if (activeIds.length === 0) return;

    const timer = setInterval(async () => {
      for (const id of activeIds) {
        try {
          const res = await fetch(`/api/download?id=${id}`);
          if (!res.ok) continue;
          const data = await res.json();

          setDownloads(prev => {
            const key = Object.keys(prev).find(k => prev[k].downloadId === id);
            if (!key) return prev;
            return { ...prev, [key]: { ...prev[key], ...data } };
          });

          if (data.status === 'ready' && data.filename) {
            const streamUrl = `/api/stream?file=${encodeURIComponent(data.filename)}`;
            const trackKey = Object.keys(downloads).find(k => downloads[k].downloadId === id);
            const metaTrack =
              results.find(t => String(t.id) === String(trackKey)) ||
              likedTracks.find(t => String(t.id) === String(trackKey)) ||
              customPlaylists.flatMap(p => p.tracks).find(t => String(t.id) === String(trackKey)) ||
              downloads[trackKey]?.trackMeta ||
              null;

            await saveUrlToOfflineCache(streamUrl, {
              ...(metaTrack || {}),
              id: metaTrack?.id || `offline_${data.filename}`,
              title: metaTrack?.title || data.title || data.filename.replace(/\.mp3$/i, ''),
              artist: metaTrack?.artist || data.artist || 'Audio MP3',
              artwork: metaTrack?.artwork || '/icon.svg',
              filename: data.filename,
              streamUrl
            });

            setResults(prev =>
              prev.map(t =>
                String(t.id) === String(trackKey)
                  ? { ...t, filename: data.filename, streamUrl }
                  : t
              )
            );

            // Update file reference if this track already exists in Favoritos or a custom playlist
            updateTrackFileAcrossLibraries(trackKey, data.filename, streamUrl);

            fetchLibraryFiles();
            if (user?.is_admin) fetchAdminData();
          }
        } catch {}
      }
    }, 1400);

    return () => clearInterval(timer);
  }, [downloads, likedTracks, customPlaylists, results, user]);

  // Manage audio playback when currentTrack changes
  useEffect(() => {
    if (!currentTrack || !audioRef.current) return;
    const playTrack = async () => {
      const src = await resolvePlayableSource(currentTrack);
      if (!src) return;
      audioRef.current.src = src;
      try {
        await audioRef.current.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
    };
    playTrack();
  }, [currentIndex, queue]);

  // Auth handlers
  async function handleAuthSubmit(e) {
    e.preventDefault();
    setAuthError('');
    setAuthBusy(true);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: authMode,
          username,
          password,
          inviteCode: authMode === 'register' ? inviteCode : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Error de autenticación');
      } else {
        setUser(data.user);
        try {
          localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
        } catch {}
        setPassword('');
        setInviteCode('');
      }
    } catch {
      setAuthError('Error de red al conectar con el servidor.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout' })
      });
    } catch {}
    try {
      localStorage.removeItem(USER_STORAGE_KEY);
    } catch {}
    if (audioRef.current) audioRef.current.pause();
    setUser(null);
    setAccountOpen(false);
    setActiveTab('explore');
  }

  // Admin handlers
  async function fetchAdminData() {
    try {
      const res = await fetch('/api/admin');
      if (!res.ok) return;
      const data = await res.json();
      setAdminData(data);
    } catch {}
  }

  async function handleCreateInvite(e) {
    e.preventDefault();
    setAdminMsg('');
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create_invite',
        label: inviteLabel || 'Invitado',
        max_uses: Number(inviteMaxUses) || 1
      })
    });
    const data = await res.json();
    if (res.ok && data.invite) {
      setInviteLabel('');
      setInviteMaxUses(1);
      setAdminMsg(`Código ${data.invite.code} generado.`);
      fetchAdminData();
    }
  }

  async function handleAdminAction(payload) {
    await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    fetchAdminData();
  }

  function copyInviteCode(code) {
    navigator.clipboard?.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(''), 2000);
  }

  // ==================== LIBRARIES & OFFLINE PERSISTENCE ====================
  function persistLikes(nextLikes) {
    setLikedTracks(nextLikes);
    try {
      localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(nextLikes));
    } catch {}
  }

  function persistOfflineCatalog(nextOffline) {
    setOfflineCatalog(nextOffline);
    try {
      localStorage.setItem(OFFLINE_CATALOG_KEY, JSON.stringify(nextOffline));
    } catch {}
  }

  function persistCustomPlaylists(nextPlaylists) {
    setCustomPlaylists(nextPlaylists);
    try {
      localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(nextPlaylists));
    } catch {}
  }

  function isLiked(trackId) {
    return likedTracks.some(t => String(t.id) === String(trackId));
  }

  function isTrackInPlaylist(playlistId, trackId) {
    const pl = customPlaylists.find(p => p.id === playlistId);
    if (!pl) return false;
    return pl.tracks.some(t => String(t.id) === String(trackId));
  }

  function toggleLike(track) {
    if (isLiked(track.id)) {
      persistLikes(likedTracks.filter(t => String(t.id) !== String(track.id)));
    } else {
      const existingDl = downloads[track.id];
      const offMatch = offlineCatalog.find(t => String(t.id) === String(track.id));
      const filename = existingDl?.filename || offMatch?.filename || track.filename || null;
      const entry = {
        ...track,
        addedAt: Date.now(),
        filename,
        streamUrl: filename
          ? `/api/stream?file=${encodeURIComponent(filename)}`
          : track.streamUrl || null
      };
      persistLikes([entry, ...likedTracks]);
    }
  }

  function createCustomPlaylist(name, initialTracks = []) {
    const clean = (name || '').trim();
    if (!clean) return null;
    const newPl = {
      id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: clean,
      createdAt: Date.now(),
      tracks: initialTracks
    };
    const next = [...customPlaylists, newPl];
    persistCustomPlaylists(next);
    return newPl;
  }

  function deleteCustomPlaylist(playlistId) {
    const next = customPlaylists.filter(p => p.id !== playlistId);
    persistCustomPlaylists(next);
    if (selectedLibrary === playlistId) {
      setSelectedLibrary('liked');
    }
  }

  function toggleTrackInPlaylist(playlistId, track) {
    const existingDl = downloads[track.id];
    const offMatch = offlineCatalog.find(t => String(t.id) === String(track.id));
    const filename = existingDl?.filename || offMatch?.filename || track.filename || null;
    const preparedTrack = {
      ...track,
      addedAt: Date.now(),
      filename,
      streamUrl: filename
        ? `/api/stream?file=${encodeURIComponent(filename)}`
        : track.streamUrl || null
    };

    const next = customPlaylists.map(pl => {
      if (pl.id !== playlistId) return pl;
      const exists = pl.tracks.some(t => String(t.id) === String(track.id));
      return {
        ...pl,
        tracks: exists
          ? pl.tracks.filter(t => String(t.id) !== String(track.id))
          : [preparedTrack, ...pl.tracks]
      };
    });
    persistCustomPlaylists(next);
  }

  function removeTrackFromPlaylist(playlistId, trackId) {
    const next = customPlaylists.map(pl =>
      pl.id === playlistId
        ? { ...pl, tracks: pl.tracks.filter(t => String(t.id) !== String(trackId)) }
        : pl
    );
    persistCustomPlaylists(next);
  }

  function openSaveModal(track) {
    setTrackToSave(track);
    setModalNewPlaylistName('');
    if (saveDialogRef.current && typeof saveDialogRef.current.showModal === 'function') {
      saveDialogRef.current.showModal();
    }
  }

  function closeSaveModal() {
    if (saveDialogRef.current && saveDialogRef.current.open) {
      saveDialogRef.current.close();
    }
    setTrackToSave(null);
  }

  function updateTrackFileAcrossLibraries(trackId, filename, streamUrl) {
    setLikedTracks(prev => {
      if (!prev.some(t => String(t.id) === String(trackId))) return prev;
      const updated = prev.map(t =>
        String(t.id) === String(trackId) ? { ...t, filename, streamUrl } : t
      );
      try {
        localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(updated));
      } catch {}
      return updated;
    });

    setCustomPlaylists(prev => {
      let changed = false;
      const updated = prev.map(pl => {
        if (!pl.tracks.some(t => String(t.id) === String(trackId))) return pl;
        changed = true;
        return {
          ...pl,
          tracks: pl.tracks.map(t =>
            String(t.id) === String(trackId) ? { ...t, filename, streamUrl } : t
          )
        };
      });
      if (changed) {
        try {
          localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(updated));
        } catch {}
        return updated;
      }
      return prev;
    });
  }

  async function refreshOfflineCacheList() {
    if (typeof window === 'undefined') return;
    if ('caches' in window) {
      try {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        const keys = await cache.keys();
        const map = {};
        const cachedFilenames = [];
        for (const req of keys) {
          const url = new URL(req.url);
          const rel = url.pathname + url.search;
          map[rel] = true;
          const fileParam = url.searchParams.get('file');
          if (fileParam) {
            cachedFilenames.push({ filename: fileParam, streamUrl: rel });
          }
        }
        setOfflineUrls(map);

        // Keep offlineCatalog synced with actual CacheStorage files (NEVER mutating likedTracks!)
        setOfflineCatalog(prev => {
          const validSet = new Set(cachedFilenames.map(c => c.streamUrl));
          const filtered = prev.filter(item => item.streamUrl && validSet.has(item.streamUrl));
          let changed = filtered.length !== prev.length;
          const next = [...filtered];

          for (const item of cachedFilenames) {
            const exists = next.some(
              t => t.filename === item.filename || t.streamUrl === item.streamUrl
            );
            if (!exists) {
              const cleanTitle = item.filename
                .replace(/_\d+\.mp3$/i, '')
                .replace(/\.mp3$/i, '')
                .replace(/_/g, ' ');
              next.unshift({
                id: `offline_${item.filename}`,
                title: cleanTitle,
                artist: 'Guardado en dispositivo',
                album: 'Offline PWA',
                genre: 'Offline',
                artwork: '/icon.svg',
                filename: item.filename,
                streamUrl: item.streamUrl,
                addedAt: Date.now()
              });
              changed = true;
            }
          }

          if (changed) {
            try {
              localStorage.setItem(OFFLINE_CATALOG_KEY, JSON.stringify(next));
            } catch {}
            return next;
          }
          return prev;
        });
      } catch {}
    }
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (est && est.quota) {
          setDeviceQuota({
            usedMB: ((est.usage || 0) / (1024 * 1024)).toFixed(1),
            quotaGB: (est.quota / (1024 * 1024 * 1024)).toFixed(1)
          });
        }
      } catch {}
    }
  }

  async function saveUrlToOfflineCache(url, trackMeta = null) {
    if (typeof window === 'undefined' || !('caches' in window)) return false;
    try {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      const response = await fetch(url);
      if (response.ok) {
        await cache.put(url, response.clone());
        if (trackMeta) {
          setOfflineCatalog(prev => {
            const filtered = prev.filter(
              t => t.streamUrl !== url && String(t.id) !== String(trackMeta.id)
            );
            const next = [{ ...trackMeta, streamUrl: url, addedAt: Date.now() }, ...filtered];
            try {
              localStorage.setItem(OFFLINE_CATALOG_KEY, JSON.stringify(next));
            } catch {}
            return next;
          });
        }
        await refreshOfflineCacheList();

        // Once cached on the client device, immediately delete the transient MP3 from the server
        const fileToDelete =
          trackMeta?.filename ||
          new URL(url, window.location.origin).searchParams.get('file');
        if (fileToDelete) {
          fetch(`/api/library?file=${encodeURIComponent(fileToDelete)}`, {
            method: 'DELETE'
          })
            .then(() => fetchLibraryFiles())
            .catch(() => {});
        }
        return true;
      }
    } catch {}
    return false;
  }

  // Export MP3 file to device (reads from local CacheStorage blob first so it works even after server deleted the file)
  async function exportTrackFile(filename, streamUrl) {
    if (typeof window === 'undefined') return;
    const url = streamUrl || `/api/stream?file=${encodeURIComponent(filename)}`;
    if ('caches' in window) {
      try {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        const fullUrl = new URL(url, window.location.origin).href;
        const cachedResp = (await cache.match(url)) || (await cache.match(fullUrl));
        if (cachedResp) {
          const blob = await cachedResp.blob();
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename || 'track.mp3';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          }, 1500);
          return;
        }
      } catch {}
    }
    const a = document.createElement('a');
    a.href = `${url}&download=1`;
    a.download = filename || 'track.mp3';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 1000);
  }

  // Delete a track from device offline CacheStorage
  async function deleteOfflineTrack(track) {
    if (typeof window === 'undefined' || !('caches' in window)) return;
    const filename = track.filename || downloads[track.id]?.filename;
    const streamUrl =
      track.streamUrl ||
      (filename ? `/api/stream?file=${encodeURIComponent(filename)}` : null);

    try {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      if (streamUrl) {
        await cache.delete(streamUrl);
        const fullUrl = new URL(streamUrl, window.location.origin).href;
        await cache.delete(fullUrl);
      }
    } catch {}

    const nextOffline = offlineCatalog.filter(
      t =>
        String(t.id) !== String(track.id) &&
        (!streamUrl || t.streamUrl !== streamUrl) &&
        (!filename || t.filename !== filename)
    );
    persistOfflineCatalog(nextOffline);
    await refreshOfflineCacheList();
  }

  // Delete an MP3 file from the VPS server
  async function deleteServerFile(filename) {
    try {
      const res = await fetch(`/api/library?file=${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setLibraryFiles(prev => prev.filter(f => f.filename !== filename));
        if (user?.is_admin) fetchAdminData();
      }
    } catch {}
  }

  async function resolvePlayableSource(track) {
    const dl = downloads[track.id];
    const offItem = offlineCatalog.find(
      t =>
        String(t.id) === String(track.id) ||
        (track.filename && t.filename === track.filename)
    );
    const likedItem = likedTracks.find(t => String(t.id) === String(track.id));
    const filename = track.filename || dl?.filename || offItem?.filename || likedItem?.filename;
    const streamUrl =
      track.streamUrl ||
      offItem?.streamUrl ||
      likedItem?.streamUrl ||
      (filename ? `/api/stream?file=${encodeURIComponent(filename)}` : null);

    if (streamUrl && 'caches' in window) {
      try {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        const fullUrl = new URL(streamUrl, window.location.origin).href;
        const cachedResp = (await cache.match(streamUrl)) || (await cache.match(fullUrl));
        if (cachedResp) {
          const blob = await cachedResp.blob();
          return URL.createObjectURL(blob);
        }
      } catch {}
    }

    if (streamUrl) return streamUrl;
    return track.previewUrl || null;
  }

  function getLikedCategories(tracksList = likedTracks) {
    const counts = {};
    for (const t of tracksList) {
      const cat = t.genre && t.genre !== 'Música' ? t.genre : t.artist;
      if (cat) {
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }

  function loadRecommendedOrRandomFeed(tracksList = likedTracks, forceRandom = false) {
    const categories = getLikedCategories(tracksList);
    if (!forceRandom && categories.length > 0) {
      const topPool = categories.slice(0, 4);
      const chosenCategory = topPool[Math.floor(Math.random() * topPool.length)];
      searchTracks(chosenCategory, {
        mode: 'recommended',
        label: chosenCategory
      });
    } else {
      const randomSeed = DISCOVERY_SEEDS[Math.floor(Math.random() * DISCOVERY_SEEDS.length)];
      searchTracks(randomSeed.term, {
        mode: 'random',
        label: randomSeed.label
      });
    }
  }

  async function searchTracks(searchTerm, meta = null) {
    if (!searchTerm.trim()) return;
    setLoading(true);
    if (meta) {
      setFeedInfo(meta);
    } else {
      setFeedInfo({ mode: 'search', label: searchTerm.trim() });
    }
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchTerm)}`);
      const data = await res.json();
      setResults(data.results || data.tracks || []);
    } catch {}
    setLoading(false);
  }

  async function fetchLibraryFiles() {
    try {
      const res = await fetch('/api/library');
      if (!res.ok) return;
      const data = await res.json();
      setLibraryFiles(data.files || []);
    } catch {}
  }

  async function startDownload(track) {
    const key = track.id || track.title;
    if (downloads[key]?.status === 'downloading') return;

    setDownloads(prev => ({
      ...prev,
      [key]: { status: 'downloading', progress: 0, trackMeta: track }
    }));

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: track.title,
          artist: track.artist,
          artwork: track.artwork,
          previewUrl: track.previewUrl || null,
          query: `${track.title} ${track.artist || ''}`.trim()
        })
      });
      const data = await res.json();
      if (data.downloadId) {
        setDownloads(prev => ({
          ...prev,
          [key]: {
            status: 'downloading',
            progress: 8,
            downloadId: data.downloadId,
            trackMeta: track
          }
        }));
      } else {
        setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
      }
    } catch {
      setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
    }
  }

  async function downloadCollectionForOffline(tracksList) {
    if (syncingAll || !tracksList || tracksList.length === 0) return;
    setSyncingAll(true);
    for (const track of tracksList) {
      const streamUrl =
        track.streamUrl ||
        (track.filename ? `/api/stream?file=${encodeURIComponent(track.filename)}` : null);
      if (streamUrl && offlineUrls[streamUrl]) continue;
      if (streamUrl) {
        await saveUrlToOfflineCache(streamUrl, track);
      } else {
        await startDownload(track);
      }
    }
    setSyncingAll(false);
  }

  // Open modal asking which library to save Spotify tracks into (Me gusta / existing / new)
  function openSpotifyImportModal(tracks, sourceName = 'Playlist Spotify') {
    if (!tracks || tracks.length === 0) return;
    setPendingSpotifyImport({ tracks, sourceName });
    setSpotifyNewLibName(sourceName);
    if (spotifyDialogRef.current && typeof spotifyDialogRef.current.showModal === 'function') {
      spotifyDialogRef.current.showModal();
    }
  }

  function closeSpotifyImportModal() {
    if (spotifyDialogRef.current && spotifyDialogRef.current.open) {
      spotifyDialogRef.current.close();
    }
    setPendingSpotifyImport(null);
  }

  function confirmSpotifyImport(targetType, customName = '') {
    if (!pendingSpotifyImport) return;
    const freshTracks = pendingSpotifyImport.tracks || [];
    const fallbackName = (customName || pendingSpotifyImport.sourceName || 'Spotify Import').trim();

    if (targetType === 'liked') {
      const existingKeys = new Set(
        likedTracks.map(t => `${t.title?.toLowerCase()}|${t.artist?.toLowerCase()}`)
      );
      const filtered = freshTracks.filter(
        t => !existingKeys.has(`${t.title?.toLowerCase()}|${t.artist?.toLowerCase()}`)
      );
      persistLikes([...filtered, ...likedTracks]);
      setSelectedLibrary('liked');
      setSpotifyMsg({
        type: 'ok',
        text: `✓ Se guardaron ${filtered.length} canciones en «♥ Favoritos (Me gusta)».`
      });
      closeSpotifyImportModal();
      return;
    }

    if (targetType === 'new_playlist') {
      const created = createCustomPlaylist(fallbackName, freshTracks);
      if (created) {
        setSelectedLibrary(created.id);
        setSpotifyMsg({
          type: 'ok',
          text: `✓ Se creó la librería «${created.name}» con ${freshTracks.length} canciones.`
        });
      }
      closeSpotifyImportModal();
      return;
    }

    const targetPl = customPlaylists.find(p => p.id === targetType);
    if (targetPl) {
      const existingKeys = new Set(
        targetPl.tracks.map(t => `${t.title?.toLowerCase()}|${t.artist?.toLowerCase()}`)
      );
      const filtered = freshTracks.filter(
        t => !existingKeys.has(`${t.title?.toLowerCase()}|${t.artist?.toLowerCase()}`)
      );
      const next = customPlaylists.map(p =>
        p.id === targetPl.id ? { ...p, tracks: [...filtered, ...p.tracks] } : p
      );
      persistCustomPlaylists(next);
      setSelectedLibrary(targetPl.id);
      setSpotifyMsg({
        type: 'ok',
        text: `✓ Se guardaron ${filtered.length} canciones en «${targetPl.name}».`
      });
      closeSpotifyImportModal();
    }
  }

  // Player controls
  function playFromList(list, index) {
    setQueue(list);
    setCurrentIndex(index);
  }

  function togglePlayPause() {
    if (!audioRef.current || !currentTrack) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  }

  function playNext() {
    if (queue.length === 0) return;
    if (shuffle && queue.length > 1) {
      let nextIdx = currentIndex;
      while (nextIdx === currentIndex) {
        nextIdx = Math.floor(Math.random() * queue.length);
      }
      setCurrentIndex(nextIdx);
      return;
    }
    if (currentIndex < queue.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else if (repeatMode === 'all') {
      setCurrentIndex(0);
    } else {
      setIsPlaying(false);
    }
  }

  function playPrev() {
    if (queue.length === 0) return;
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    } else if (repeatMode === 'all') {
      setCurrentIndex(queue.length - 1);
    }
  }

  function handleTrackEnded() {
    if (repeatMode === 'one' && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      return;
    }
    playNext();
  }

  function cycleRepeatMode() {
    setRepeatMode(prev => (prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off'));
  }

  function formatSec(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function handleInstallPwa() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  }

  if (!authChecked) {
    return (
      <main className="shell">
        <div className="empty" style={{ marginTop: 48 }}>
          <div className="empty-title">Cargando estudio musical…</div>
          <div>Verificando sesión activa</div>
        </div>
      </main>
    );
  }

  // ==================== UNAUTHENTICATED VIEW (LOGIN + INVITE REGISTER) ====================
  if (!user) {
    return (
      <>
        <header className="site-header">
          <div className="brand">
            <img src="/icon.svg" alt="MyMusicAnywhere" className="brand-logo" />
            <div className="brand-text">
              <span className="brand-name">MyMusicAnywhere</span>
              <span className="brand-sub">Estudio privado &amp; PWA offline</span>
            </div>
          </div>
          <span className="badge cobalt">Solo con invitación</span>
        </header>

        <main className="shell">
          <div className="auth-wrap">
            <div className="page-head">
              <div>
                <h1 className="page-title">
                  {authMode === 'login' ? 'Entrar al estudio' : 'Activar invitación'}
                </h1>
                <p className="page-sub">
                  {authMode === 'login'
                    ? 'Accede a tu catálogo, descargas MP3 y fonoteca offline.'
                    : 'Regístrate usando un código de invitación generado por el administrador.'}
                </p>
              </div>
            </div>

            <div className="card">
              <div className="auth-tabs" role="tablist">
                <button
                  type="button"
                  className={authMode === 'login' ? 'active' : ''}
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError('');
                  }}
                >
                  Iniciar sesión
                </button>
                <button
                  type="button"
                  className={authMode === 'register' ? 'active' : ''}
                  onClick={() => {
                    setAuthMode('register');
                    setAuthError('');
                  }}
                >
                  Tengo código de invitación
                </button>
              </div>

              {authError && <div className="alert err">{authError}</div>}

              {authMode === 'login' ? (
                <form className="form" onSubmit={handleAuthSubmit}>
                  <div className="field">
                    <label htmlFor="signin-username">Usuario</label>
                    <input
                      id="signin-username"
                      name="username"
                      type="text"
                      autoComplete="username"
                      enterKeyHint="next"
                      required
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      placeholder="tu_usuario"
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="current-password">Contraseña</label>
                    <div className="input-row">
                      <input
                        id="current-password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        enterKeyHint="done"
                        required
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        className="btn secondary sm"
                        onClick={() => setShowPassword(v => !v)}
                      >
                        {showPassword ? 'Ocultar' : 'Mostrar'}
                      </button>
                    </div>
                  </div>

                  <button type="submit" className="btn" disabled={authBusy}>
                    {authBusy ? 'Verificando…' : 'Entrar a MyMusicAnywhere'}
                  </button>
                </form>
              ) : (
                <form className="form" onSubmit={handleAuthSubmit}>
                  <div className="field">
                    <label htmlFor="invite-code">Código de invitación</label>
                    <input
                      id="invite-code"
                      name="inviteCode"
                      type="text"
                      autoCapitalize="characters"
                      enterKeyHint="next"
                      required
                      value={inviteCode}
                      onChange={e => setInviteCode(e.target.value.toUpperCase())}
                      placeholder="MMA-XXXX-XXXX"
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="signup-username">Elige tu usuario</label>
                    <input
                      id="signup-username"
                      name="username"
                      type="text"
                      autoComplete="username"
                      enterKeyHint="next"
                      minLength={3}
                      maxLength={32}
                      required
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      placeholder="nuevo_usuario"
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="new-password">Crea una contraseña (mín. 6 caracteres)</label>
                    <div className="input-row">
                      <input
                        id="new-password"
                        name="new-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        enterKeyHint="done"
                        minLength={6}
                        required
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        className="btn secondary sm"
                        onClick={() => setShowPassword(v => !v)}
                      >
                        {showPassword ? 'Ocultar' : 'Mostrar'}
                      </button>
                    </div>
                  </div>

                  <button type="submit" className="btn" disabled={authBusy}>
                    {authBusy ? 'Activando cuenta…' : 'Crear cuenta e ingresar'}
                  </button>
                </form>
              )}

              {offlineCatalog.length > 0 && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ width: '100%' }}
                    onClick={() => {
                      setUser({ username: 'Modo Offline', is_admin: false, offline: true });
                      setActiveTab('library');
                      setSelectedLibrary('offline');
                    }}
                  >
                    🎧 Abrir mis canciones Offline ({offlineCatalog.length}) sin conexión
                  </button>
                </div>
              )}
            </div>
          </div>
        </main>
      </>
    );
  }

  // ==================== COMPUTE ACTIVE LIBRARY VIEW ====================
  const initial = (user.username || 'U').trim().charAt(0).toUpperCase();
  const activeCustomPlaylist = customPlaylists.find(p => p.id === selectedLibrary) || null;
  const activeLibraryTracks =
    selectedLibrary === 'liked'
      ? likedTracks
      : selectedLibrary === 'offline'
      ? offlineCatalog
      : activeCustomPlaylist
      ? activeCustomPlaylist.tracks
      : likedTracks;

  const activeLibraryTitle =
    selectedLibrary === 'liked'
      ? '♥ Favoritos (Con corazón)'
      : selectedLibrary === 'offline'
      ? '✓ Offline (Guardadas en este dispositivo)'
      : activeCustomPlaylist
      ? `📁 ${activeCustomPlaylist.name}`
      : '♥ Favoritos';

  return (
    <>
      <header className="site-header">
        <button type="button" className="brand" onClick={() => setActiveTab('explore')}>
          <img src="/icon.svg" alt="MyMusicAnywhere" className="brand-logo" />
          <div className="brand-text">
            <span className="brand-name">MyMusicAnywhere</span>
            <span className="brand-sub">Studio &amp; Offline Player</span>
          </div>
        </button>

        <nav className="site-nav" aria-label="Principal">
          <button
            type="button"
            className={activeTab === 'explore' ? 'active' : ''}
            onClick={() => setActiveTab('explore')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
            </svg>
            <span>Explorar</span>
          </button>

          <button
            type="button"
            className={activeTab === 'library' ? 'active' : ''}
            onClick={() => setActiveTab('library')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z" />
            </svg>
            <span>Librerías</span>
            {(likedTracks.length + offlineCatalog.length) > 0 && (
              <span className="nav-count">{likedTracks.length || offlineCatalog.length}</span>
            )}
          </button>

          <button
            type="button"
            className={activeTab === 'files' ? 'active' : ''}
            onClick={() => setActiveTab('files')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
            <span>Servidor</span>
            {libraryFiles.length > 0 && <span className="nav-count">{libraryFiles.length}</span>}
          </button>

          <button
            type="button"
            className={activeTab === 'settings' ? 'active' : ''}
            onClick={() => setActiveTab('settings')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.02 1.41 1.09H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Ajustes</span>
          </button>

          {user.is_admin && (
            <button
              type="button"
              className={activeTab === 'admin' ? 'active' : ''}
              onClick={() => {
                setActiveTab('admin');
                fetchAdminData();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4z" />
              </svg>
              <span>Admin</span>
            </button>
          )}
        </nav>

        <div className="account" ref={accountRef}>
          <button
            type="button"
            className="account-btn"
            onClick={() => setAccountOpen(o => !o)}
            aria-expanded={accountOpen}
          >
            <span className="account-avatar">{initial}</span>
            <span className="account-name">{user.username}</span>
          </button>

          {accountOpen && (
            <div className="account-menu" role="menu">
              <div className="account-meta">
                <span className="account-user">@{user.username}</span>
                <span className={`badge ${user.is_admin ? 'cobalt' : 'mint'}`}>
                  {user.is_admin ? 'Admin' : 'Miembro'}
                </span>
              </div>

              <button
                type="button"
                className="account-item"
                onClick={() => {
                  setActiveTab('settings');
                  setAccountOpen(false);
                }}
              >
                ⚙ Configuración e Importar Spotify
              </button>

              {user.is_admin && (
                <button
                  type="button"
                  className="account-item"
                  onClick={() => {
                    setActiveTab('admin');
                    setAccountOpen(false);
                    fetchAdminData();
                  }}
                >
                  🛡 Panel de invitaciones
                </button>
              )}

              {deferredPrompt && (
                <button type="button" className="account-item" onClick={handleInstallPwa}>
                  📲 Instalar app en dispositivo
                </button>
              )}

              <button type="button" className="account-item danger" onClick={handleLogout}>
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="shell">
        {isOffline && (
          <div className="storage-banner" style={{ marginBottom: 14 }}>
            <span>
              <strong>⚡ Modo sin conexión activo:</strong> Reproduciendo las canciones descargadas en el caché de tu dispositivo.
            </span>
            <span className="badge mint">Offline Ready</span>
          </div>
        )}

        {/* ==================== TAB 1: EXPLORAR ==================== */}
        {activeTab === 'explore' && (
          <section>
            <div className="page-head">
              <div>
                <h1 className="page-title">Catálogo musical</h1>
                <p className="page-sub">
                  Busca por canción, álbum o artista, elije en qué librería guardarla o descarga el MP3 completo.
                </p>
              </div>
              {deferredPrompt && (
                <button type="button" className="btn secondary sm" onClick={handleInstallPwa}>
                  + Instalar PWA
                </button>
              )}
            </div>

            <form
              className="search-bar"
              onSubmit={e => {
                e.preventDefault();
                searchTracks(query);
              }}
            >
              <input
                type="search"
                className="search-input"
                enterKeyHint="search"
                placeholder="Buscar canción, artista o álbum…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <button type="submit" className="btn" disabled={loading}>
                {loading ? 'Buscando…' : 'Buscar'}
              </button>
            </form>

            <div className="toolbar">
              <div className="toolbar-group">
                {feedInfo.mode === 'recommended' ? (
                  <span className="badge coral">
                    ♥ Recomendado por tu gusto: {feedInfo.label}
                  </span>
                ) : feedInfo.mode === 'random' ? (
                  <span className="badge cobalt">
                    🎲 Selección aleatoria: {feedInfo.label}
                  </span>
                ) : (
                  <span className="badge neutral">
                    🔎 Búsqueda: {feedInfo.label}
                  </span>
                )}

                {getLikedCategories().slice(0, 3).map(cat => (
                  <button
                    key={cat}
                    type="button"
                    className="btn secondary sm"
                    onClick={() => searchTracks(cat, { mode: 'recommended', label: cat })}
                  >
                    ♥ {cat}
                  </button>
                ))}
              </div>

              <div className="toolbar-group">
                {likedTracks.length > 0 && (
                  <button
                    type="button"
                    className="btn secondary sm"
                    onClick={() => loadRecommendedOrRandomFeed(likedTracks, false)}
                  >
                    ✨ Para mí
                  </button>
                )}
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={() => loadRecommendedOrRandomFeed(likedTracks, true)}
                >
                  🎲 Música aleatoria
                </button>
              </div>
            </div>

            <div className="grid">
              {results.map((track, idx) => {
                const dl = downloads[track.id];
                const liked = isLiked(track.id);
                const savedPlaylistCount = customPlaylists.filter(p =>
                  p.tracks.some(t => String(t.id) === String(track.id))
                ).length;
                const isCurrent = currentTrack?.id === track.id;

                return (
                  <article key={track.id} className={`card item ${isCurrent ? 'playing' : ''}`}>
                    <div className="item-head">
                      <div className="item-media">
                        <div
                          className="artwork-wrap"
                          onClick={() => playFromList(results, idx)}
                          title="Reproducir pista"
                        >
                          <img
                            src={track.artwork || '/icon.svg'}
                            alt={track.title}
                            loading="lazy"
                            onError={e => {
                              e.currentTarget.src = '/icon.svg';
                            }}
                          />
                          <div className="artwork-play-overlay">
                            {isCurrent && isPlaying ? '⏸' : '▶'}
                          </div>
                        </div>
                        <div className="item-info">
                          <div className="item-title">{track.title}</div>
                          <div className="item-sub">
                            {track.artist} {track.album ? `· ${track.album}` : ''}
                          </div>
                        </div>
                      </div>

                      <div className="item-actions">
                        <button
                          type="button"
                          className={`btn heart ${liked ? 'liked' : ''}`}
                          onClick={() => toggleLike(track)}
                          title={liked ? 'Quitar corazón' : 'Dar corazón (Favoritos)'}
                        >
                          {liked ? '♥' : '♡'}
                        </button>

                        <button
                          type="button"
                          className="btn secondary sm"
                          onClick={() => openSaveModal(track)}
                          title="Elegir en qué librería guardar"
                        >
                          📁 Guardar{savedPlaylistCount > 0 ? ` (${savedPlaylistCount})` : ''}
                        </button>

                        {dl?.status === 'downloading' ? (
                          <span className="badge amber">
                            Extrayendo {Math.round(dl.progress || 0)}%
                          </span>
                        ) : dl?.status === 'ready' ? (
                          <>
                            <span className="badge mint">✓ Offline</span>
                            <button
                              type="button"
                              onClick={() => exportTrackFile(dl.filename)}
                              className="btn secondary sm"
                              title="Exportar archivo MP3 al teléfono o PC"
                            >
                              💾 Archivo
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => startDownload(track)}
                          >
                            {dl?.status === 'error' ? '↻ Reintentar MP3' : '⬇ MP3'}
                          </button>
                        )}
                      </div>
                    </div>

                    {dl?.status === 'downloading' && (
                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{ width: `${dl.progress || 8}%` }}
                        />
                      </div>
                    )}

                    <dl className="meta">
                      <div>
                        <dt>Duración</dt>
                        <dd>{track.duration || '—'}</dd>
                      </div>
                      <div>
                        <dt>Género</dt>
                        <dd>{track.genre || 'Música'}</dd>
                      </div>
                      <div>
                        <dt>Estado</dt>
                        <dd>
                          {dl?.status === 'ready'
                            ? 'En librería Offline'
                            : liked
                            ? 'En ♥ Favoritos'
                            : savedPlaylistCount > 0
                            ? `En ${savedPlaylistCount} librería(s)`
                            : 'Streaming 30s'}
                        </dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* ==================== TAB 2: LIBRERÍAS (FAVORITOS / OFFLINE / PROPIAS) ==================== */}
        {activeTab === 'library' && (
          <section>
            <div className="page-head">
              <div>
                <h1 className="page-title">Mis librerías</h1>
                <p className="page-sub">
                  Tu colección separada entre ♥ Favoritos, ✓ Offline en el dispositivo y las librerías que vos crees.
                </p>
              </div>
              <button
                type="button"
                className="btn secondary sm"
                onClick={() => setCreatingPlaylist(v => !v)}
              >
                {creatingPlaylist ? 'Cancelar' : '+ Nueva librería'}
              </button>
            </div>

            {creatingPlaylist && (
              <form
                className="search-bar"
                style={{ marginBottom: 14 }}
                onSubmit={e => {
                  e.preventDefault();
                  const created = createCustomPlaylist(newPlaylistName);
                  if (created) {
                    setNewPlaylistName('');
                    setCreatingPlaylist(false);
                    setSelectedLibrary(created.id);
                  }
                }}
              >
                <input
                  type="text"
                  className="search-input"
                  placeholder="Nombre de tu nueva librería (ej. Gym, Viaje, Rock)…"
                  value={newPlaylistName}
                  onChange={e => setNewPlaylistName(e.target.value)}
                  required
                />
                <button type="submit" className="btn sm">
                  Crear librería
                </button>
              </form>
            )}

            {/* Switcher between ♥ Favoritos, ✓ Offline, and Custom Libraries */}
            <div className="library-switcher" role="tablist" aria-label="Selector de librería">
              <button
                type="button"
                className={`library-pill ${selectedLibrary === 'liked' ? 'active' : ''}`}
                onClick={() => setSelectedLibrary('liked')}
              >
                <span>♥ Favoritos</span>
                <span className="library-pill-count">{likedTracks.length}</span>
              </button>

              <button
                type="button"
                className={`library-pill ${selectedLibrary === 'offline' ? 'active' : ''}`}
                onClick={() => setSelectedLibrary('offline')}
              >
                <span>✓ Offline</span>
                <span className="library-pill-count">{offlineCatalog.length}</span>
              </button>

              {customPlaylists.map(pl => (
                <button
                  key={pl.id}
                  type="button"
                  className={`library-pill ${selectedLibrary === pl.id ? 'active' : ''}`}
                  onClick={() => setSelectedLibrary(pl.id)}
                >
                  <span>📁 {pl.name}</span>
                  <span className="library-pill-count">{pl.tracks.length}</span>
                </button>
              ))}
            </div>

            <div className="storage-banner">
              <span>
                <strong> Vista activa:</strong> {activeLibraryTitle} ·{' '}
                {deviceQuota
                  ? `${deviceQuota.usedMB} MB usados de ~${deviceQuota.quotaGB} GB en dispositivo`
                  : 'Caché offline del navegador activo'}
              </span>
              <span className="badge mint">{offlineCatalog.length} pistas offline</span>
            </div>

            <div className="toolbar">
              <div className="toolbar-group">
                <button
                  type="button"
                  className="btn sm"
                  disabled={activeLibraryTracks.length === 0}
                  onClick={() => playFromList(activeLibraryTracks, 0)}
                >
                  ▶ Reproducir librería
                </button>
                <button
                  type="button"
                  className={`btn secondary sm ${shuffle ? 'cobalt' : ''}`}
                  onClick={() => setShuffle(s => !s)}
                >
                  🔀 Aleatorio: {shuffle ? 'ON' : 'OFF'}
                </button>
                <button type="button" className="btn secondary sm" onClick={cycleRepeatMode}>
                  🔁 Bucle:{' '}
                  {repeatMode === 'off' ? 'No' : repeatMode === 'all' ? 'Todo' : '1 pista'}
                </button>
              </div>

              <div className="toolbar-group">
                {selectedLibrary !== 'offline' && (
                  <button
                    type="button"
                    className="btn secondary sm"
                    disabled={activeLibraryTracks.length === 0 || syncingAll}
                    onClick={() => downloadCollectionForOffline(activeLibraryTracks)}
                  >
                    {syncingAll ? 'Sincronizando…' : '⬇ Bajar toda esta librería a Offline'}
                  </button>
                )}

                {activeCustomPlaylist && (
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={() => deleteCustomPlaylist(activeCustomPlaylist.id)}
                  >
                    🗑 Eliminar librería
                  </button>
                )}
              </div>
            </div>

            {activeLibraryTracks.length === 0 ? (
              <div className="empty">
                <div className="empty-title">Esta librería está vacía</div>
                <p>
                  {selectedLibrary === 'liked'
                    ? 'Toca el corazón ♡ en cualquier canción de Explorar para guardarla en Favoritos.'
                    : selectedLibrary === 'offline'
                    ? 'Cuando descargues cualquier MP3 aparecerá automáticamente aquí para escuchar sin internet.'
                    : 'Usa el botón «📁 Guardar» en Explorar para agregar canciones a esta librería.'}
                </p>
              </div>
            ) : (
              <div className="grid">
                {activeLibraryTracks.map((track, idx) => {
                  const dl = downloads[track.id];
                  const offItem = offlineCatalog.find(
                    t =>
                      String(t.id) === String(track.id) ||
                      (track.filename && t.filename === track.filename)
                  );
                  const filename = track.filename || dl?.filename || offItem?.filename;
                  const streamUrl =
                    track.streamUrl ||
                    offItem?.streamUrl ||
                    (filename ? `/api/stream?file=${encodeURIComponent(filename)}` : null);
                  const isOfflineReady =
                    selectedLibrary === 'offline' || Boolean(streamUrl && offlineUrls[streamUrl]);
                  const isCurrent = currentTrack?.id === track.id;
                  const liked = isLiked(track.id);

                  return (
                    <article
                      key={`${selectedLibrary}_${track.id}`}
                      className={`card item ${isCurrent ? 'playing' : ''}`}
                    >
                      <div className="item-head">
                        <div className="item-media">
                          <div
                            className="artwork-wrap"
                            onClick={() => playFromList(activeLibraryTracks, idx)}
                          >
                            <img
                              src={track.artwork || '/icon.svg'}
                              alt={track.title}
                              loading="lazy"
                              onError={e => {
                                e.currentTarget.src = '/icon.svg';
                              }}
                            />
                            <div className="artwork-play-overlay">
                              {isCurrent && isPlaying ? '⏸' : '▶'}
                            </div>
                          </div>
                          <div className="item-info">
                            <div className="item-title">{track.title}</div>
                            <div className="item-sub">{track.artist}</div>
                          </div>
                        </div>

                        <div className="item-actions">
                          {isOfflineReady ? (
                            <span className="badge mint">✓ Offline</span>
                          ) : dl?.status === 'downloading' ? (
                            <span className="badge amber">
                              Extrayendo {Math.round(dl.progress || 0)}%
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => startDownload(track)}
                            >
                              {dl?.status === 'error' ? '↻ Reintentar MP3' : '⬇ Obtener MP3'}
                            </button>
                          )}

                          {filename && (
                            <button
                              type="button"
                              onClick={() => exportTrackFile(filename, streamUrl)}
                              className="btn secondary sm"
                              title="Exportar archivo MP3"
                            >
                              💾 Archivo
                            </button>
                          )}

                          <button
                            type="button"
                            className={`btn heart ${liked ? 'liked' : ''}`}
                            onClick={() => toggleLike(track)}
                            title={liked ? 'Quitar de ♥ Favoritos' : 'Agregar a ♥ Favoritos'}
                          >
                            {liked ? '♥' : '♡'}
                          </button>

                          <button
                            type="button"
                            className="btn secondary sm"
                            onClick={() => openSaveModal(track)}
                            title="Guardar en otra librería"
                          >
                            📁
                          </button>

                          {/* Delete / Remove action depending on current library */}
                          {selectedLibrary === 'offline' ? (
                            <button
                              type="button"
                              className="btn danger sm"
                              onClick={() => deleteOfflineTrack(track)}
                              title="Borrar MP3 del almacenamiento offline del dispositivo"
                            >
                              🗑 Borrar
                            </button>
                          ) : selectedLibrary === 'liked' ? (
                            <button
                              type="button"
                              className="btn danger sm"
                              onClick={() => toggleLike(track)}
                              title="Quitar canción de Favoritos"
                            >
                              🗑 Quitar
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn danger sm"
                              onClick={() =>
                                removeTrackFromPlaylist(selectedLibrary, track.id)
                              }
                              title="Quitar canción de esta librería"
                            >
                              🗑 Quitar
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* ==================== TAB 3: ARCHIVOS EN SERVIDOR ==================== */}
        {activeTab === 'files' && (
          <section>
            <div className="page-head">
              <div>
                <h1 className="page-title">Archivos MP3 en servidor</h1>
                <p className="page-sub">
                  Puente temporal de descargas: el servidor elimina el MP3 automáticamente apenas tu dispositivo termina de bajarlo.
                </p>
              </div>
              <button type="button" className="btn secondary sm" onClick={fetchLibraryFiles}>
                Actualizar lista
              </button>
            </div>

            {libraryFiles.length === 0 ? (
              <div className="empty">
                <div className="empty-title">Servidor limpio (0 archivos residuales)</div>
                <p>El servidor borra automáticamente cada MP3 en cuanto pasa a tu teléfono o PC.</p>
              </div>
            ) : (
              <div className="grid">
                {libraryFiles.map((file, idx) => {
                  const isCached = offlineUrls[file.url];
                  const cleanTitle = file.filename
                    .replace(/_\d+\.mp3$/i, '')
                    .replace(/\.mp3$/i, '')
                    .replace(/_/g, ' ');
                  const formattedList = libraryFiles.map(f => ({
                    id: f.filename,
                    title: f.filename.replace(/\.mp3$/i, ''),
                    artist: `${f.sizeMB} MB · Servidor`,
                    artwork: '/icon.svg',
                    filename: f.filename,
                    streamUrl: f.url
                  }));

                  return (
                    <article key={file.filename} className="card item">
                      <div className="item-head">
                        <div className="item-media">
                          <div
                            className="artwork-wrap"
                            onClick={() => playFromList(formattedList, idx)}
                          >
                            <img src="/icon.svg" alt="MP3" />
                            <div className="artwork-play-overlay">▶</div>
                          </div>
                          <div className="item-info">
                            <div className="item-title">{cleanTitle}</div>
                            <div className="item-sub">{file.sizeMB} MB · Audio MP3</div>
                          </div>
                        </div>

                        <div className="item-actions">
                          <button
                            type="button"
                            className="btn secondary sm"
                            onClick={() =>
                              saveUrlToOfflineCache(file.url, {
                                id: `offline_${file.filename}`,
                                title: cleanTitle,
                                artist: 'Guardado desde servidor',
                                artwork: '/icon.svg',
                                filename: file.filename,
                                streamUrl: file.url
                              })
                            }
                          >
                            {isCached ? '✓ En Offline' : '⚡ Guardar Offline'}
                          </button>
                          <a
                            href={`${file.url}&download=1`}
                            download={file.filename}
                            className="btn sm"
                          >
                            💾 Archivo
                          </a>
                          <button
                            type="button"
                            className="btn danger sm"
                            onClick={() => deleteServerFile(file.filename)}
                            title="Borrar archivo del servidor"
                          >
                            🗑 Borrar
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* ==================== TAB 4: CONFIGURACIÓN (SPOTIFY SYNC & CACHÉ) ==================== */}
        {activeTab === 'settings' && (
          <section>
            <div className="page-head">
              <div>
                <h1 className="page-title">Configuración y sincronización</h1>
                <p className="page-sub">
                  Importa playlists o álbumes desde Spotify, sube archivos CSV de Exportify y administra el almacenamiento de tu PWA.
                </p>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="item-head" style={{ marginBottom: 12 }}>
                <div>
                  <div className="item-title">Importar música desde Spotify</div>
                  <div className="item-sub">
                    Pega el enlace de una playlist/álbum de Spotify o sube tu CSV: al cargar te preguntará si querés guardarlo en ♥ Me gusta (Favoritos) o en otra librería.
                  </div>
                </div>
                <span className="badge mint">Spotify Sync</span>
              </div>

              {spotifyMsg.text && (
                <div className={`alert ${spotifyMsg.type === 'err' ? 'err' : 'ok'}`}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <span>{spotifyMsg.text}</span>
                    {spotifyMsg.type === 'ok' && (
                      <button
                        type="button"
                        className="btn secondary sm"
                        onClick={() => setActiveTab('library')}
                      >
                        Ir a Mis librerías →
                      </button>
                    )}
                  </div>
                </div>
              )}

              <form
                className="search-bar"
                style={{ marginBottom: 12 }}
                onSubmit={async e => {
                  e.preventDefault();
                  if (!spotifyUrl.trim() || spotifyBusy) return;
                  setSpotifyBusy(true);
                  setSpotifyMsg({ type: '', text: '' });
                  try {
                    const res = await fetch('/api/spotify', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ url: spotifyUrl.trim() })
                    });
                    const data = await res.json();
                    if (!res.ok) {
                      setSpotifyMsg({
                        type: 'err',
                        text: data.error || 'No se pudo importar desde Spotify.'
                      });
                    } else {
                      setSpotifyUrl('');
                      openSpotifyImportModal(
                        data.tracks || [],
                        data.playlistName || 'Playlist Spotify'
                      );
                    }
                  } catch {
                    setSpotifyMsg({ type: 'err', text: 'Error de red al importar playlist.' });
                  } finally {
                    setSpotifyBusy(false);
                  }
                }}
              >
                <input
                  type="url"
                  className="search-input"
                  placeholder="https://open.spotify.com/playlist/..."
                  value={spotifyUrl}
                  onChange={e => setSpotifyUrl(e.target.value)}
                  required
                />
                <button type="submit" className="btn sm" disabled={spotifyBusy}>
                  {spotifyBusy ? 'Leyendo…' : 'Importar link'}
                </button>
              </form>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                  fontSize: 12,
                  color: 'var(--muted)'
                }}
              >
                <span>
                  ¿Tus «Me gusta» privados? Exportalos en{' '}
                  <a href="https://exportify.net" target="_blank" rel="noreferrer">
                    exportify.net
                  </a>{' '}
                  y subí el archivo <code>.csv</code>:
                </span>
                <label className="btn secondary sm" style={{ cursor: 'pointer' }}>
                  📂 Subir CSV de Spotify
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    style={{ display: 'none' }}
                    onChange={async e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const text = await file.text();
                      const lines = text.split(/\r?\n/).filter(l => l.trim());
                      if (lines.length < 2) return;

                      const parseCsvRow = row => {
                        const cols = [];
                        let cur = '';
                        let inQuotes = false;
                        for (let i = 0; i < row.length; i++) {
                          const ch = row[i];
                          if (ch === '"') {
                            inQuotes = !inQuotes;
                          } else if (ch === ',' && !inQuotes) {
                            cols.push(cur.trim());
                            cur = '';
                          } else {
                            cur += ch;
                          }
                        }
                        cols.push(cur.trim());
                        return cols;
                      };

                      const headers = parseCsvRow(lines[0]).map(h => h.toLowerCase());
                      const titleIdx = headers.findIndex(
                        h => h.includes('track name') || h.includes('canción') || h === 'title'
                      );
                      const artistIdx = headers.findIndex(
                        h => h.includes('artist name') || h.includes('artista') || h === 'artist'
                      );
                      const albumIdx = headers.findIndex(h => h.includes('album'));
                      const genreIdx = headers.findIndex(h => h.includes('genre'));

                      if (titleIdx === -1) {
                        setSpotifyMsg({
                          type: 'err',
                          text: 'No se encontró la columna "Track Name" en el CSV.'
                        });
                        return;
                      }

                      const imported = [];
                      const seen = new Set();

                      for (let i = 1; i < lines.length; i++) {
                        const cols = parseCsvRow(lines[i]);
                        const title = cols[titleIdx];
                        const artist = artistIdx >= 0 ? cols[artistIdx] : '';
                        if (!title) continue;
                        const k = `${title.toLowerCase()}|${artist.toLowerCase()}`;
                        if (seen.has(k)) continue;
                        seen.add(k);
                        imported.push({
                          id: `csv_${Date.now()}_${i}`,
                          title,
                          artist: artist.replace(/;/g, ', '),
                          album: albumIdx >= 0 ? cols[albumIdx] : 'Spotify CSV',
                          genre:
                            genreIdx >= 0 && cols[genreIdx]
                              ? cols[genreIdx].split(',')[0]
                              : 'Spotify',
                          artwork: '/icon.svg',
                          previewUrl: null,
                          duration: '—'
                        });
                      }

                      const csvName = file.name.replace(/\.csv$/i, '') || 'Spotify CSV';
                      openSpotifyImportModal(imported, csvName);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="card">
              <div className="item-head">
                <div>
                  <div className="item-title">Almacenamiento Offline de este dispositivo</div>
                  <div className="item-sub">
                    {deviceQuota
                      ? `Usando ${deviceQuota.usedMB} MB de ~${deviceQuota.quotaGB} GB disponibles (${offlineCatalog.length} canciones en caché).`
                      : `${offlineCatalog.length} canciones guardadas en el caché offline de tu navegador.`}
                  </div>
                </div>
                {offlineCatalog.length > 0 && (
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={async () => {
                      if ('caches' in window) {
                        await caches.delete(AUDIO_CACHE_NAME);
                      }
                      persistOfflineCatalog([]);
                      await refreshOfflineCacheList();
                    }}
                  >
                    🗑 Vaciar todo el caché Offline
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ==================== TAB 5: ADMIN PANEL (SOLO ADMIN) ==================== */}
        {activeTab === 'admin' && user.is_admin && (
          <section>
            <div className="page-head">
              <div>
                <h1 className="page-title">Administración e invitaciones</h1>
                <p className="page-sub">
                  Genera códigos de invitación para nuevos usuarios y supervisa el espacio en disco del VPS.
                </p>
              </div>
            </div>

            <div className="grid three" style={{ marginBottom: 20 }}>
              <div className="stat">
                <div className="stat-label">Usuarios registrados</div>
                <div className="stat-value">{adminData.users.length}</div>
                <div className="stat-hint">
                  {adminData.users.filter(u => u.active).length} cuentas activas
                </div>
              </div>

              <div className="stat">
                <div className="stat-label">Códigos de invitación</div>
                <div className="stat-value">
                  {adminData.invites.filter(i => !i.revoked && i.used_count < i.max_uses).length}
                </div>
                <div className="stat-hint">Disponibles para usar</div>
              </div>

              <div className="stat">
                <div className="stat-label">Almacenamiento MP3</div>
                <div className="stat-value">
                  {adminData.storage
                    ? `${adminData.storage.usedMB} / ${adminData.storage.maxMB} MB`
                    : '—'}
                </div>
                <div className="stat-hint">
                  {adminData.storage
                    ? `${adminData.storage.fileCount} archivos (limpieza FIFO automática)`
                    : 'Calculando…'}
                </div>
              </div>
            </div>

            <div className="card">
              <h2 className="section-title" style={{ marginTop: 0 }}>
                <span>Generar nuevo código de invitación</span>
              </h2>
              {adminMsg && <div className="alert ok">{adminMsg}</div>}
              <form className="form" onSubmit={handleCreateInvite}>
                <div className="grid two">
                  <div className="field">
                    <label htmlFor="invite-label">Etiqueta / Para quién es</label>
                    <input
                      id="invite-label"
                      type="text"
                      placeholder="Ej. Amigos uni, Dispositivo móvil…"
                      value={inviteLabel}
                      onChange={e => setInviteLabel(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="invite-uses">Límite de registros permitidos</label>
                    <input
                      id="invite-uses"
                      type="number"
                      min={1}
                      max={100}
                      value={inviteMaxUses}
                      onChange={e => setInviteMaxUses(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <button type="submit" className="btn">
                    + Generar código de invitación
                  </button>
                </div>
              </form>
            </div>

            <h2 className="section-title">
              <span>Códigos de invitación</span>
              <span className="count">{adminData.invites.length}</span>
            </h2>

            {adminData.invites.length === 0 ? (
              <div className="empty">
                <div className="empty-title">No hay códigos creados todavía</div>
                <p>Usa el formulario superior para crear tu primer código de invitación.</p>
              </div>
            ) : (
              <div className="grid">
                {adminData.invites.map(inv => {
                  const exhausted = inv.used_count >= inv.max_uses;
                  return (
                    <article key={inv.code} className="card item">
                      <div className="item-head">
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span className="code-pill">{inv.code}</span>
                            <span
                              className={`badge ${
                                inv.revoked ? 'coral' : exhausted ? 'amber' : 'mint'
                              }`}
                            >
                              {inv.revoked
                                ? 'Revocado'
                                : exhausted
                                ? 'Agotado'
                                : 'Disponible'}
                            </span>
                          </div>
                          <div className="item-sub" style={{ marginTop: 6 }}>
                            Etiqueta: <strong>{inv.label}</strong>
                          </div>
                        </div>

                        <div className="item-actions">
                          <button
                            type="button"
                            className="btn secondary sm"
                            onClick={() => copyInviteCode(inv.code)}
                          >
                            {copiedCode === inv.code ? '✓ Copiado' : 'Copiar código'}
                          </button>
                          <button
                            type="button"
                            className="btn secondary sm"
                            onClick={() =>
                              handleAdminAction({ action: 'revoke_invite', code: inv.code })
                            }
                          >
                            {inv.revoked ? 'Reactivar' : 'Revocar'}
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() =>
                              handleAdminAction({ action: 'delete_invite', code: inv.code })
                            }
                          >
                            Eliminar
                          </button>
                        </div>
                      </div>

                      <dl className="meta">
                        <div>
                          <dt>Usos</dt>
                          <dd>
                            {inv.used_count} / {inv.max_uses}
                          </dd>
                        </div>
                        <div>
                          <dt>Usado por</dt>
                          <dd>
                            {inv.used_by?.length
                              ? inv.used_by.map(u => `@${u.username}`).join(', ')
                              : 'Nadie aún'}
                          </dd>
                        </div>
                        <div>
                          <dt>Creado</dt>
                          <dd>{new Date(inv.created_at).toLocaleDateString('es')}</dd>
                        </div>
                      </dl>
                    </article>
                  );
                })}
              </div>
            )}

            <h2 className="section-title">
              <span>Usuarios registrados</span>
              <span className="count">{adminData.users.length}</span>
            </h2>

            <div className="grid">
              {adminData.users.map(u => (
                <article key={u.id} className="card item">
                  <div className="item-head">
                    <div>
                      <div className="item-title">@{u.username}</div>
                      <div className="item-sub">
                        {u.is_admin
                          ? 'Administrador principal'
                          : `Invitado con código: ${u.invited_by_code || '—'}`}
                      </div>
                    </div>
                    <div className="item-actions">
                      <span className={`badge ${u.is_admin ? 'cobalt' : u.active ? 'mint' : 'coral'}`}>
                        {u.is_admin ? 'Admin' : u.active ? 'Activo' : 'Suspendido'}
                      </span>
                      {!u.is_admin && (
                        <button
                          type="button"
                          className="btn secondary sm"
                          onClick={() =>
                            handleAdminAction({ action: 'toggle_user', userId: u.id })
                          }
                        >
                          {u.active ? 'Suspender' : 'Activar'}
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* ==================== MODAL DIALOG: CHOOSE LIBRARY TO SAVE TRACK ==================== */}
      <dialog
        ref={saveDialogRef}
        closedby="any"
        className="save-dialog"
        aria-labelledby="save-dialog-title"
        onClose={() => setTrackToSave(null)}
      >
        {trackToSave && (
          <div>
            <div className="item-head" style={{ marginBottom: 8 }}>
              <div>
                <h2 id="save-dialog-title" className="item-title" style={{ margin: 0 }}>
                  Guardar en librería
                </h2>
                <div className="item-sub">
                  {trackToSave.title} · {trackToSave.artist}
                </div>
              </div>
              <button type="button" className="btn ghost sm" onClick={closeSaveModal}>
                ✕
              </button>
            </div>

            <div className="dialog-list">
              <button
                type="button"
                className={`dialog-option ${isLiked(trackToSave.id) ? 'selected' : ''}`}
                onClick={() => toggleLike(trackToSave)}
              >
                <span>♥ Favoritos (Con corazón)</span>
                <span>{isLiked(trackToSave.id) ? '✓ Guardada' : '+ Agregar'}</span>
              </button>

              {customPlaylists.map(pl => {
                const inside = isTrackInPlaylist(pl.id, trackToSave.id);
                return (
                  <button
                    key={pl.id}
                    type="button"
                    className={`dialog-option ${inside ? 'selected' : ''}`}
                    onClick={() => toggleTrackInPlaylist(pl.id, trackToSave)}
                  >
                    <span>📁 {pl.name}</span>
                    <span>{inside ? '✓ Guardada' : '+ Agregar'}</span>
                  </button>
                );
              })}
            </div>

            <form
              className="search-bar"
              style={{ marginTop: 10, marginBottom: 0 }}
              onSubmit={e => {
                e.preventDefault();
                const created = createCustomPlaylist(modalNewPlaylistName, [
                  {
                    ...trackToSave,
                    addedAt: Date.now()
                  }
                ]);
                if (created) {
                  setModalNewPlaylistName('');
                }
              }}
            >
              <input
                type="text"
                className="search-input"
                placeholder="O crear nueva librería…"
                value={modalNewPlaylistName}
                onChange={e => setModalNewPlaylistName(e.target.value)}
                required
              />
              <button type="submit" className="btn sm">
                + Crear y guardar
              </button>
            </form>
          </div>
        )}
      </dialog>

      {/* ==================== MODAL DIALOG: CHOOSE LIBRARY FOR SPOTIFY IMPORT ==================== */}
      <dialog
        ref={spotifyDialogRef}
        closedby="any"
        className="save-dialog"
        aria-labelledby="spotify-dialog-title"
        onClose={() => setPendingSpotifyImport(null)}
      >
        {pendingSpotifyImport && (
          <div>
            <div className="item-head" style={{ marginBottom: 8 }}>
              <div>
                <h2 id="spotify-dialog-title" className="item-title" style={{ margin: 0 }}>
                  ¿Dónde guardar la importación?
                </h2>
                <div className="item-sub">
                  {pendingSpotifyImport.tracks.length} canciones de «{pendingSpotifyImport.sourceName}»
                </div>
              </div>
              <button type="button" className="btn ghost sm" onClick={closeSpotifyImportModal}>
                ✕
              </button>
            </div>

            <div className="dialog-list">
              <button
                type="button"
                className="dialog-option selected"
                onClick={() => confirmSpotifyImport('liked')}
              >
                <span>♥ Guardar en Me gusta (Favoritos)</span>
                <span>Elegir →</span>
              </button>

              {customPlaylists.map(pl => (
                <button
                  key={pl.id}
                  type="button"
                  className="dialog-option"
                  onClick={() => confirmSpotifyImport(pl.id)}
                >
                  <span>📁 Guardar en «{pl.name}» ({pl.tracks.length})</span>
                  <span>Elegir →</span>
                </button>
              ))}
            </div>

            <form
              className="search-bar"
              style={{ marginTop: 10, marginBottom: 0 }}
              onSubmit={e => {
                e.preventDefault();
                confirmSpotifyImport('new_playlist', spotifyNewLibName);
              }}
            >
              <input
                type="text"
                className="search-input"
                placeholder="Nombre para nueva librería…"
                value={spotifyNewLibName}
                onChange={e => setSpotifyNewLibName(e.target.value)}
                required
              />
              <button type="submit" className="btn sm">
                + Crear nueva y guardar
              </button>
            </form>
          </div>
        )}
      </dialog>

      {/* ==================== EDITORIAL FLOATING PLAYER DOCK ==================== */}
      {currentTrack && (
        <div className="player-dock">
          <div className="player-main">
            <div className="player-track">
              <img src={currentTrack.artwork || '/icon.svg'} alt={currentTrack.title} />
              <div style={{ minWidth: 0 }}>
                <div className="player-track-title">{currentTrack.title}</div>
                <div className="player-track-sub">{currentTrack.artist}</div>
              </div>
            </div>

            <div className="player-controls">
              <button
                type="button"
                className={`ctrl-btn ${shuffle ? 'active' : ''}`}
                onClick={() => setShuffle(s => !s)}
                title="Aleatorio"
              >
                🔀
              </button>
              <button type="button" className="ctrl-btn" onClick={playPrev} title="Anterior">
                ⏮
              </button>
              <button
                type="button"
                className="ctrl-btn play-main"
                onClick={togglePlayPause}
                title={isPlaying ? 'Pausar' : 'Reproducir'}
              >
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button type="button" className="ctrl-btn" onClick={playNext} title="Siguiente">
                ⏭
              </button>
              <button
                type="button"
                className={`ctrl-btn ${repeatMode !== 'off' ? 'active' : ''}`}
                onClick={cycleRepeatMode}
                title="Modo bucle"
              >
                {repeatMode === 'one' ? '🔂' : '🔁'}
              </button>
            </div>
          </div>

          <div className="player-seek">
            <span>{formatSec(progress)}</span>
            <input
              type="range"
              min="0"
              max={duration || 100}
              value={progress}
              onChange={e => {
                const val = Number(e.target.value);
                setProgress(val);
                if (audioRef.current) audioRef.current.currentTime = val;
              }}
            />
            <span>{formatSec(duration)}</span>
          </div>

          <audio
            ref={audioRef}
            onTimeUpdate={e => setProgress(e.currentTarget.currentTime)}
            onLoadedMetadata={e => setDuration(e.currentTarget.duration)}
            onEnded={handleTrackEnded}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />
        </div>
      )}
    </>
  );
}
