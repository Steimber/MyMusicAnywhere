'use client';

import { useState, useEffect, useRef } from 'react';
import { NoSleepController } from '../lib/nosleep';

const AUDIO_CACHE_NAME = 'my-music-offline-audio-v1';
const SHELL_CACHE_NAME = 'mymusic-shell-v8';
const USER_STORAGE_KEY = 'mma_cached_user_v1';
const LIKES_STORAGE_KEY = 'mma_liked_tracks_v1';
const OFFLINE_CATALOG_KEY = 'mma_offline_catalog_v1';
const PLAYLISTS_STORAGE_KEY = 'mma_custom_playlists_v1';

const EXPLORE_CHIPS = [
  { id: 'for-you', label: 'Para vos', term: null },
  { id: 'trending', label: 'Tendencias', term: 'Top Hits Global 2025' },
  { id: 'latin', label: 'Pop Latino', term: 'Pop Latino Hits' },
  { id: 'urbano', label: 'Urbano', term: 'Reggaeton Urbano Latino' },
  { id: 'rock', label: 'Rock', term: 'Rock Clásico Español' },
  { id: 'electro', label: 'Electrónica', term: 'Daft Punk Electronic Synth' },
  { id: 'rnb', label: 'R&B & Soul', term: 'The Weeknd R&B Soul' },
  { id: 'indie', label: 'Indie', term: 'Indie Alternative Hits' }
];

function BrandMark() {
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet="/brand/logo-dark.svg?v=3" />
      <img src="/brand/logo.svg?v=3" alt="" width={33} height={40} className="brand-logo" />
    </picture>
  );
}

function Icon({ name, size = 16, className = '' }) {
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
    case 'loader':
      return (
        <svg {...props}>
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
      );
    case 'more':
      return (
        <svg {...props}>
          <circle cx="12" cy="5" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="19" r="1.5" fill="currentColor" />
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
    case 'disc':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="2.5" />
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
  const [authMode, setAuthMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // Navigation: 'explore' | 'library' | 'files' | 'settings' | 'admin'
  const [activeTab, setActiveTab] = useState('explore');
  const [selectedLibrary, setSelectedLibrary] = useState('liked');

  // Explore & Search
  const [query, setQuery] = useState('');
  const [activeChip, setActiveChip] = useState('for-you');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [feedInfo, setFeedInfo] = useState({ mode: 'recommended', label: '' });

  // Libraries & Offline Cache
  const [likedTracks, setLikedTracks] = useState([]);
  const [offlineCatalog, setOfflineCatalog] = useState([]);
  const [customPlaylists, setCustomPlaylists] = useState([]);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);

  // Dialogs: Track options menu ('⋯'), Save-to-Library, Spotify Import Destination
  const [menuTrack, setMenuTrack] = useState(null); // { track, contextLibrary }
  const [trackToSave, setTrackToSave] = useState(null);
  const [modalNewPlaylistName, setModalNewPlaylistName] = useState('');
  const menuDialogRef = useRef(null);
  const saveDialogRef = useRef(null);
  const spotifyDialogRef = useRef(null);

  // Downloads & Server Files
  const [downloads, setDownloads] = useState({});
  const [libraryFiles, setLibraryFiles] = useState([]);
  const [offlineUrls, setOfflineUrls] = useState({});
  const [deviceQuota, setDeviceQuota] = useState(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncProgress, setSyncProgress] = useState({ done: 0, total: 0 });
  const cancelSyncRef = useRef(false);
  const noSleepRef = useRef(null);

  // Settings: Spotify Importer
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [spotifyMsg, setSpotifyMsg] = useState({ type: '', text: '' });
  const [pendingSpotifyImport, setPendingSpotifyImport] = useState(null);
  const [spotifyNewLibName, setSpotifyNewLibName] = useState('');

  // Admin Panel
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
  const [repeatMode, setRepeatMode] = useState('off');
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef(null);
  const accountRef = useRef(null);
  const shuffleStateRef = useRef({ order: [], pos: -1, queueLen: 0 });
  const wasOfflineRef = useRef(false);
  const probeInFlightRef = useRef(false);

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

  // Improved Offline Detector: fast HEAD check + retry before declaring offline so slow APIs never false-trigger
  async function verifyInternetConnection() {
    if (typeof window === 'undefined') return true;
    if (!navigator.onLine) {
      setIsOffline(true);
      wasOfflineRef.current = true;
      return false;
    }
    if (probeInFlightRef.current) return !isOffline;
    probeInFlightRef.current = true;

    const pingOnce = async timeoutMs => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`/manifest.json?_ping=${Date.now()}`, {
          method: 'HEAD',
          cache: 'no-store',
          signal: ctrl.signal
        });
        clearTimeout(timer);
        return res.ok || res.status === 304;
      } catch {
        clearTimeout(timer);
        return false;
      }
    };

    try {
      let alive = await pingOnce(3000);
      if (!alive && navigator.onLine) {
        // Retry once before declaring offline to prevent false positives on mobile handoffs
        alive = await pingOnce(4000);
      }
      if (alive) {
        setIsOffline(false);
        return true;
      }
      setIsOffline(true);
      wasOfflineRef.current = true;
      return false;
    } finally {
      probeInFlightRef.current = false;
    }
  }

  // Warm PWA App Shell cache so reopening the app after closing it works 100% offline
  async function warmAppShellCache() {
    if (typeof window === 'undefined' || !('caches' in window)) return;
    try {
      const cache = await caches.open(SHELL_CACHE_NAME);
      const urlsToWarm = new Set(['/', '/manifest.json', '/icon.svg', '/brand/logo.svg', '/brand/logo-dark.svg']);
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
    const dialogs = [menuDialogRef.current, saveDialogRef.current, spotifyDialogRef.current].filter(Boolean);
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
  }, [user, menuTrack, trackToSave, pendingSpotifyImport]);

  // Open Spotify import modal safely after React state renders (and after mobile file picker closes)
  useEffect(() => {
    if (!pendingSpotifyImport) return;
    const t = setTimeout(() => {
      try {
        if (
          spotifyDialogRef.current &&
          !spotifyDialogRef.current.open &&
          typeof spotifyDialogRef.current.showModal === 'function'
        ) {
          spotifyDialogRef.current.showModal();
        }
      } catch {}
    }, 90);
    return () => clearTimeout(t);
  }, [pendingSpotifyImport]);

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
        setUser({ username: 'Offline', is_admin: false, offline: true });
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
      .catch(async () => {
        const alive = await verifyInternetConnection();
        if (!alive) {
          setActiveTab('library');
          setSelectedLibrary('offline');
          setUser(prev => prev || cachedUser || { username: 'Offline', is_admin: false, offline: true });
        }
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

    const probeTimer = setInterval(() => {
      verifyInternetConnection();
    }, 15000);

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

  // Load initial catalog & server files once logged in, or restore automatically when internet returns
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

  // Poll active downloads
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
        setIsOffline(false);
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

  function openTrackMenu(track, contextLibrary = null) {
    setMenuTrack({ track, contextLibrary });
    setTimeout(() => {
      if (menuDialogRef.current && !menuDialogRef.current.open && typeof menuDialogRef.current.showModal === 'function') {
        menuDialogRef.current.showModal();
      }
    }, 10);
  }

  function closeTrackMenu() {
    if (menuDialogRef.current && menuDialogRef.current.open) {
      menuDialogRef.current.close();
    }
    setMenuTrack(null);
  }

  function openSaveModal(track) {
    closeTrackMenu();
    setTrackToSave(track);
    setModalNewPlaylistName('');
    setTimeout(() => {
      if (saveDialogRef.current && !saveDialogRef.current.open && typeof saveDialogRef.current.showModal === 'function') {
        saveDialogRef.current.showModal();
      }
    }, 20);
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
      'spotify csv',
      'importado de spotify',
      'guardado en dispositivo',
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
            label: data.label || (mode === 'recommended' ? topArtists.slice(0, 2).join(', ') : '')
          });
          setResults(data.tracks);
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

  async function startDownload(track, waitUntilFinished = false) {
    const key = track.id || track.title;
    if (downloads[key]?.status === 'downloading') return false;

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
      if (!data.downloadId) {
        setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
        return false;
      }

      const dlId = data.downloadId;
      setDownloads(prev => ({
        ...prev,
        [key]: {
          status: 'downloading',
          progress: 8,
          downloadId: dlId,
          trackMeta: track
        }
      }));

      if (!waitUntilFinished) return true;

      // In bulk queue mode, wait until this track completes extraction + offline caching + VPS cleanup
      const startedAt = Date.now();
      while (Date.now() - startedAt < 85000 && !cancelSyncRef.current) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const checkRes = await fetch(`/api/download?id=${dlId}`);
          if (!checkRes.ok) break;
          const checkData = await checkRes.json();
          if (checkData.status === 'ready' && checkData.filename) {
            const streamUrl = `/api/stream?file=${encodeURIComponent(checkData.filename)}`;
            await saveUrlToOfflineCache(streamUrl, {
              ...track,
              id: track.id || `offline_${checkData.filename}`,
              title: track.title || checkData.title,
              artist: track.artist || checkData.artist || 'Audio MP3',
              artwork: track.artwork || '/icon.svg',
              filename: checkData.filename,
              streamUrl
            });
            setDownloads(prev => ({
              ...prev,
              [key]: { ...prev[key], ...checkData, status: 'ready', progress: 100 }
            }));
            updateTrackFileAcrossLibraries(key, checkData.filename, streamUrl);
            return true;
          }
          if (checkData.status === 'error') {
            setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
            return false;
          }
        } catch {
          break;
        }
      }
      return false;
    } catch {
      setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
      return false;
    }
  }

  async function downloadCollectionForOffline(tracksList) {
    if (!noSleepRef.current && typeof window !== 'undefined') {
      noSleepRef.current = new NoSleepController();
    }

    if (syncingAll) {
      // Tapping again cancels/pauses the bulk queue gracefully and releases NoSleep
      cancelSyncRef.current = true;
      noSleepRef.current?.disable();
      return;
    }
    if (!tracksList || tracksList.length === 0) return;

    const pending = tracksList.filter(t => !isTrackAvailableOffline(t));
    if (pending.length === 0) return;

    // Activate NoSleep synchronously inside user gesture so screen stays awake during bulk download
    noSleepRef.current?.enable();

    cancelSyncRef.current = false;
    setSyncingAll(true);
    setSyncProgress({ done: 0, total: pending.length });

    let completed = 0;
    try {
      for (const track of pending) {
        if (cancelSyncRef.current) break;
        const streamUrl =
          track.streamUrl ||
          (track.filename ? `/api/stream?file=${encodeURIComponent(track.filename)}` : null);
        if (streamUrl && offlineUrls[streamUrl]) {
          completed += 1;
          setSyncProgress({ done: completed, total: pending.length });
          continue;
        }
        if (streamUrl) {
          await saveUrlToOfflineCache(streamUrl, track);
        } else {
          await startDownload(track, true);
        }
        completed += 1;
        setSyncProgress({ done: completed, total: pending.length });
      }
    } finally {
      noSleepRef.current?.disable();
      setSyncingAll(false);
      cancelSyncRef.current = false;
    }
  }

  // Robust CSV Parser for Exportify / Spotify CSV files (supports ',', ';', '\t', BOM, EN/ES headers, artwork & duration)
  async function handleSpotifyCsvFile(file) {
    if (!file) return;
    setSpotifyMsg({ type: '', text: '' });
    try {
      const rawText = await file.text();
      const text = rawText.replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length < 2) {
        setSpotifyMsg({
          type: 'err',
          text: 'El archivo CSV está vacío o no contiene filas de canciones.'
        });
        return;
      }

      // Auto-detect delimiter from header line (',' vs ';' vs '\t')
      const headerLine = lines[0];
      const commaCount = (headerLine.match(/,/g) || []).length;
      const semiCount = (headerLine.match(/;/g) || []).length;
      const tabCount = (headerLine.match(/\t/g) || []).length;
      const delimiter =
        tabCount > commaCount && tabCount > semiCount
          ? '\t'
          : semiCount > commaCount
          ? ';'
          : ',';

      const parseCsvRow = row => {
        const cols = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          if (ch === '"') {
            if (inQuotes && row[i + 1] === '"') {
              cur += '"';
              i++;
            } else {
              inQuotes = !inQuotes;
            }
          } else if (ch === delimiter && !inQuotes) {
            cols.push(cur.trim());
            cur = '';
          } else {
            cur += ch;
          }
        }
        cols.push(cur.trim());
        return cols.map(c => c.replace(/^["']|["']$/g, '').trim());
      };

      const headers = parseCsvRow(lines[0]).map(h =>
        h
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim()
      );

      let titleIdx = headers.findIndex(
        h =>
          h.includes('track name') ||
          h.includes('nombre de la cancion') ||
          h.includes('nombre de la pista') ||
          h === 'title' ||
          h === 'titulo' ||
          h === 'cancion' ||
          h === 'pista' ||
          h === 'track' ||
          h === 'song' ||
          (h === 'name' && !headers.some(x => x.includes('track name')))
      );

      let artistIdx = headers.findIndex(
        h =>
          h.includes('artist name') ||
          h.includes('nombre del artista') ||
          h.includes('nombres del artista') ||
          h.includes('artista') ||
          h === 'artist' ||
          h === 'artists' ||
          h.includes('interprete')
      );

      const albumIdx = headers.findIndex(
        h => h.includes('album name') || h.includes('nombre del album') || h === 'album'
      );
      const imageIdx = headers.findIndex(
        h => h.includes('image url') || h.includes('imagen') || h === 'artwork' || h === 'cover'
      );
      const durationMsIdx = headers.findIndex(
        h => h.includes('duration') || h.includes('duracion')
      );
      const genreIdx = headers.findIndex(h => h.includes('genre') || h.includes('genero'));

      // Fallback if the CSV has no standard header row or custom 2-column CSV
      let startRow = 1;
      if (titleIdx === -1) {
        if (headers.length >= 1 && headers.length <= 4) {
          titleIdx = 0;
          artistIdx = headers.length >= 2 ? 1 : -1;
        } else {
          setSpotifyMsg({
            type: 'err',
            text: `No se reconoció la columna de canción en «${file.name}». Columnas detectadas: ${headers
              .slice(0, 5)
              .join(', ')}`
          });
          return;
        }
      }

      const formatMs = val => {
        const ms = Number(val);
        if (!ms || isNaN(ms) || ms < 1000) return '—';
        const totalSec = Math.round(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = (totalSec % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
      };

      const imported = [];
      const seen = new Set();

      for (let i = startRow; i < lines.length; i++) {
        const cols = parseCsvRow(lines[i]);
        const title = cols[titleIdx]?.trim();
        const rawArtist = artistIdx >= 0 ? cols[artistIdx]?.trim() || '' : '';
        if (!title) continue;
        const artist = rawArtist.replace(/;/g, ', ') || 'Artista';
        const k = `${title.toLowerCase()}|${artist.toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);

        const imgUrl = imageIdx >= 0 && cols[imageIdx]?.startsWith('http') ? cols[imageIdx] : '/icon.svg';
        const dur = durationMsIdx >= 0 ? formatMs(cols[durationMsIdx]) : '—';

        imported.push({
          id: `csv_${Date.now()}_${i}`,
          title,
          artist,
          album: albumIdx >= 0 && cols[albumIdx] ? cols[albumIdx] : 'Spotify CSV',
          genre: genreIdx >= 0 && cols[genreIdx] ? cols[genreIdx].split(',')[0].trim() : 'Spotify',
          artwork: imgUrl,
          previewUrl: null,
          duration: dur
        });
      }

      if (imported.length === 0) {
        setSpotifyMsg({
          type: 'err',
          text: `No se encontraron canciones válidas dentro de «${file.name}».`
        });
        return;
      }

      const csvName = file.name.replace(/\.csv$/i, '').replace(/_/g, ' ').trim() || 'Spotify CSV';
      openSpotifyImportModal(imported, csvName);
    } catch {
      setSpotifyMsg({
        type: 'err',
        text: 'No se pudo leer el archivo CSV seleccionado.'
      });
    }
  }

  function openSpotifyImportModal(tracks, sourceName = 'Playlist Spotify') {
    if (!tracks || tracks.length === 0) return;
    setPendingSpotifyImport({ tracks, sourceName });
    setSpotifyNewLibName(sourceName);
    setSpotifyMsg({
      type: 'ok',
      text: `Se leyeron ${tracks.length} canciones de «${sourceName}». Elegí dónde guardarlas:`
    });
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
        text: `Listo: se guardaron ${filtered.length} canciones en Favoritos.`
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
          text: `Listo: se creó la librería «${created.name}» con ${freshTracks.length} canciones.`
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
        text: `Listo: se guardaron ${filtered.length} canciones en «${targetPl.name}».`
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

  function buildSmartShuffleOrder(list, startIdx = -1, minArtistDistance = 2) {
    const n = Array.isArray(list) ? list.length : 0;
    if (n <= 1) return n === 1 ? [0] : [];

    const pool = [];
    for (let i = 0; i < n; i++) {
      if (i !== startIdx) pool.push(i);
    }

    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

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

  function playFromList(list, index, startRandom = false) {
    if (!Array.isArray(list) || list.length === 0) return;

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

  // Unified Single-Line Track Row component used in Explore & Libraries
  function renderTrackRow(track, idx, list, contextLib = null) {
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
      contextLib === 'offline' ||
      dl?.status === 'ready' ||
      Boolean(offItem) ||
      Boolean(streamUrl && offlineUrls[streamUrl]);
    const isGreyedOffline = isOffline && !isOfflineReady;
    const isCurrent = currentTrack && String(currentTrack.id) === String(track.id);
    const liked = isLiked(track.id);

    const subtitleParts = [track.artist || 'Artista'];
    if (track.duration && track.duration !== '—') {
      subtitleParts.push(track.duration);
    } else if (
      track.album &&
      track.album !== 'Offline PWA' &&
      track.album !== 'Spotify CSV' &&
      track.album !== 'Guardado en dispositivo'
    ) {
      subtitleParts.push(track.album);
    }

    return (
      <div
        key={`${contextLib || 'exp'}_${track.id}_${idx}`}
        className={`track-row ${isCurrent ? 'playing' : ''} ${
          isGreyedOffline ? 'offline-unavailable' : ''
        }`.trim()}
      >
        <div
          className="track-row-main"
          onClick={() => {
            if (isGreyedOffline) return;
            if (isCurrent) {
              togglePlayPause();
            } else {
              playFromList(list, idx);
            }
          }}
          title={isGreyedOffline ? 'Disponible solo con conexión a internet' : 'Reproducir'}
        >
          <div className="track-cover">
            <img
              src={track.artwork || '/icon.svg'}
              alt=""
              loading="lazy"
              onError={e => {
                e.currentTarget.src = '/icon.svg';
              }}
            />
            <div className="track-cover-overlay">
              <Icon name={isCurrent && isPlaying ? 'pause' : 'play'} size={15} />
            </div>
          </div>

          <div className="track-text">
            <div className="track-title">{track.title}</div>
            <div className="track-sub">
              {isOfflineReady && (
                <span className="offline-inline-dot" title="Descargada en el dispositivo">
                  <Icon name="offline-pin" size={13} />
                </span>
              )}
              <span className="track-sub-text">
                {dl?.status === 'downloading'
                  ? `Descargando ${Math.round(dl.progress || 8)}% · ${track.artist}`
                  : subtitleParts.join(' · ')}
              </span>
            </div>
          </div>
        </div>

        <div className="track-actions">
          <button
            type="button"
            className={`icon-btn ${liked ? 'liked' : ''}`}
            onClick={() => toggleLike(track)}
            aria-label={liked ? 'Quitar de Favoritos' : 'Guardar en Favoritos'}
            title={liked ? 'En Favoritos' : 'Agregar a Favoritos'}
          >
            <Icon name={liked ? 'heart-fill' : 'heart'} size={16} />
          </button>

          {isOfflineReady ? (
            <button
              type="button"
              className="icon-btn offline-done"
              onClick={() => openTrackMenu({ ...track, filename, streamUrl }, contextLib)}
              aria-label="Opciones de pista offline"
              title="Descargada en Offline"
            >
              <Icon name="offline-pin" size={16} />
            </button>
          ) : dl?.status === 'downloading' ? (
            <button type="button" className="icon-btn" disabled aria-label="Descargando">
              <Icon name="loader" size={16} className="spin" />
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn"
              disabled={isOffline}
              onClick={() => startDownload(track)}
              aria-label="Descargar para escuchar sin internet"
              title="Descargar MP3 Offline"
            >
              <Icon name={dl?.status === 'error' ? 'refresh' : 'download'} size={16} />
            </button>
          )}

          <button
            type="button"
            className="icon-btn"
            onClick={() => openTrackMenu({ ...track, filename, streamUrl }, contextLib)}
            aria-label="Más opciones"
            title="Más opciones"
          >
            <Icon name="more" size={16} />
          </button>
        </div>

        {dl?.status === 'downloading' && (
          <div className="track-row-progress">
            <div style={{ width: `${dl.progress || 8}%` }} />
          </div>
        )}
      </div>
    );
  }

  if (!authChecked) {
    return (
      <main className="app-shell">
        <div className="empty" style={{ marginTop: 48 }}>
          <div className="empty-title">mineral music</div>
          <div>Abriendo tu biblioteca…</div>
        </div>
      </main>
    );
  }

  // ==================== UNAUTHENTICATED VIEW ====================
  if (!user) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <BrandMark />
            <span className="brand-word">
              mineral<small className="brand-sub">music</small>
            </span>
          </div>
          <span className="badge lavender">Por invitación</span>
        </header>

        <div className="auth-wrap">
          <div style={{ marginBottom: 16 }}>
            <h1 className="section-bar-title" style={{ fontSize: '1.65rem' }}>
              {authMode === 'login' ? 'Iniciar sesión' : 'Activar invitación'}
            </h1>
            <p className="section-bar-sub">
              {authMode === 'login'
                ? 'Tu música, librerías y descargas offline en cualquier dispositivo.'
                : 'Creá tu cuenta con un código de invitación.'}
            </p>
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
                Entrar
              </button>
              <button
                type="button"
                className={authMode === 'register' ? 'active' : ''}
                onClick={() => {
                  setAuthMode('register');
                  setAuthError('');
                }}
              >
                Código de invitación
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
                        {showPassword ? 'Ocultar' : 'Ver'}
                      </button>
                    </div>
                  </div>

                  <button type="submit" className="btn" disabled={authBusy || isOffline}>
                    {authBusy ? 'Entrando…' : 'Entrar a mineral music'}
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
                    <label htmlFor="signup-username">Usuario</label>
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
                    <label htmlFor="new-password">Contraseña (mín. 6 caracteres)</label>
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
                        {showPassword ? 'Ocultar' : 'Ver'}
                      </button>
                    </div>
                  </div>

                  <button type="submit" className="btn" disabled={authBusy || isOffline}>
                    {authBusy ? 'Activando…' : 'Crear cuenta'}
                  </button>
                </form>
              )}
            </div>

            {offlineCatalog.length > 0 && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ width: '100%' }}
                  onClick={() => {
                    setUser({ username: 'Offline', is_admin: false, offline: true });
                    setActiveTab('library');
                    setSelectedLibrary('offline');
                  }}
                >
                  <Icon name="headphones" size={16} /> Escuchar mis canciones Offline ({offlineCatalog.length})
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ==================== AUTHENTICATED APP SHELL ====================
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
      ? 'Favoritos'
      : selectedLibrary === 'offline'
      ? 'Descargadas (Offline)'
      : activeCustomPlaylist
      ? activeCustomPlaylist.name
      : 'Favoritos';

  const topFrequentArtists = getLikedCategories().slice(0, 5);

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          type="button"
          className="brand"
          onClick={() => setActiveTab(isOffline ? 'library' : 'explore')}
          aria-label="mineral music, inicio"
        >
          <BrandMark />
          <span className="brand-word" aria-hidden="true">
            mineral
            <small className="brand-sub">music</small>
          </span>
        </button>

        <nav className="topbar-nav" aria-label="Principal">
          <button
            type="button"
            className={`nav-link ${activeTab === 'explore' ? 'active' : ''} ${
              isOffline ? 'offline-nav-item' : ''
            }`.trim()}
            onClick={() => setActiveTab('explore')}
          >
            <Icon name="search" size={16} />
            <span>Explorar</span>
          </button>

          <button
            type="button"
            className={`nav-link ${activeTab === 'library' ? 'active' : ''}`}
            onClick={() => setActiveTab('library')}
          >
            <Icon name="heart" size={16} />
            <span>Biblioteca</span>
            {(likedTracks.length + offlineCatalog.length) > 0 && (
              <span className="nav-badge">{likedTracks.length || offlineCatalog.length}</span>
            )}
          </button>
        </nav>

        <div className="topbar-right">
          {isOffline && (
            <span className="badge lavender" title="Sin conexión a internet">
              <Icon name="wifi-off" size={12} /> Offline
            </span>
          )}

          <div className="account" ref={accountRef}>
            <button
              type="button"
              className="account-btn"
              onClick={() => setAccountOpen(o => !o)}
              aria-expanded={accountOpen}
              aria-label="Cuenta y ajustes"
              title={user.username}
            >
              <span className="account-avatar">{initial}</span>
            </button>

            {accountOpen && (
              <div className="account-menu" role="menu">
                <div className="account-meta">
                  <span className="account-user">@{user.username}</span>
                  <span className={`badge ${user.is_admin ? 'lavender' : 'lime'}`}>
                    {user.is_admin ? 'Admin' : 'Miembro'}
                  </span>
                </div>

                <button
                  type="button"
                  className={`account-item ${activeTab === 'settings' ? 'active' : ''}`.trim()}
                  onClick={() => {
                    setActiveTab('settings');
                    setAccountOpen(false);
                  }}
                >
                  <Icon name="settings" size={16} />
                  <span>Ajustes</span>
                </button>

                {user.is_admin && (
                  <button
                    type="button"
                    className={`account-item ${activeTab === 'admin' ? 'active' : ''} ${
                      isOffline ? 'offline-section-disabled' : ''
                    }`.trim()}
                    onClick={() => {
                      setActiveTab('admin');
                      setAccountOpen(false);
                      if (!isOffline) fetchAdminData();
                    }}
                  >
                    <Icon name="shield" size={16} />
                    <span>Admin</span>
                  </button>
                )}

                {deferredPrompt && (
                  <button type="button" className="account-item" onClick={handleInstallPwa}>
                    <Icon name="smartphone" size={16} />
                    <span>Instalar app</span>
                  </button>
                )}

                <div className="account-menu-last">
                  <button type="button" className="account-item danger" onClick={handleLogout}>
                    <span>Cerrar sesión</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="main-container">

      {isOffline && (
        <div className="offline-pill-bar">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Icon name="wifi-off" size={15} />
            <span>Modo sin conexión · Reproduciendo música guardada en tu dispositivo</span>
          </span>
          <div className="offline-pill-actions">
            {activeTab !== 'library' || selectedLibrary !== 'offline' ? (
              <button
                type="button"
                onClick={() => {
                  setActiveTab('library');
                  setSelectedLibrary('offline');
                }}
              >
                Mis Offline ({offlineCatalog.length})
              </button>
            ) : null}
            <button type="button" onClick={() => verifyInternetConnection()}>
              Reconectar
            </button>
          </div>
        </div>
      )}

      {/* ==================== TAB 1: EXPLORAR ==================== */}
      {activeTab === 'explore' && (
        <section>
          <form
            className={`search-bar ${isOffline ? 'offline-section-disabled' : ''}`.trim()}
            onSubmit={e => {
              e.preventDefault();
              if (!isOffline && query.trim()) {
                setActiveChip('');
                searchTracks(query);
              }
            }}
          >
            <Icon name="search" size={16} className="search-icon" />
            <input
              type="search"
              className="search-input"
              enterKeyHint="search"
              placeholder={
                isOffline
                  ? 'Sin conexión a internet…'
                  : '¿Qué querés escuchar hoy? Canción, artista o álbum…'
              }
              value={query}
              onChange={e => setQuery(e.target.value)}
              disabled={isOffline}
            />
            {query && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  setQuery('');
                  setActiveChip('for-you');
                  loadRecommendedOrRandomFeed(likedTracks, false);
                }}
                aria-label="Limpiar búsqueda"
              >
                <Icon name="close" size={15} />
              </button>
            )}
            <button type="submit" className="btn sm" disabled={loading || isOffline}>
              {loading ? '…' : 'Buscar'}
            </button>
          </form>

          {/* Horizontal Category / Mood Strip */}
          <div className={`chip-Strip ${isOffline ? 'offline-section-disabled' : ''}`.trim()}>
            {EXPLORE_CHIPS.map(chip => (
              <button
                key={chip.id}
                type="button"
                className={`chip-pill ${activeChip === chip.id ? 'active' : ''}`}
                disabled={isOffline}
                onClick={() => {
                  setQuery('');
                  setActiveChip(chip.id);
                  if (chip.id === 'for-you') {
                    loadRecommendedOrRandomFeed(likedTracks, false);
                  } else {
                    searchTracks(chip.term, { mode: 'genre', label: chip.label });
                  }
                }}
              >
                {chip.label}
              </button>
            ))}

            {topFrequentArtists.map(artist => (
              <button
                key={artist}
                type="button"
                className={`chip-pill ${activeChip === `artist_${artist}` ? 'active' : ''}`}
                disabled={isOffline}
                onClick={() => {
                  setQuery('');
                  setActiveChip(`artist_${artist}`);
                  searchTracks(artist, { mode: 'artist', label: artist });
                }}
              >
                {artist}
              </button>
            ))}
          </div>

          {/* Clean Section Header (No debug badges!) */}
          <div className="section-bar">
            <div>
              <h1 className="section-bar-title">
                {feedInfo.mode === 'search'
                  ? `Resultados para «${feedInfo.label}»`
                  : feedInfo.mode === 'genre' || feedInfo.mode === 'artist'
                  ? feedInfo.label
                  : likedTracks.length > 0 || customPlaylists.length > 0
                  ? 'Recomendado para vos'
                  : 'Descubrimiento del día'}
              </h1>
              <p className="section-bar-sub">
                {feedInfo.mode === 'search'
                  ? `${results.length} canciones encontradas`
                  : feedInfo.mode === 'recommended' && feedInfo.label
                  ? `Inspirado en ${feedInfo.label}`
                  : 'Tocá cualquier canción para reproducir o descargar en Offline'}
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {results.length > 0 && (
                <button
                  type="button"
                  className="icon-btn"
                  disabled={isOffline}
                  onClick={() => playFromList(results, 0, true)}
                  title="Reproducir mezcla aleatoria"
                >
                  <Icon name="shuffle" size={16} />
                </button>
              )}
              <button
                type="button"
                className="icon-btn"
                disabled={loading || isOffline}
                onClick={() =>
                  activeChip === 'for-you'
                    ? loadRecommendedOrRandomFeed(likedTracks, false)
                    : loadRecommendedOrRandomFeed(likedTracks, true)
                }
                title="Actualizar recomendaciones"
              >
                <Icon name="refresh" size={16} className={loading ? 'spin' : ''} />
              </button>
            </div>
          </div>

          {results.length === 0 ? (
            <div className="empty">
              <div className="empty-title">
                {loading ? 'Cargando recomendaciones…' : 'Sin resultados por ahora'}
              </div>
              <p>Probá buscando otro artista o tocá actualizar.</p>
            </div>
          ) : (
            <div className="track-list">
              {results.map((track, idx) => renderTrackRow(track, idx, results, null))}
            </div>
          )}
        </section>
      )}

      {/* ==================== TAB 2: BIBLIOTECA (FAVORITOS / OFFLINE / PROPIAS) ==================== */}
      {activeTab === 'library' && (
        <section>
          <div className="library-switcher" role="tablist" aria-label="Tus librerías">
            <button
              type="button"
              className={`library-pill ${selectedLibrary === 'liked' ? 'active' : ''}`}
              onClick={() => setSelectedLibrary('liked')}
            >
              <Icon name="heart-fill" size={13} />
              <span>Favoritos</span>
              <span className="library-pill-count">{likedTracks.length}</span>
            </button>

            <button
              type="button"
              className={`library-pill ${selectedLibrary === 'offline' ? 'active' : ''}`}
              onClick={() => setSelectedLibrary('offline')}
            >
              <Icon name="offline-pin" size={13} />
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
                <Icon name="folder" size={13} />
                <span>{pl.name}</span>
                <span className="library-pill-count">{pl.tracks.length}</span>
              </button>
            ))}

            <button
              type="button"
              className="library-pill"
              onClick={() => setCreatingPlaylist(v => !v)}
              title="Crear nueva librería"
            >
              <Icon name={creatingPlaylist ? 'close' : 'plus'} size={13} />
              <span>{creatingPlaylist ? 'Cancelar' : 'Nueva'}</span>
            </button>
          </div>

          {creatingPlaylist && (
            <form
              className="search-bar"
              style={{ marginBottom: 12 }}
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
                placeholder="Nombre de la librería (ej. Entrenamiento, Viaje)…"
                value={newPlaylistName}
                onChange={e => setNewPlaylistName(e.target.value)}
                required
              />
              <button type="submit" className="btn sm">
                Crear
              </button>
            </form>
          )}

          {/* Sleek Spotify/Apple-Music-style Playlist Header */}
          <div className="playlist-header">
            <div className="playlist-header-info">
              <h1 className="playlist-header-title">{activeLibraryTitle}</h1>
              <div className="playlist-header-meta">
                {activeLibraryTracks.length}{' '}
                {activeLibraryTracks.length === 1 ? 'canción' : 'canciones'}
                {syncingAll && syncProgress.total > 0
                  ? ` · Descargando ${syncProgress.done}/${syncProgress.total} · Pantalla activa (tocá para pausar)`
                  : selectedLibrary === 'offline' && deviceQuota
                  ? ` · ${deviceQuota.usedMB} MB en dispositivo`
                  : isOffline && playableActiveLibraryTracks.length < activeLibraryTracks.length
                  ? ` · ${playableActiveLibraryTracks.length} disponibles sin red`
                  : ''}
              </div>
            </div>

            <div className="playlist-header-actions">
              <button
                type="button"
                className={`icon-btn ${shuffle ? 'active' : ''}`}
                onClick={() => setShuffle(s => !s)}
                title={shuffle ? 'Aleatorio activado' : 'Activar aleatorio'}
              >
                <Icon name="shuffle" size={17} />
              </button>

              <button
                type="button"
                className={`icon-btn ${repeatMode !== 'off' ? 'active' : ''}`}
                onClick={cycleRepeatMode}
                title="Modo repetición"
              >
                <Icon name={repeatMode === 'one' ? 'repeat-1' : 'repeat'} size={17} />
              </button>

              {selectedLibrary !== 'offline' && activeLibraryTracks.length > 0 && (
                <button
                  type="button"
                  className={`icon-btn ${syncingAll ? 'active' : ''}`}
                  disabled={isOffline}
                  onClick={() => downloadCollectionForOffline(activeLibraryTracks)}
                  title={
                    syncingAll
                      ? `Pausar cola (${syncProgress.done}/${syncProgress.total})`
                      : 'Descargar toda esta librería a Offline'
                  }
                >
                  <Icon
                    name={syncingAll ? 'loader' : 'download'}
                    size={17}
                    className={syncingAll ? 'spin' : ''}
                  />
                </button>
              )}

              {activeCustomPlaylist && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => deleteCustomPlaylist(activeCustomPlaylist.id)}
                  title="Eliminar esta librería"
                >
                  <Icon name="trash" size={16} />
                </button>
              )}

              <button
                type="button"
                className="icon-btn play-circle"
                disabled={playableActiveLibraryTracks.length === 0}
                onClick={() => playFromList(activeLibraryTracks, 0)}
                title="Reproducir librería"
              >
                <Icon name="play" size={18} />
              </button>
            </div>
          </div>

          {activeLibraryTracks.length === 0 ? (
            <div className="empty">
              <div className="empty-title">Sin canciones todavía</div>
              <p>
                {selectedLibrary === 'liked'
                  ? 'Tocá el corazón en cualquier canción para sumarla a Favoritos.'
                  : selectedLibrary === 'offline'
                  ? 'Las canciones que descargues aparecerán acá para escuchar sin internet.'
                  : 'Usá el menú (⋯) en cualquier canción para guardarla en esta librería.'}
              </p>
            </div>
          ) : (
            <div className="track-list">
              {activeLibraryTracks.map((track, idx) =>
                renderTrackRow(track, idx, activeLibraryTracks, selectedLibrary)
              )}
            </div>
          )}
        </section>
      )}

      {/* ==================== AJUSTES & SPOTIFY SYNC ==================== */}
      {activeTab === 'settings' && (
        <section>
          <div className="section-bar">
            <div>
              <h1 className="section-bar-title">Ajustes y sincronización</h1>
              <p className="section-bar-sub">
                Importá colecciones desde Spotify o CSV y administrá tu espacio Offline.
              </p>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
              <div>
                <div className="track-title" style={{ fontSize: '1rem' }}>
                  Importar desde Spotify
                </div>
                <div className="section-bar-sub">
                  Pegá un link público de Spotify o subí tu archivo <code>.csv</code> de Exportify. Podrás elegir en qué librería guardarlo.
                </div>
              </div>
              <span className="badge lime">Sync</span>
            </div>

            {spotifyMsg.text && (
              <div className={`alert ${spotifyMsg.type === 'err' ? 'err' : 'ok'}`}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <span>{spotifyMsg.text}</span>
                  {spotifyMsg.type === 'ok' && !pendingSpotifyImport && (
                    <button
                      type="button"
                      className="btn secondary sm"
                      onClick={() => setActiveTab('library')}
                    >
                      Ver en Biblioteca <Icon name="arrow-right" size={13} />
                    </button>
                  )}
                </div>
              </div>
            )}

            <form
              className={`search-bar ${isOffline ? 'offline-section-disabled' : ''}`.trim()}
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

            {/* CSV Upload works even offline because it parses locally! */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 10,
                fontSize: '0.8rem',
                color: 'var(--muted)'
              }}
            >
              <span>
                ¿Tenés un archivo <code>.csv</code> de{' '}
                <a
                  href="https://exportify.net"
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: 'underline', fontWeight: 700 }}
                >
                  exportify.net
                </a>
                ?
              </span>
              <label className="btn secondary sm" style={{ cursor: 'pointer' }}>
                <Icon name="folder" size={14} /> Subir CSV de Spotify
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain,application/vnd.ms-excel"
                  style={{ display: 'none' }}
                  onChange={async e => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) {
                      await handleSpotifyCsvFile(file);
                    }
                  }}
                />
              </label>
            </div>

            {/* Inline destination picker so mobile browsers that block <dialog> after file input still work 100% */}
            {pendingSpotifyImport && (
              <div className="import-destination-box">
                <div className="dialog-head" style={{ marginBottom: 8 }}>
                  <div>
                    <div className="dialog-title">
                      ¿En qué librería querés guardar estas {pendingSpotifyImport.tracks.length} canciones?
                    </div>
                    <div className="dialog-sub">
                      Origen: «{pendingSpotifyImport.sourceName}»
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={closeSpotifyImportModal}
                    title="Cancelar"
                  >
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
                      <Icon name="heart-fill" size={14} /> Guardar en Favoritos (Con corazón)
                    </span>
                    <Icon name="arrow-right" size={14} />
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
                      <Icon name="arrow-right" size={14} />
                    </button>
                  ))}
                </div>

                <form
                  className="search-bar"
                  style={{ marginTop: 8, marginBottom: 0 }}
                  onSubmit={e => {
                    e.preventDefault();
                    confirmSpotifyImport('new_playlist', spotifyNewLibName);
                  }}
                >
                  <input
                    type="text"
                    className="search-input"
                    placeholder="O escribir nombre de nueva librería…"
                    value={spotifyNewLibName}
                    onChange={e => setSpotifyNewLibName(e.target.value)}
                    required
                  />
                  <button type="submit" className="btn sm">
                    <Icon name="plus" size={13} /> Crear y guardar
                  </button>
                </form>
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div className="track-title" style={{ fontSize: '1rem' }}>
                  Almacenamiento Offline
                </div>
                <div className="section-bar-sub">
                  {deviceQuota
                    ? `${deviceQuota.usedMB} MB usados de ~${deviceQuota.quotaGB} GB (${offlineCatalog.length} canciones en caché).`
                    : `${offlineCatalog.length} canciones guardadas en este dispositivo.`}
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
                  <Icon name="trash" size={14} /> Vaciar Offline
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ==================== TAB 5: ADMIN PANEL ==================== */}
      {activeTab === 'admin' && user.is_admin && (
        <section className={isOffline ? 'offline-section-disabled' : ''}>
          <div className="section-bar">
            <div>
              <h1 className="section-bar-title">Administración</h1>
              <p className="section-bar-sub">
                Códigos de invitación, usuarios y estado del servidor.
              </p>
            </div>
          </div>

          <div className="grid three" style={{ marginBottom: 16 }}>
            <div className="stat">
              <div className="stat-label">Usuarios</div>
              <div className="stat-value">{adminData.users.length}</div>
              <div className="stat-hint">
                {adminData.users.filter(u => u.active).length} activos
              </div>
            </div>

            <div className="stat">
              <div className="stat-label">Invitaciones</div>
              <div className="stat-value">
                {adminData.invites.filter(i => !i.revoked && i.used_count < i.max_uses).length}
              </div>
              <div className="stat-hint">Disponibles</div>
            </div>

            <div className="stat full-mobile">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div className="stat-label">Disco VPS (Puente temporal)</div>
                  <div className="stat-value">
                    {adminData.storage
                      ? `${adminData.storage.usedMB} / ${adminData.storage.maxMB} MB`
                      : '—'}
                  </div>
                </div>
                <div className="stat-hint" style={{ fontWeight: 700 }}>
                  {adminData.storage ? `${adminData.storage.fileCount} archivos en cola` : 'Calculando…'}
                </div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="track-title" style={{ fontSize: '1rem', marginBottom: 10 }}>
              Crear código de invitación
            </div>
            {adminMsg && <div className="alert ok">{adminMsg}</div>}
            <form className="form" onSubmit={handleCreateInvite}>
              <div className="grid two">
                <div className="field">
                  <label htmlFor="invite-label">Etiqueta</label>
                  <input
                    id="invite-label"
                    type="text"
                    placeholder="Ej. Amigos, Móvil…"
                    value={inviteLabel}
                    onChange={e => setInviteLabel(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="invite-uses">Usos permitidos</label>
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
                <button type="submit" className="btn sm">
                  <Icon name="plus" size={14} /> Generar código
                </button>
              </div>
            </form>
          </div>

          <div className="track-list" style={{ marginBottom: 16 }}>
            {adminData.invites.map(inv => {
              const exhausted = inv.used_count >= inv.max_uses;
              return (
                <div key={inv.code} className="track-row">
                  <div className="track-text">
                    <div className="track-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="code-pill">{inv.code}</span>
                      <span>{inv.label}</span>
                    </div>
                    <div className="track-sub">
                      Usos: {inv.used_count}/{inv.max_uses} ·{' '}
                      {inv.revoked ? 'Revocado' : exhausted ? 'Agotado' : 'Activo'}
                    </div>
                  </div>
                  <div className="track-actions">
                    <button
                      type="button"
                      className="btn secondary sm"
                      onClick={() => copyInviteCode(inv.code)}
                    >
                      {copiedCode === inv.code ? 'Copiado' : 'Copiar'}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => handleAdminAction({ action: 'delete_invite', code: inv.code })}
                      title="Eliminar invitación"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      </main>

      {/* ==================== DIALOG 1: TRACK OPTIONS SHEET (⋯) ==================== */}
      <dialog
        ref={menuDialogRef}
        closedby="any"
        className="save-dialog"
        aria-labelledby="track-menu-title"
        onClose={() => setMenuTrack(null)}
      >
        {menuTrack?.track && (
          <div>
            <div className="dialog-head">
              <div style={{ minWidth: 0 }}>
                <div id="track-menu-title" className="dialog-title">
                  {menuTrack.track.title}
                </div>
                <div className="dialog-sub">{menuTrack.track.artist}</div>
              </div>
              <button type="button" className="icon-btn" onClick={closeTrackMenu}>
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="dialog-list">
              <button
                type="button"
                className="dialog-option"
                onClick={() => {
                  toggleLike(menuTrack.track);
                  closeTrackMenu();
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Icon
                    name={isLiked(menuTrack.track.id) ? 'heart-fill' : 'heart'}
                    size={15}
                  />
                  {isLiked(menuTrack.track.id)
                    ? 'Quitar de Favoritos'
                    : 'Agregar a Favoritos'}
                </span>
              </button>

              <button
                type="button"
                className="dialog-option"
                onClick={() => openSaveModal(menuTrack.track)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="folder" size={15} /> Guardar en una librería…
                </span>
                <Icon name="arrow-right" size={14} />
              </button>

              {isTrackAvailableOffline(menuTrack.track) ? (
                <button
                  type="button"
                  className="dialog-option"
                  onClick={() => {
                    exportTrackFile(menuTrack.track.filename, menuTrack.track.streamUrl);
                    closeTrackMenu();
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="file-audio" size={15} /> Exportar archivo MP3 al dispositivo
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  className="dialog-option"
                  disabled={isOffline}
                  onClick={() => {
                    startDownload(menuTrack.track);
                    closeTrackMenu();
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="download" size={15} /> Descargar para escuchar Offline
                  </span>
                </button>
              )}

              {menuTrack.contextLibrary &&
                menuTrack.contextLibrary !== 'offline' &&
                menuTrack.contextLibrary !== 'liked' && (
                  <button
                    type="button"
                    className="dialog-option danger"
                    onClick={() => {
                      removeTrackFromPlaylist(menuTrack.contextLibrary, menuTrack.track.id);
                      closeTrackMenu();
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Icon name="trash" size={15} /> Quitar de esta librería
                    </span>
                  </button>
                )}

              {isTrackAvailableOffline(menuTrack.track) && (
                <button
                  type="button"
                  className="dialog-option danger"
                  onClick={() => {
                    deleteOfflineTrack(menuTrack.track);
                    closeTrackMenu();
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="trash" size={15} /> Borrar descarga Offline del dispositivo
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
      </dialog>

      {/* ==================== DIALOG 2: SAVE TRACK TO LIBRARY ==================== */}
      <dialog
        ref={saveDialogRef}
        closedby="any"
        className="save-dialog"
        aria-labelledby="save-dialog-title"
        onClose={() => setTrackToSave(null)}
      >
        {trackToSave && (
          <div>
            <div className="dialog-head">
              <div style={{ minWidth: 0 }}>
                <div id="save-dialog-title" className="dialog-title">
                  Guardar en librería
                </div>
                <div className="dialog-sub">
                  {trackToSave.title} · {trackToSave.artist}
                </div>
              </div>
              <button type="button" className="icon-btn" onClick={closeSaveModal}>
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="dialog-list">
              <button
                type="button"
                className={`dialog-option ${isLiked(trackToSave.id) ? 'selected' : ''}`}
                onClick={() => toggleLike(trackToSave)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Icon name="heart-fill" size={14} /> Favoritos
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
                <Icon name="plus" size={13} /> Crear
              </button>
            </form>
          </div>
        )}
      </dialog>

      {/* ==================== DIALOG 3: SPOTIFY IMPORT DESTINATION MODAL ==================== */}
      <dialog
        ref={spotifyDialogRef}
        closedby="any"
        className="save-dialog"
        aria-labelledby="spotify-dialog-title"
      >
        {pendingSpotifyImport && (
          <div>
            <div className="dialog-head">
              <div style={{ minWidth: 0 }}>
                <div id="spotify-dialog-title" className="dialog-title">
                  ¿Dónde guardar la importación?
                </div>
                <div className="dialog-sub">
                  {pendingSpotifyImport.tracks.length} canciones de «{pendingSpotifyImport.sourceName}»
                </div>
              </div>
              <button type="button" className="icon-btn" onClick={closeSpotifyImportModal}>
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="dialog-list">
              <button
                type="button"
                className="dialog-option selected"
                onClick={() => confirmSpotifyImport('liked')}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Icon name="heart-fill" size={14} /> Guardar en Favoritos (Me gusta)
                </span>
                <Icon name="arrow-right" size={14} />
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
                  <Icon name="arrow-right" size={14} />
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
                <Icon name="plus" size={13} /> Crear y guardar
              </button>
            </form>
          </div>
        )}
      </dialog>

      {/* ==================== COMPACT FLOATING MINI-PLAYER DOCK ==================== */}
      {currentTrack && (
        <div className="player-dock">
          <div className="player-scrubber">
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

          <div className="player-main">
            <div className="player-track">
              <img
                src={currentTrack.artwork || '/icon.svg'}
                alt=""
                onError={e => {
                  e.currentTarget.src = '/icon.svg';
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div className="player-track-title">{currentTrack.title}</div>
                <div className="player-track-sub">{currentTrack.artist}</div>
              </div>
            </div>

            <div className="player-controls">
              <button
                type="button"
                className={`ctrl-btn ${isLiked(currentTrack.id) ? 'active' : ''}`}
                onClick={() => toggleLike(currentTrack)}
                title="Favorito"
              >
                <Icon name={isLiked(currentTrack.id) ? 'heart-fill' : 'heart'} size={15} />
              </button>
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
                <Icon name={isPlaying ? 'pause' : 'play'} size={15} />
              </button>
              <button type="button" className="ctrl-btn" onClick={playNext} title="Siguiente">
                <Icon name="skip-forward" size={15} />
              </button>
              <button
                type="button"
                className={`ctrl-btn ${repeatMode !== 'off' ? 'active' : ''}`}
                onClick={cycleRepeatMode}
                title="Repetir"
              >
                <Icon name={repeatMode === 'one' ? 'repeat-1' : 'repeat'} size={15} />
              </button>
            </div>
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

      {/* ==================== MOBILE BOTTOM NAV (MINERAL TAREAS STYLE) ==================== */}
      <nav className="bottom-nav" aria-label="Principal">
        <button
          type="button"
          className={`${activeTab === 'explore' ? 'active' : ''} ${
            isOffline ? 'offline-nav-item' : ''
          }`.trim()}
          aria-current={activeTab === 'explore' ? 'page' : undefined}
          onClick={() => setActiveTab('explore')}
        >
          <Icon name="search" size={18} />
          <span>Explorar</span>
        </button>

        <button
          type="button"
          className={activeTab === 'library' ? 'active' : ''}
          aria-current={activeTab === 'library' ? 'page' : undefined}
          onClick={() => setActiveTab('library')}
        >
          <Icon name="heart" size={18} />
          <span>Biblioteca</span>
        </button>
      </nav>
    </div>
  );
}
