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

function Icon({ name, size = 15, className = '' }) {
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '2',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `svg-icon ${className}`.trim(),
    'aria-hidden': 'true'
  };

  switch (name) {
    case 'heart-fill':
      return (
        <svg {...props} fill="currentColor">
          <path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...props}>
          <path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z" />
        </svg>
      );
    case 'check':
      return (
        <svg {...props}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    case 'offline-pin':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v6" />
          <path d="M9 11.5l3 3 3-3" />
        </svg>
      );
    case 'folder':
      return (
        <svg {...props}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'download':
      return (
        <svg {...props}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      );
    case 'file-audio':
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <circle cx="10" cy="16" r="2" />
          <path d="M12 16v-5l3 1" />
        </svg>
      );
    case 'refresh':
      return (
        <svg {...props}>
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      );
    case 'trash':
      return (
        <svg {...props}>
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.02 1.41 1.09H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...props}>
          <path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4z" />
        </svg>
      );
    case 'smartphone':
      return (
        <svg {...props}>
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
          <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
      );
    case 'wifi-off':
      return (
        <svg {...props}>
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </svg>
      );
    case 'sparkles':
      return (
        <svg {...props}>
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
          <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
        </svg>
      );
    case 'shuffle':
      return (
        <svg {...props}>
          <polyline points="16 3 21 3 21 8" />
          <line x1="4" y1="20" x2="21" y2="3" />
          <polyline points="21 16 21 21 16 21" />
          <line x1="15" y1="15" x2="21" y2="21" />
          <line x1="4" y1="4" x2="9" y2="9" />
        </svg>
      );
    case 'search':
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.5" y2="16.5" />
        </svg>
      );
    case 'play':
      return (
        <svg {...props} fill="currentColor">
          <polygon points="6 4 20 12 6 20 6 4" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...props} fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      );
    case 'skip-back':
      return (
        <svg {...props} fill="currentColor">
          <polygon points="19 20 9 12 19 4 19 20" />
          <line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" strokeWidth="2.2" />
        </svg>
      );
    case 'skip-forward':
      return (
        <svg {...props} fill="currentColor">
          <polygon points="5 4 15 12 5 20 5 4" />
          <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2.2" />
        </svg>
      );
    case 'repeat':
      return (
        <svg {...props}>
          <polyline points="17 1 21 5 17 9" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <polyline points="7 23 3 19 7 15" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
      );
    case 'repeat-1':
      return (
        <svg {...props}>
          <polyline points="17 1 21 5 17 9" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <polyline points="7 23 3 19 7 15" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          <path d="M11 10h1v4" />
        </svg>
      );
    case 'headphones':
      return (
        <svg {...props}>
          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...props}>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      );
    case 'close':
      return (
        <svg {...props}>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case 'arrow-right':
      return (
        <svg {...props}>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      );
    default:
      return null;
  }
}

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
  const [likedTracks, setLikedTracks] = useState([]); // ONLY tracks with heart
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
  const [spotifyTargetLib, setSpotifyTargetLib] = useState('ask');
  const [pendingSpotifyImport, setPendingSpotifyImport] = useState(null);
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
  const shuffleStateRef = useRef({ order: [], pos: -1, queueLen: 0 });
  const wasOfflineRef = useRef(false);

  const currentTrack = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

  function sanitizeLikedTracksList(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(
      t =>
        t &&
        !String(t.id || '').startsWith('offline_') &&
        String(t.genre || '').trim().toLowerCase() !== 'offline' &&
        String(t.album || '').trim().toLowerCase() !== 'guardado en dispositivo'
    );
  }

  // Active internet connectivity detector (Spotify-style automatic offline/online transition)
  async function verifyInternetConnection() {
    if (typeof window === 'undefined') return true;
    if (!navigator.onLine) {
      setIsOffline(true);
      return false;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    try {
      const r = await fetch('/api/auth', {
        method: 'GET',
        cache: 'no-store',
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.user) {
        setUser(data.user);
        try {
          localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
        } catch {}
      }
      setIsOffline(false);
      return true;
    } catch {
      clearTimeout(timer);
      setIsOffline(true);
      return false;
    }
  }

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

  // Check session & hydrate local collections on mount + auto-detect online/offline changes
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
        const parsed = sanitizeLikedTracksList(JSON.parse(savedLikes));
        setLikedTracks(parsed);
        localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(parsed));
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
    wasOfflineRef.current = offlineNow;
    if (offlineNow) {
      setActiveTab('library');
      setSelectedLibrary('offline');
      if (!cachedUser) {
        setUser({ username: 'Modo Offline', is_admin: false, offline: true });
      }
      setAuthChecked(true);
    }

    fetch('/api/auth', { cache: 'no-store' })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.user) {
          setUser(data.user);
          setIsOffline(false);
          try {
            localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
          } catch {}
        } else if (r.status === 401 || (r.ok && !data.user)) {
          setUser(null);
          setIsOffline(false);
          try {
            localStorage.removeItem(USER_STORAGE_KEY);
          } catch {}
        }
      })
      .catch(() => {
        setIsOffline(true);
        wasOfflineRef.current = true;
        setActiveTab('library');
        setSelectedLibrary('offline');
        setUser(prev => prev || cachedUser || { username: 'Modo Offline', is_admin: false, offline: true });
      })
      .finally(() => setAuthChecked(true));

    refreshOfflineCacheList();
    warmAppShellCache();

    const handleOnline = () => {
      verifyInternetConnection();
    };
    const handleOffline = () => {
      setIsOffline(true);
      wasOfflineRef.current = true;
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        verifyInternetConnection();
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);

    // Periodic connectivity probe every 12s so captive portals or silent drops are auto-detected
    const probeTimer = setInterval(() => {
      verifyInternetConnection();
    }, 12000);

    const handleBeforeInstall = e => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => {
      clearInterval(probeTimer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    };
  }, []);

  // Load initial catalog & server files once logged in, or restore automatically when internet returns!
  useEffect(() => {
    if (!user) return;
    if (isOffline) {
      wasOfflineRef.current = true;
      return;
    }
    fetchLibraryFiles();
    let initialLikes = likedTracks;
    try {
      const raw = localStorage.getItem(LIKES_STORAGE_KEY);
      if (raw) {
        initialLikes = sanitizeLikedTracksList(JSON.parse(raw));
      }
    } catch {}
    if (results.length === 0 || wasOfflineRef.current) {
      wasOfflineRef.current = false;
      loadRecommendedOrRandomFeed(initialLikes, false);
    }
    if (user.is_admin) {
      fetchAdminData();
    }
  }, [user, isOffline]);

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
      'importado de spotify',
      'guardado en dispositivo',
      'artista'
    ]);
    return ignored.has(norm) || norm.startsWith('offline_');
  }

  function getLikedCategories(tracksList = likedTracks) {
    const counts = {};
    const cleanTracks = sanitizeLikedTracksList(tracksList);
    for (const t of cleanTracks) {
      const artist = !isIgnoredTasteTerm(t.artist) ? t.artist.trim() : null;
      const genre = !isIgnoredTasteTerm(t.genre) ? t.genre.trim() : null;
      const primary = artist || genre;
      if (primary) {
        counts[primary] = (counts[primary] || 0) + 2;
      }
      if (genre && genre !== primary) {
        counts[genre] = (counts[genre] || 0) + 1;
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
        const a = t.artist.trim();
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

    const excludeKeys = [...cleanLikes, ...playlistTracks]
      .map(
        t =>
          `${String(t.title || '').trim().toLowerCase()}|${String(t.artist || '')
            .trim()
            .toLowerCase()}`
      )
      .filter(k => k !== '|')
      .slice(0, 120);

    const mode = !forceRandom && (topArtists.length > 0 || topGenres.length > 0)
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
        if (Array.isArray(data.tracks) && data.tracks.length > 0) {
          setFeedInfo({
            mode: data.mode || mode,
            label: data.label || (mode === 'recommended' ? topArtists[0] || topGenres[0] : 'Mix variado')
          });
          setResults(data.tracks);
          setLoading(false);
          return;
        }
      }
    } catch {}

    // Fallback to direct catalog search if /api/recommend fails
    if (mode === 'recommended') {
      const pool = topArtists.length > 0 ? topArtists : topGenres;
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      await searchTracks(chosen, { mode: 'recommended', label: chosen });
    } else {
      const randomSeed = DISCOVERY_SEEDS[Math.floor(Math.random() * DISCOVERY_SEEDS.length)];
      await searchTracks(randomSeed.term, { mode: 'random', label: randomSeed.label });
    }
    setLoading(false);
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
        text: `Se guardaron ${filtered.length} canciones en «Favoritos (Me gusta)».`
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
          text: `Se creó la librería «${created.name}» con ${freshTracks.length} canciones.`
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
        text: `Se guardaron ${filtered.length} canciones en «${targetPl.name}».`
      });
      closeSpotifyImportModal();
    }
  }

  function isTrackAvailableOffline(track) {
    if (!track) return false;
    const dl = downloads[track.id];
    const offItem = offlineCatalog.find(
      t =>
        String(t.id) === String(track.id) ||
        (track.filename && t.filename === track.filename)
    );
    if (offItem) return true;
    const filename = track.filename || dl?.filename;
    const streamUrl =
      track.streamUrl ||
      (filename ? `/api/stream?file=${encodeURIComponent(filename)}` : null);
    return Boolean(streamUrl && offlineUrls[streamUrl]);
  }

  /**
   * Smart Shuffle (Fisher-Yates + Artist Spread constraint):
   * - Guarantees every track in the queue plays once before any track repeats.
   * - Spreads tracks by the same artist across the queue so they don't play back-to-back.
   */
  function buildSmartShuffleOrder(list, startIdx = -1, minArtistDistance = 2) {
    const n = Array.isArray(list) ? list.length : 0;
    if (n <= 1) return n === 1 ? [0] : [];

    const pool = [];
    for (let i = 0; i < n; i++) {
      if (i !== startIdx) pool.push(i);
    }

    // Step 1: Unbiased Fisher-Yates shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    // Step 2: Artist Spread sliding window constraint
    const normArtist = idx =>
      String(list[idx]?.artist || '')
        .trim()
        .toLowerCase();

    const order = startIdx >= 0 && startIdx < n ? [startIdx] : [];
    const recentArtists =
      startIdx >= 0 && startIdx < n && normArtist(startIdx) ? [normArtist(startIdx)] : [];

    while (pool.length > 0) {
      let pickPos = pool.findIndex(idx => {
        const a = normArtist(idx);
        return !a || !recentArtists.includes(a);
      });
      if (pickPos === -1) pickPos = 0;

      const [chosenIdx] = pool.splice(pickPos, 1);
      order.push(chosenIdx);

      const chosenArtist = normArtist(chosenIdx);
      if (chosenArtist) {
        recentArtists.push(chosenArtist);
        if (recentArtists.length > minArtistDistance) {
          recentArtists.shift();
        }
      }
    }

    return order;
  }

  // Player controls
  function playFromList(list, index, startRandom = false) {
    if (!Array.isArray(list) || list.length === 0) return;

    // When offline, behave like Spotify: only queue tracks that are cached on the device
    if (isOffline) {
      const clickedTrack = list[index];
      if (clickedTrack && !isTrackAvailableOffline(clickedTrack) && !startRandom) {
        return;
      }
      const playableList = list.filter(t => isTrackAvailableOffline(t));
      if (playableList.length === 0) return;
      const mappedIdx = clickedTrack
        ? Math.max(
            0,
            playableList.findIndex(t => String(t.id) === String(clickedTrack.id))
          )
        : 0;
      setQueue(playableList);
      if (shuffle || startRandom) {
        const order = buildSmartShuffleOrder(playableList, startRandom ? -1 : mappedIdx);
        shuffleStateRef.current = { order, pos: 0, queueLen: playableList.length };
        setCurrentIndex(order[0] ?? mappedIdx);
      } else {
        shuffleStateRef.current = { order: [], pos: -1, queueLen: playableList.length };
        setCurrentIndex(mappedIdx);
      }
      return;
    }

    setQueue(list);
    if (shuffle || startRandom) {
      const order = buildSmartShuffleOrder(list, startRandom ? -1 : index);
      shuffleStateRef.current = { order, pos: 0, queueLen: list.length };
      setCurrentIndex(order[0] ?? index);
    } else {
      shuffleStateRef.current = { order: [], pos: -1, queueLen: list.length };
      setCurrentIndex(index);
    }
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
      let { order, pos, queueLen } = shuffleStateRef.current;
      if (!Array.isArray(order) || order.length !== queue.length || queueLen !== queue.length) {
        order = buildSmartShuffleOrder(queue, currentIndex);
        pos = 0;
      }
      const nextPos = pos + 1;
      if (nextPos < order.length) {
        shuffleStateRef.current = { order, pos: nextPos, queueLen: queue.length };
        setCurrentIndex(order[nextPos]);
      } else {
        // Completed full permutation without repeats; reshuffle for next cycle avoiding immediate repeat
        const freshOrder = buildSmartShuffleOrder(queue, -1);
        if (freshOrder.length > 1 && freshOrder[0] === currentIndex) {
          [freshOrder[0], freshOrder[1]] = [freshOrder[1], freshOrder[0]];
        }
        shuffleStateRef.current = { order: freshOrder, pos: 0, queueLen: queue.length };
        setCurrentIndex(freshOrder[0]);
      }
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
    if (shuffle && queue.length > 1) {
      const { order, pos, queueLen } = shuffleStateRef.current;
      if (Array.isArray(order) && queueLen === queue.length && pos > 0) {
        const prevPos = pos - 1;
        shuffleStateRef.current = { order, pos: prevPos, queueLen: queue.length };
        setCurrentIndex(order[prevPos]);
        return;
      }
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

              <div className={isOffline ? 'offline-section-disabled' : ''}>
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

                    <button type="submit" className="btn" disabled={authBusy || isOffline}>
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

                    <button type="submit" className="btn" disabled={authBusy || isOffline}>
                      {authBusy ? 'Activando cuenta…' : 'Crear cuenta e ingresar'}
                    </button>
                  </form>
                )}
              </div>

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
                    <Icon name="headphones" size={16} /> Abrir mis canciones Offline ({offlineCatalog.length}) sin conexión
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

  const playableActiveLibraryTracks = isOffline
    ? activeLibraryTracks.filter(t => isTrackAvailableOffline(t))
    : activeLibraryTracks;

  const activeLibraryTitle =
    selectedLibrary === 'liked'
      ? 'Favoritos (Con corazón)'
      : selectedLibrary === 'offline'
      ? 'Offline (Guardadas en este dispositivo)'
      : activeCustomPlaylist
      ? activeCustomPlaylist.name
      : 'Favoritos';

  return (
    <>
      <header className="site-header">
        <button type="button" className="brand" onClick={() => setActiveTab(isOffline ? 'library' : 'explore')}>
          <img src="/icon.svg" alt="MyMusicAnywhere" className="brand-logo" />
          <div className="brand-text">
            <span className="brand-name">MyMusicAnywhere</span>
            <span className="brand-sub">Studio &amp; Offline Player</span>
          </div>
        </button>

        <nav className="site-nav" aria-label="Principal">
          <button
            type="button"
            className={`${activeTab === 'explore' ? 'active' : ''} ${isOffline ? 'offline-nav-item' : ''}`.trim()}
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
            className={`${activeTab === 'files' ? 'active' : ''} ${isOffline ? 'offline-nav-item' : ''}`.trim()}
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
              className={`${activeTab === 'admin' ? 'active' : ''} ${isOffline ? 'offline-nav-item' : ''}`.trim()}
              onClick={() => {
                setActiveTab('admin');
                if (!isOffline) fetchAdminData();
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
                <Icon name="settings" size={15} /> Configuración e Importar Spotify
              </button>

              {user.is_admin && (
                <button
                  type="button"
                  className={`account-item ${isOffline ? 'offline-section-disabled' : ''}`.trim()}
                  onClick={() => {
                    setActiveTab('admin');
                    setAccountOpen(false);
                    if (!isOffline) fetchAdminData();
                  }}
                >
                  <Icon name="shield" size={15} /> Panel de invitaciones
                </button>
              )}

              {deferredPrompt && (
                <button type="button" className="account-item" onClick={handleInstallPwa}>
                  <Icon name="smartphone" size={15} /> Instalar app en dispositivo
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
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Icon name="wifi-off" size={16} />
              <span>
                <strong>Sin conexión a internet:</strong> Las funciones online aparecen en gris. Tu música descargada en Offline sigue disponible con normalidad.
              </span>
            </span>
            {activeTab !== 'library' && (
              <button
                type="button"
                className="btn secondary sm"
                onClick={() => {
                  setActiveTab('library');
                  setSelectedLibrary('offline');
                }}
              >
                <Icon name="offline-pin" size={14} /> Ir a mis Offline ({offlineCatalog.length})
              </button>
            )}
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
                  <Icon name="plus" size={14} /> Instalar PWA
                </button>
              )}
            </div>

            <form
              className={`search-bar ${isOffline ? 'offline-section-disabled' : ''}`.trim()}
              onSubmit={e => {
                e.preventDefault();
                if (!isOffline) searchTracks(query);
              }}
            >
              <input
                type="search"
                className="search-input"
                enterKeyHint="search"
                placeholder={
                  isOffline
                    ? 'Búsqueda deshabilitada sin conexión a internet…'
                    : 'Buscar canción, artista o álbum…'
                }
                value={query}
                onChange={e => setQuery(e.target.value)}
                disabled={isOffline}
              />
              <button type="submit" className="btn" disabled={loading || isOffline}>
                <Icon name="search" size={15} />
                {loading ? 'Buscando…' : 'Buscar'}
              </button>
            </form>

            <div className={`toolbar ${isOffline ? 'offline-section-disabled' : ''}`.trim()}>
              <div className="toolbar-group">
                {feedInfo.mode === 'recommended' ? (
                  <span className="badge coral">
                    <Icon name="heart-fill" size={12} /> Recomendado por tu gusto: {feedInfo.label}
                  </span>
                ) : feedInfo.mode === 'random' ? (
                  <span className="badge cobalt">
                    <Icon name="shuffle" size={12} /> Selección aleatoria: {feedInfo.label}
                  </span>
                ) : (
                  <span className="badge neutral">
                    <Icon name="search" size={12} /> Búsqueda: {feedInfo.label}
                  </span>
                )}

                {getLikedCategories().slice(0, 3).map(cat => (
                  <button
                    key={cat}
                    type="button"
                    className="btn secondary sm"
                    disabled={isOffline}
                    onClick={() => searchTracks(cat, { mode: 'recommended', label: cat })}
                  >
                    <Icon name="heart-fill" size={12} /> {cat}
                  </button>
                ))}
              </div>

              <div className="toolbar-group">
                {likedTracks.length > 0 && (
                  <button
                    type="button"
                    className="btn secondary sm"
                    disabled={isOffline}
                    onClick={() => loadRecommendedOrRandomFeed(likedTracks, false)}
                  >
                    <Icon name="sparkles" size={14} /> Para mí
                  </button>
                )}
                <button
                  type="button"
                  className="btn secondary sm"
                  disabled={isOffline}
                  onClick={() => loadRecommendedOrRandomFeed(likedTracks, true)}
                >
                  <Icon name="shuffle" size={14} /> Música aleatoria
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
                const isOfflineReady = dl?.status === 'ready' || isTrackAvailableOffline(track);
                const isGreyedOffline = isOffline && !isOfflineReady;

                return (
                  <article
                    key={track.id}
                    className={`card item ${isCurrent ? 'playing' : ''} ${
                      isGreyedOffline ? 'offline-unavailable' : ''
                    }`.trim()}
                  >
                    <div className="item-head">
                      <div className="item-media">
                        <div
                          className="artwork-wrap"
                          onClick={() => {
                            if (!isGreyedOffline) playFromList(results, idx);
                          }}
                          title={isGreyedOffline ? 'Requiere conexión a internet' : 'Reproducir pista'}
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
                            <Icon name={isCurrent && isPlaying ? 'pause' : 'play'} size={18} />
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
                          <Icon name={liked ? 'heart-fill' : 'heart'} size={14} />
                        </button>

                        <button
                          type="button"
                          className="btn secondary sm"
                          onClick={() => openSaveModal(track)}
                          title="Elegir en qué librería guardar"
                        >
                          <Icon name="folder" size={14} /> Guardar
                          {savedPlaylistCount > 0 ? ` (${savedPlaylistCount})` : ''}
                        </button>

                        {isOfflineReady ? (
                          <>
                            <span className="badge mint">
                              <Icon name="offline-pin" size={13} /> Offline
                            </span>
                            <button
                              type="button"
                              onClick={() => exportTrackFile(dl?.filename || track.filename)}
                              className="btn secondary sm"
                              title="Exportar archivo MP3 al teléfono o PC"
                            >
                              <Icon name="file-audio" size={14} /> Archivo
                            </button>
                          </>
                        ) : isGreyedOffline ? (
                          <span className="badge neutral">
                            <Icon name="wifi-off" size={12} /> Sin internet
                          </span>
                        ) : dl?.status === 'downloading' ? (
                          <span className="badge amber">
                            Extrayendo {Math.round(dl.progress || 0)}%
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn sm"
                            disabled={isOffline}
                            onClick={() => startDownload(track)}
                          >
                            <Icon name={dl?.status === 'error' ? 'refresh' : 'download'} size={14} />
                            {dl?.status === 'error' ? 'Reintentar MP3' : 'MP3'}
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
                          {isOfflineReady
                            ? 'En librería Offline'
                            : isGreyedOffline
                            ? 'Requiere internet'
                            : liked
                            ? 'En Favoritos'
                            : savedPlaylistCount > 0
                            ? `En ${savedPlaylistCount} librería(s)`
                            : 'Streaming disponible'}
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
                  Tu colección separada entre Favoritos, Offline en el dispositivo y las librerías que vos crees.
                </p>
              </div>
              <button
                type="button"
                className="btn secondary sm"
                onClick={() => setCreatingPlaylist(v => !v)}
              >
                {creatingPlaylist ? (
                  <>
                    <Icon name="close" size={13} /> Cancelar
                  </>
                ) : (
                  <>
                    <Icon name="plus" size={13} /> Nueva librería
                  </>
                )}
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

            {/* Switcher between Favoritos, Offline, and Custom Libraries */}
            <div className="library-switcher" role="tablist" aria-label="Selector de librería">
              <button
                type="button"
                className={`library-pill ${selectedLibrary === 'liked' ? 'active' : ''}`}
                onClick={() => setSelectedLibrary('liked')}
              >
                <Icon name="heart-fill" size={14} />
                <span>Favoritos</span>
                <span className="library-pill-count">{likedTracks.length}</span>
              </button>

              <button
                type="button"
                className={`library-pill ${selectedLibrary === 'offline' ? 'active' : ''}`}
                onClick={() => setSelectedLibrary('offline')}
              >
                <Icon name="offline-pin" size={14} />
                <span>Offline</span>
                <span className="library-pill-count">{offlineCatalog.length}</span>
              </button>

              {customPlaylists.map(pl => (
                <button
                  key={pl.id}
                  type="button"
                  className={`library-pill ${selectedLibrary === pl.id ? 'active' : ''}`}
                  onClick={() => setSelectedLibrary(pl.id)}
                >
                  <Icon name="folder" size={14} />
                  <span>{pl.name}</span>
                  <span className="library-pill-count">{pl.tracks.length}</span>
                </button>
              ))}
            </div>

            <div className="storage-banner">
              <span>
                <strong>Vista activa:</strong> {activeLibraryTitle} ·{' '}
                {deviceQuota
                  ? `${deviceQuota.usedMB} MB usados de ~${deviceQuota.quotaGB} GB en dispositivo`
                  : 'Caché offline del navegador activo'}
              </span>
              <span className="badge mint">
                <Icon name="offline-pin" size={12} /> {offlineCatalog.length} pistas offline
              </span>
            </div>

            <div className="toolbar">
              <div className="toolbar-group">
                <button
                  type="button"
                  className="btn sm"
                  disabled={playableActiveLibraryTracks.length === 0}
                  onClick={() => playFromList(activeLibraryTracks, 0)}
                >
                  <Icon name="play" size={13} /> Reproducir librería
                  {isOffline && playableActiveLibraryTracks.length < activeLibraryTracks.length
                    ? ` (${playableActiveLibraryTracks.length} offline)`
                    : ''}
                </button>
                <button
                  type="button"
                  className={`btn secondary sm ${shuffle ? 'cobalt' : ''}`}
                  onClick={() => setShuffle(s => !s)}
                >
                  <Icon name="shuffle" size={13} /> Aleatorio: {shuffle ? 'ON' : 'OFF'}
                </button>
                <button type="button" className="btn secondary sm" onClick={cycleRepeatMode}>
                  <Icon name={repeatMode === 'one' ? 'repeat-1' : 'repeat'} size={13} /> Bucle:{' '}
                  {repeatMode === 'off' ? 'No' : repeatMode === 'all' ? 'Todo' : '1 pista'}
                </button>
              </div>

              <div className="toolbar-group">
                {selectedLibrary !== 'offline' && (
                  <button
                    type="button"
                    className={`btn secondary sm ${isOffline ? 'offline-section-disabled' : ''}`.trim()}
                    disabled={activeLibraryTracks.length === 0 || syncingAll || isOffline}
                    onClick={() => downloadCollectionForOffline(activeLibraryTracks)}
                  >
                    <Icon name="download" size={13} />
                    {syncingAll ? 'Sincronizando…' : 'Bajar toda esta librería a Offline'}
                  </button>
                )}

                {activeCustomPlaylist && (
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={() => deleteCustomPlaylist(activeCustomPlaylist.id)}
                  >
                    <Icon name="trash" size={13} /> Eliminar librería
                  </button>
                )}
              </div>
            </div>

            {activeLibraryTracks.length === 0 ? (
              <div className="empty">
                <div className="empty-title">Esta librería está vacía</div>
                <p>
                  {selectedLibrary === 'liked'
                    ? 'Toca el icono de corazón en cualquier canción de Explorar para guardarla en Favoritos.'
                    : selectedLibrary === 'offline'
                    ? 'Cuando descargues cualquier MP3 aparecerá automáticamente aquí para escuchar sin internet.'
                    : 'Usa el botón «Guardar» en Explorar para agregar canciones a esta librería.'}
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
                    selectedLibrary === 'offline' ||
                    Boolean(offItem) ||
                    Boolean(streamUrl && offlineUrls[streamUrl]);
                  const isGreyedOffline = isOffline && !isOfflineReady;
                  const isCurrent = currentTrack?.id === track.id;
                  const liked = isLiked(track.id);

                  return (
                    <article
                      key={`${selectedLibrary}_${track.id}`}
                      className={`card item ${isCurrent ? 'playing' : ''} ${
                        isGreyedOffline ? 'offline-unavailable' : ''
                      }`.trim()}
                    >
                      <div className="item-head">
                        <div className="item-media">
                          <div
                            className="artwork-wrap"
                            onClick={() => {
                              if (!isGreyedOffline) playFromList(activeLibraryTracks, idx);
                            }}
                            title={
                              isGreyedOffline
                                ? 'No descargada en el dispositivo (requiere internet)'
                                : 'Reproducir pista'
                            }
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
                              <Icon name={isCurrent && isPlaying ? 'pause' : 'play'} size={18} />
                            </div>
                          </div>
                          <div className="item-info">
                            <div className="item-title">{track.title}</div>
                            <div className="item-sub">{track.artist}</div>
                          </div>
                        </div>

                        <div className="item-actions">
                          {isOfflineReady ? (
                            <span className="badge mint">
                              <Icon name="offline-pin" size={13} /> Offline
                            </span>
                          ) : isGreyedOffline ? (
                            <span className="badge neutral">
                              <Icon name="wifi-off" size={12} /> Requiere internet
                            </span>
                          ) : dl?.status === 'downloading' ? (
                            <span className="badge amber">
                              Extrayendo {Math.round(dl.progress || 0)}%
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn sm"
                              disabled={isOffline}
                              onClick={() => startDownload(track)}
                            >
                              <Icon
                                name={dl?.status === 'error' ? 'refresh' : 'download'}
                                size={14}
                              />
                              {dl?.status === 'error' ? 'Reintentar MP3' : 'Obtener MP3'}
                            </button>
                          )}

                          {filename && isOfflineReady && (
                            <button
                              type="button"
                              onClick={() => exportTrackFile(filename, streamUrl)}
                              className="btn secondary sm"
                              title="Exportar archivo MP3"
                            >
                              <Icon name="file-audio" size={14} /> Archivo
                            </button>
                          )}

                          <button
                            type="button"
                            className={`btn heart ${liked ? 'liked' : ''}`}
                            onClick={() => toggleLike(track)}
                            title={liked ? 'Quitar de Favoritos' : 'Agregar a Favoritos'}
                          >
                            <Icon name={liked ? 'heart-fill' : 'heart'} size={14} />
                          </button>

                          <button
                            type="button"
                            className="btn secondary sm"
                            onClick={() => openSaveModal(track)}
                            title="Guardar en otra librería"
                          >
                            <Icon name="folder" size={14} />
                          </button>

                          {/* Delete / Remove action depending on current library */}
                          {selectedLibrary === 'offline' ? (
                            <button
                              type="button"
                              className="btn danger sm"
                              onClick={() => deleteOfflineTrack(track)}
                              title="Borrar MP3 del almacenamiento offline del dispositivo"
                            >
                              <Icon name="trash" size={14} /> Borrar
                            </button>
                          ) : selectedLibrary === 'liked' ? (
                            <button
                              type="button"
                              className="btn danger sm"
                              onClick={() => toggleLike(track)}
                              title="Quitar canción de Favoritos"
                            >
                              <Icon name="trash" size={14} /> Quitar
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
                              <Icon name="trash" size={14} /> Quitar
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
          <section className={isOffline ? 'offline-section-disabled' : ''}>
            <div className="page-head">
              <div>
                <h1 className="page-title">Archivos MP3 en servidor</h1>
                <p className="page-sub">
                  Puente temporal de descargas: el servidor elimina el MP3 automáticamente apenas tu dispositivo termina de bajarlo.
                </p>
              </div>
              <button
                type="button"
                className="btn secondary sm"
                disabled={isOffline}
                onClick={fetchLibraryFiles}
              >
                <Icon name="refresh" size={13} /> Actualizar lista
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
                            <div className="artwork-play-overlay">
                              <Icon name="play" size={18} />
                            </div>
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
                            <Icon name={isCached ? 'offline-pin' : 'download'} size={14} />
                            {isCached ? 'En Offline' : 'Guardar Offline'}
                          </button>
                          <a
                            href={`${file.url}&download=1`}
                            download={file.filename}
                            className="btn sm"
                          >
                            <Icon name="file-audio" size={14} /> Archivo
                          </a>
                          <button
                            type="button"
                            className="btn danger sm"
                            onClick={() => deleteServerFile(file.filename)}
                            title="Borrar archivo del servidor"
                          >
                            <Icon name="trash" size={14} /> Borrar
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

            <div
              className={`card ${isOffline ? 'offline-section-disabled' : ''}`.trim()}
              style={{ marginBottom: 16 }}
            >
              <div className="item-head" style={{ marginBottom: 12 }}>
                <div>
                  <div className="item-title">Importar música desde Spotify</div>
                  <div className="item-sub">
                    Pega el enlace de una playlist/álbum de Spotify o sube tu CSV: al cargar te preguntará si querés guardarlo en Me gusta (Favoritos) o en otra librería.
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
                        Ir a Mis librerías <Icon name="arrow-right" size={13} />
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
                  if (!spotifyUrl.trim() || spotifyBusy || isOffline) return;
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
                  disabled={isOffline}
                  required
                />
                <button type="submit" className="btn sm" disabled={spotifyBusy || isOffline}>
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
                  <Icon name="folder" size={14} /> Subir CSV de Spotify
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
                    <Icon name="trash" size={14} /> Vaciar todo el caché Offline
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ==================== TAB 5: ADMIN PANEL (SOLO ADMIN) ==================== */}
        {activeTab === 'admin' && user.is_admin && (
          <section className={isOffline ? 'offline-section-disabled' : ''}>
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
                    <Icon name="plus" size={14} /> Generar código de invitación
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
                            {copiedCode === inv.code ? (
                              <>
                                <Icon name="check" size={13} /> Copiado
                              </>
                            ) : (
                              'Copiar código'
                            )}
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
                <Icon name="close" size={15} />
              </button>
            </div>

            <div className="dialog-list">
              <button
                type="button"
                className={`dialog-option ${isLiked(trackToSave.id) ? 'selected' : ''}`}
                onClick={() => toggleLike(trackToSave)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Icon name="heart-fill" size={14} /> Favoritos (Con corazón)
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Icon name={isLiked(trackToSave.id) ? 'check' : 'plus'} size={13} />
                  {isLiked(trackToSave.id) ? 'Guardada' : 'Agregar'}
                </span>
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
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <Icon name="folder" size={14} /> {pl.name}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Icon name={inside ? 'check' : 'plus'} size={13} />
                      {inside ? 'Guardada' : 'Agregar'}
                    </span>
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
                <Icon name="plus" size={13} /> Crear y guardar
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
                <Icon name="close" size={15} />
              </button>
            </div>

            <div className="dialog-list">
              <button
                type="button"
                className="dialog-option selected"
                onClick={() => confirmSpotifyImport('liked')}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Icon name="heart-fill" size={14} /> Guardar en Me gusta (Favoritos)
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  Elegir <Icon name="arrow-right" size={13} />
                </span>
              </button>

              {customPlaylists.map(pl => (
                <button
                  key={pl.id}
                  type="button"
                  className="dialog-option"
                  onClick={() => confirmSpotifyImport(pl.id)}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <Icon name="folder" size={14} /> Guardar en «{pl.name}» ({pl.tracks.length})
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    Elegir <Icon name="arrow-right" size={13} />
                  </span>
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
                <Icon name="plus" size={13} /> Crear nueva y guardar
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
                title="Aleatorio inteligente"
              >
                <Icon name="shuffle" size={15} />
              </button>
              <button type="button" className="ctrl-btn" onClick={playPrev} title="Anterior">
                <Icon name="skip-back" size={15} />
              </button>
              <button
                type="button"
                className="ctrl-btn play-main"
                onClick={togglePlayPause}
                title={isPlaying ? 'Pausar' : 'Reproducir'}
              >
                <Icon name={isPlaying ? 'pause' : 'play'} size={16} />
              </button>
              <button type="button" className="ctrl-btn" onClick={playNext} title="Siguiente">
                <Icon name="skip-forward" size={15} />
              </button>
              <button
                type="button"
                className={`ctrl-btn ${repeatMode !== 'off' ? 'active' : ''}`}
                onClick={cycleRepeatMode}
                title="Modo bucle"
              >
                <Icon name={repeatMode === 'one' ? 'repeat-1' : 'repeat'} size={15} />
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
