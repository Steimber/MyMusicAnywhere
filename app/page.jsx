'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { buildSmartShuffleOrder, getShuffleTrackKey } from '../lib/shuffle';
import { normalizeTombstoneList } from '../lib/collections-merge';
import { getHourBucketName } from '../lib/listening-shared';
import SettingsPanel from './components/SettingsPanel';
import AdminPanel from './components/AdminPanel';
import ForYouPanel from './components/ForYouPanel';
import AuthScreen from './components/AuthScreen';
import AppDialogs from './components/AppDialogs';
import PlayerDock, { AppTopbar } from './components/PlayerDock';
import ExploreSection from './components/ExploreSection';
import LibrarySection from './components/LibrarySection';
import { Icon } from './components/Icons';
import { useCloudSync } from './hooks/useCloudSync';
import { usePlaylistsAndLibrary } from './hooks/usePlaylistsAndLibrary';
import { useDownloadQueue } from './hooks/useDownloadQueue';
import { useExploreSearch } from './hooks/useExploreSearch';
import {
  AUDIO_CACHE_NAME,
  SHELL_CACHE_NAME,
  DEFAULT_TRACK_COVER,
  FORYOU_RECS_STORAGE_KEY,
  USER_STORAGE_KEY,
  LIKES_STORAGE_KEY,
  DELETED_LIKES_STORAGE_KEY,
  OFFLINE_CATALOG_KEY,
  PLAYLISTS_STORAGE_KEY,
  DELETED_PLAYLISTS_STORAGE_KEY,
  COLLECTIONS_VERSION_KEY_PREFIX,
  isPlaceholderCover,
  compressArtworkUrl,
  getTrackDedupKey,
  deduplicateTracksList,
  sanitizeLikedTracksList
} from './hooks/trackUtils';

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
  const [activeTab, rawSetActiveTab] = useState('explore');
  const [selectedLibrary, rawSetSelectedLibrary] = useState('liked');

  const setActiveTab = nextTab => {
    if (
      typeof document !== 'undefined' &&
      typeof document.startViewTransition === 'function' &&
      typeof window !== 'undefined' &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    ) {
      try {
        document.startViewTransition(() => {
          flushSync(() => {
            rawSetActiveTab(nextTab);
          });
        });
        return;
      } catch {}
    }
    rawSetActiveTab(nextTab);
  };

  const setSelectedLibrary = nextLib => {
    if (
      typeof document !== 'undefined' &&
      typeof document.startViewTransition === 'function' &&
      typeof window !== 'undefined' &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    ) {
      try {
        document.startViewTransition(() => {
          flushSync(() => {
            rawSetSelectedLibrary(nextLib);
          });
        });
        return;
      } catch {}
    }
    rawSetSelectedLibrary(nextLib);
  };

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
  const [libraryQuery, setLibraryQuery] = useState('');
  const [coverSync, setCoverSync] = useState({ active: false, done: 0, total: 0 });
  const enrichedArtworkRef = useRef(new Set());
  const enrichingBusyRef = useRef(false);
  const cancelCoverSyncRef = useRef(false);

  // Dialogs: Track options menu ('⋯'), Save-to-Library, Spotify Import Destination, Download Prompt, YouTube Link, Metadata Edit
  const [menuTrack, setMenuTrack] = useState(null); // { track, contextLibrary }
  const [trackToSave, setTrackToSave] = useState(null);
  const [downloadPrompt, setDownloadPrompt] = useState(null); // { track, list, idx }
  const [editingTrack, setEditingTrack] = useState(null);
  const [editForm, setEditForm] = useState({
    title: '',
    artist: '',
    album: '',
    refreshCover: false
  });
  const [modalNewPlaylistName, setModalNewPlaylistName] = useState('');
  const [ytModalOpen, setYtModalOpen] = useState(false);
  const [ytLinkUrl, setYtLinkUrl] = useState('');
  const [ytLinkPreview, setYtLinkPreview] = useState(null);
  const [ytLinkLoading, setYtLinkLoading] = useState(false);
  const [ytLinkStage, setYtLinkStage] = useState('idle');
  const [ytLinkProgress, setYtLinkProgress] = useState(0);
  const [ytLinkNotice, setYtLinkNotice] = useState('');
  const [ytLinkReadyTrack, setYtLinkReadyTrack] = useState(null);
  const [ytLinkError, setYtLinkError] = useState('');
  const [ytLinkTargetLib, setYtLinkTargetLib] = useState('offline');
  const menuDialogRef = useRef(null);
  const saveDialogRef = useRef(null);
  const spotifyDialogRef = useRef(null);
  const downloadDialogRef = useRef(null);
  const ytDialogRef = useRef(null);
  const editDialogRef = useRef(null);
  const ytPreviewReqIdRef = useRef(0);

  // Downloads, Persistent Storage & Cloud Sync
  const [downloads, setDownloads] = useState({});
  const [libraryFiles, setLibraryFiles] = useState([]);
  const [offlineUrls, setOfflineUrls] = useState({});
  const [deviceQuota, setDeviceQuota] = useState(null);
  const [storagePersisted, setStoragePersisted] = useState('prompt');
  const [storagePersistMsg, setStoragePersistMsg] = useState('');
  const [syncState, setSyncState] = useState({ status: 'idle', updatedAt: null });
  const [syncConflictNotice, setSyncConflictNotice] = useState('');
  const [listeningEntries, setListeningEntries] = useState({});
  const [forYouRecommendations, setForYouRecommendations] = useState([]);
  const [forYouRefreshNonce, setForYouRefreshNonce] = useState(0);
  const [forYouRefreshing, setForYouRefreshing] = useState(false);
  const [forYouSavedMap, setForYouSavedMap] = useState({});
  const forYouLastFetchKeyRef = useRef('');
  const [backupMsg, setBackupMsg] = useState({ type: '', text: '' });
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncProgress, setSyncProgress] = useState({ done: 0, total: 0 });
  const [ownUploadState, setOwnUploadState] = useState({ busy: false, type: '', text: '' });
  const ownUploadInputLibRef = useRef(null);
  const ownUploadInputExpRef = useRef(null);
  const cancelSyncRef = useRef(false);
  const noSleepRef = useRef(null);

  // Settings: Spotify Importer
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [spotifyMsg, setSpotifyMsg] = useState({ type: '', text: '' });
  const [pendingSpotifyImport, setPendingSpotifyImport] = useState(null);
  const [spotifyNewLibName, setSpotifyNewLibName] = useState('');

  // Admin Panel & YouTube Cookies
  const [adminData, setAdminData] = useState({
    users: [],
    invites: [],
    storage: null,
    ytCookies: null,
    youtube: null
  });
  const [inviteLabel, setInviteLabel] = useState('');
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [adminMsg, setAdminMsg] = useState('');
  const [copiedCode, setCopiedCode] = useState('');
  const [ytCookiesText, setYtCookiesText] = useState('');
  const [ytCookiesBusy, setYtCookiesBusy] = useState(false);
  const [ytCookiesMsg, setYtCookiesMsg] = useState({ type: '', text: '' });

  // PWA Install Prompt
  const [deferredPrompt, setDeferredPrompt] = useState(null);

  // Audio Player State (high-frequency timeupdate progress lives in <PlayerScrubber /> to avoid page re-renders)
  const [queue, setQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [optimisticTrack, setOptimisticTrack] = useState(null);
  const [shuffle, setShuffle] = useState(true);
  const [repeatMode, setRepeatMode] = useState('off');

  const audioRef = useRef(null);
  const accountRef = useRef(null);
  const shuffleStateRef = useRef({ order: [], pos: -1, queueLen: 0 });
  const recentPlayedKeysRef = useRef([]);
  const queueRef = useRef([]);
  const currentIndexRef = useRef(-1);
  const isPlayingRef = useRef(false);
  const shuffleRef = useRef(true);
  const repeatModeRef = useRef('off');
  const likedTracksRef = useRef([]);
  const customPlaylistsRef = useRef([]);
  const userRef = useRef(null);
  const isOfflineRef = useRef(false);
  const collectionsHydratedForUserRef = useRef('');
  const collectionsVersionRef = useRef(0);
  const deletedLikesRef = useRef([]);
  const deletedPlaylistsRef = useRef([]);
  const reconcilingCollectionsRef = useRef(false);
  const pendingSaveAfterReconcileRef = useRef(false);
  const pushInFlightRef = useRef(false);
  const lastFocusReconcileAtRef = useRef(0);
  const syncDebounceTimerRef = useRef(null);
  const listeningStateRef = useRef({
    userId: '',
    version: 0,
    syncedEntries: {},
    pendingDelta: {}
  });
  const listeningSyncTimerRef = useRef(null);
  const listeningPushInFlightRef = useRef(false);
  const playbackSessionRef = useRef({
    trackId: '',
    lastTimeSec: 0,
    listenedSec: 0,
    durationSec: 0,
    playCounted: false,
    completeCounted: false,
    skipCounted: false,
    hourBucket: 'tarde'
  });
  const blobUrlCacheRef = useRef(new Map());
  const inflightBlobPromisesRef = useRef(new Map());
  const cachedStreamKeysRef = useRef(new Map());
  const audioCachePromiseRef = useRef(null);
  const warmingInProgressRef = useRef(false);
  const playInFlightRef = useRef(false);
  const consecutivePlayFailuresRef = useRef(0);
  const lastWarmedKeyRef = useRef('');
  const lastDirectPlayRef = useRef({ index: -1, id: '', src: '' });
  const wasOfflineRef = useRef(false);
  const probeInFlightRef = useRef(false);

  queueRef.current = queue;
  currentIndexRef.current = currentIndex;
  isPlayingRef.current = isPlaying;
  shuffleRef.current = shuffle;
  repeatModeRef.current = repeatMode;
  likedTracksRef.current = likedTracks;
  customPlaylistsRef.current = customPlaylists;
  userRef.current = user;
  isOfflineRef.current = isOffline;

  const currentTrack = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

  const offlineLookup = useMemo(() => {
    const byId = new Map();
    const byFile = new Map();
    const byDedup = new Map();
    for (const t of offlineCatalog) {
      if (!t) continue;
      if (t.id != null) byId.set(String(t.id), t);
      if (t.filename) byFile.set(t.filename, t);
      const dk = getTrackDedupKey(t);
      if (dk && !byDedup.has(dk)) byDedup.set(dk, t);
    }
    return { byId, byFile, byDedup };
  }, [offlineCatalog]);

  const likedLookup = useMemo(() => {
    const byId = new Map();
    const byDedup = new Map();
    for (const t of likedTracks) {
      if (!t) continue;
      if (t.id != null) byId.set(String(t.id), t);
      const dk = getTrackDedupKey(t);
      if (dk && !byDedup.has(dk)) byDedup.set(dk, t);
    }
    return { byId, byDedup };
  }, [likedTracks]);

  const apiRef = useRef({});

  function findOfflineItem(track) {
    if (!track) return null;
    return (
      offlineLookup.byId.get(String(track.id)) ||
      (track.filename ? offlineLookup.byFile.get(track.filename) : null) ||
      offlineLookup.byDedup.get(getTrackDedupKey(track)) ||
      null
    );
  }

  const {
    ensurePersistentStorage,
    persistDeletedLikes,
    persistDeletedPlaylists,
    pushCollectionsToServerNow,
    scheduleCollectionsSync,
    reconcileCollectionsOnAppReturn,
    syncCollectionsWithServer,
    hydrateAndSyncListeningHistory,
    recordListeningDeltaSync,
    handleExportBackupJson,
    handleExportUserData,
    handleImportBackupJson,
    handleSpotifyCsvFile,
    closeSpotifyImportModal,
    confirmSpotifyImport,
    handleSpotifyUrlSubmit,
    fetchAdminData,
    handleCreateInvite,
    handleAdminAction,
    copyInviteCode,
    saveYtCookiesContent,
    handleClearYtCookies
  } = useCloudSync({
    apiRef,
    user,
    isOffline,
    likedTracks,
    setLikedTracks,
    customPlaylists,
    setCustomPlaylists,
    setSelectedLibrary,
    setStoragePersisted,
    setStoragePersistMsg,
    setSyncState,
    setSyncConflictNotice,
    setListeningEntries,
    setBackupMsg,
    spotifyUrl,
    setSpotifyUrl,
    spotifyBusy,
    setSpotifyBusy,
    setSpotifyMsg,
    pendingSpotifyImport,
    setPendingSpotifyImport,
    setSpotifyNewLibName,
    setAdminData,
    inviteLabel,
    setInviteLabel,
    inviteMaxUses,
    setInviteMaxUses,
    setAdminMsg,
    setCopiedCode,
    setYtCookiesText,
    setYtCookiesBusy,
    setYtCookiesMsg,
    userRef,
    isOfflineRef,
    likedTracksRef,
    customPlaylistsRef,
    collectionsHydratedForUserRef,
    collectionsVersionRef,
    deletedLikesRef,
    deletedPlaylistsRef,
    reconcilingCollectionsRef,
    pendingSaveAfterReconcileRef,
    pushInFlightRef,
    lastFocusReconcileAtRef,
    syncDebounceTimerRef,
    listeningStateRef,
    listeningSyncTimerRef,
    listeningPushInFlightRef,
    spotifyDialogRef,
    findOfflineItem
  });

  const {
    resolveOwnUploadId,
    persistLikes,
    persistOfflineCatalog,
    isLiked,
    isTrackInPlaylist,
    toggleLike,
    createCustomPlaylist,
    deleteCustomPlaylist,
    toggleTrackInPlaylist,
    removeTrackFromPlaylist,
    deleteOwnUploadEverywhere,
    openTrackMenu,
    closeTrackMenu,
    openSaveModal,
    closeSaveModal,
    openDownloadPromptModal,
    closeDownloadPromptModal,
    openEditTrackModal,
    closeEditTrackModal,
    handleEditTrackSubmit,
    updateTrackFileAcrossLibraries,
    updateTrackMetadataAcrossLibraries,
    promoteTrackToTopOfLibrary,
    syncMissingCoversForList
  } = usePlaylistsAndLibrary({
    apiRef,
    isOffline,
    likedTracks,
    setLikedTracks,
    likedLookup,
    offlineCatalog,
    setOfflineCatalog,
    customPlaylists,
    setCustomPlaylists,
    selectedLibrary,
    setSelectedLibrary,
    downloads,
    setQueue,
    setCoverSync,
    setMenuTrack,
    setTrackToSave,
    setModalNewPlaylistName,
    setDownloadPrompt,
    editingTrack,
    setEditingTrack,
    editForm,
    setEditForm,
    userRef,
    isOfflineRef,
    likedTracksRef,
    customPlaylistsRef,
    deletedLikesRef,
    deletedPlaylistsRef,
    queueRef,
    enrichedArtworkRef,
    enrichingBusyRef,
    cancelCoverSyncRef,
    menuDialogRef,
    saveDialogRef,
    downloadDialogRef,
    editDialogRef
  });

  const {
    openYtLinkModal,
    closeYtLinkModal,
    resolveYtLinkPreview,
    runDirectLinkDownload,
    handleYtLinkSubmit,
    refreshOfflineCacheList,
    exportTrackFile,
    deleteOfflineTrack,
    getTrackStreamUrl,
    getCachedBlobUrlForTrack,
    getSyncPlayableSource,
    resolvePlayableSource,
    fetchLibraryFiles,
    syncOwnUploadedTracks,
    cacheOwnTrackAndConfirmDelete,
    handleOwnAudioUpload,
    startDownload,
    downloadCollectionForOffline,
    isTrackAvailableOffline,
    activeDownloadEntries
  } = useDownloadQueue({
    apiRef,
    user,
    isOffline,
    activeTab,
    selectedLibrary,
    likedTracks,
    setLikedTracks,
    likedLookup,
    offlineCatalog,
    setOfflineCatalog,
    offlineLookup,
    setCustomPlaylists,
    setResults,
    downloads,
    setDownloads,
    setLibraryFiles,
    offlineUrls,
    setOfflineUrls,
    setDeviceQuota,
    syncingAll,
    setSyncingAll,
    setSyncProgress,
    ownUploadState,
    setOwnUploadState,
    setYtModalOpen,
    ytLinkUrl,
    setYtLinkUrl,
    ytLinkPreview,
    setYtLinkPreview,
    ytLinkLoading,
    setYtLinkLoading,
    ytLinkStage,
    setYtLinkStage,
    setYtLinkProgress,
    setYtLinkNotice,
    ytLinkReadyTrack,
    setYtLinkReadyTrack,
    setYtLinkError,
    ytLinkTargetLib,
    setYtLinkTargetLib,
    likedTracksRef,
    customPlaylistsRef,
    blobUrlCacheRef,
    inflightBlobPromisesRef,
    cachedStreamKeysRef,
    audioCachePromiseRef,
    cancelSyncRef,
    noSleepRef,
    ytDialogRef,
    ytPreviewReqIdRef,
    findOfflineItem
  });

  const {
    getLikedCategories,
    loadRecommendedOrRandomFeed,
    searchTracks,
    autoPlaylistsData,
    handleRefreshForYou,
    handlePlayAutoPlaylist,
    handleSelectForYouTrack,
    handleSaveAutoPlaylist
  } = useExploreSearch({
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
  });

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
    const dialogs = [
      menuDialogRef.current,
      saveDialogRef.current,
      spotifyDialogRef.current,
      downloadDialogRef.current,
      ytDialogRef.current,
      editDialogRef.current
    ].filter(Boolean);
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
  }, [user, menuTrack, trackToSave, pendingSpotifyImport, downloadPrompt, ytModalOpen, editingTrack]);

  // Check session & hydrate local collections on mount + auto-detect online/offline changes
  useEffect(() => {
    let cachedUser = null;
    try {
      const rawUser = localStorage.getItem(USER_STORAGE_KEY);
      if (rawUser) {
        cachedUser = JSON.parse(rawUser);
        setUser(cachedUser);
        setAuthChecked(true);
        if (cachedUser?.id) {
          const savedVer = Number(
            localStorage.getItem(`${COLLECTIONS_VERSION_KEY_PREFIX}${cachedUser.id}`)
          );
          if (Number.isInteger(savedVer) && savedVer >= 0) {
            collectionsVersionRef.current = savedVer;
          }
        }
      }
    } catch {}

    try {
      const rawDeletedLikes = localStorage.getItem(DELETED_LIKES_STORAGE_KEY);
      if (rawDeletedLikes) {
        deletedLikesRef.current = normalizeTombstoneList(JSON.parse(rawDeletedLikes));
      }
    } catch {}

    try {
      const rawDeletedPlaylists = localStorage.getItem(DELETED_PLAYLISTS_STORAGE_KEY);
      if (rawDeletedPlaylists) {
        deletedPlaylistsRef.current = normalizeTombstoneList(JSON.parse(rawDeletedPlaylists));
      }
    } catch {}

    try {
      const savedLikes = localStorage.getItem(LIKES_STORAGE_KEY);
      if (savedLikes) {
        const parsed = deduplicateTracksList(sanitizeLikedTracksList(JSON.parse(savedLikes)));
        setLikedTracks(parsed);
        localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(parsed));
      }
    } catch {}

    try {
      const savedOffline = localStorage.getItem(OFFLINE_CATALOG_KEY);
      if (savedOffline) {
        const parsedOff = deduplicateTracksList(JSON.parse(savedOffline));
        setOfflineCatalog(parsedOff);
        localStorage.setItem(OFFLINE_CATALOG_KEY, JSON.stringify(parsedOff));
      }
    } catch {}

    try {
      const savedPlaylists = localStorage.getItem(PLAYLISTS_STORAGE_KEY);
      if (savedPlaylists) {
        const rawPls = JSON.parse(savedPlaylists);
        const dedupedPls = Array.isArray(rawPls)
          ? rawPls.map(pl => ({
              ...pl,
              tracks: deduplicateTracksList(pl.tracks || [])
            }))
          : [];
        setCustomPlaylists(dedupedPls);
        localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(dedupedPls));
      }
    } catch {}

    try {
      const savedRecs = localStorage.getItem(FORYOU_RECS_STORAGE_KEY);
      if (savedRecs) {
        const parsedRecs = JSON.parse(savedRecs);
        if (Array.isArray(parsedRecs)) {
          setForYouRecommendations(parsedRecs);
        }
      }
    } catch {}

    const offlineNow = typeof navigator !== 'undefined' && !navigator.onLine;
    setIsOffline(offlineNow);
    wasOfflineRef.current = offlineNow;
    if (offlineNow) {
      rawSetActiveTab('library');
      rawSetSelectedLibrary('offline');
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
          rawSetActiveTab(prev => (prev === 'foryou' ? 'foryou' : 'library'));
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
        verifyInternetConnection().then(alive => {
          if (alive) {
            reconcileCollectionsOnAppReturn();
            if (userRef.current?.id && !userRef.current.offline) {
              hydrateAndSyncListeningHistory(userRef.current.id);
            }
          }
        });
      }
    };
    const handleWindowFocus = () => {
      verifyInternetConnection().then(alive => {
        if (alive) {
          reconcileCollectionsOnAppReturn();
          if (userRef.current?.id && !userRef.current.offline) {
            hydrateAndSyncListeningHistory(userRef.current.id);
          }
        }
      });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleWindowFocus);

    const probeTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
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
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    };
  }, []);

  // Load initial catalog & server files once logged in, or restore automatically when internet returns
  useEffect(() => {
    ensurePersistentStorage(false);
    if (!user) return;
    if (isOffline) {
      wasOfflineRef.current = true;
      hydrateAndSyncListeningHistory(user.id || 'offline_local');
      return;
    }
    fetchLibraryFiles();
    if (!user.offline && user.id) {
      (async () => {
        await syncCollectionsWithServer(user.id);
        await hydrateAndSyncListeningHistory(user.id);
        await syncOwnUploadedTracks();
      })();
    } else {
      hydrateAndSyncListeningHistory(user.id || 'offline_local');
      syncOwnUploadedTracks();
    }
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

  // Manage audio playback when currentTrack changes + pre-warm upcoming queue Blob URLs for screen-off transitions
  useEffect(() => {
    if (!currentTrack || !audioRef.current) return;
    let cancelled = false;
    setOptimisticTrack(null);

    const alreadyHandledByDirectStart =
      lastDirectPlayRef.current.index === currentIndex &&
      String(lastDirectPlayRef.current.id) === String(currentTrack.id);

    if (!alreadyHandledByDirectStart) {
      if (String(playbackSessionRef.current.trackId) !== String(currentTrack.id)) {
        finalizeActivePlaybackSession(false);
        beginPlaybackSessionForTrack(currentTrack);
      }
      const playTrack = async () => {
        const src = await resolvePlayableSource(currentTrack);
        if (!src || cancelled || !audioRef.current) return;
        if (
          lastDirectPlayRef.current.index === currentIndex &&
          String(lastDirectPlayRef.current.id) === String(currentTrack.id) &&
          Boolean(audioRef.current.src) &&
          !audioRef.current.paused
        ) {
          return;
        }
        if (audioRef.current.src !== src) {
          audioRef.current.src = src;
        }
        lastDirectPlayRef.current = {
          index: currentIndex,
          id: String(currentTrack.id),
          src
        };
        playInFlightRef.current = true;
        try {
          await audioRef.current.play();
          playInFlightRef.current = false;
          consecutivePlayFailuresRef.current = 0;
          if (!cancelled) {
            isPlayingRef.current = true;
            setIsPlaying(true);
          }
          preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
        } catch {
          playInFlightRef.current = false;
          if (!cancelled) {
            const stillPlaying = Boolean(audioRef.current && !audioRef.current.paused);
            isPlayingRef.current = stillPlaying;
            setIsPlaying(stillPlaying);
          }
        }
      };
      playTrack();
    }

    return () => {
      cancelled = true;
    };
  }, [currentIndex, queue]);

  // Keep initial offline tracks pre-warmed calmly without flooding CacheStorage during active track startup
  useEffect(() => {
    if (playInFlightRef.current) return;
    const timer = setTimeout(() => {
      if (playInFlightRef.current) return;
      if (queueRef.current.length > 0 && currentIndexRef.current >= 0) {
        preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
      } else if (offlineCatalog.length > 0) {
        preloadUpcomingQueueBlobs(offlineCatalog, 0);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [shuffle, offlineCatalog]);

  // Register lock-screen / background MediaSession metadata and hardware transport controls
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      if (currentTrack && typeof window !== 'undefined' && 'MediaMetadata' in window) {
        const artUrl = isPlaceholderCover(currentTrack.artwork)
          ? new URL(DEFAULT_TRACK_COVER, window.location.origin).href
          : currentTrack.artwork.startsWith('/')
          ? new URL(currentTrack.artwork, window.location.origin).href
          : currentTrack.artwork;
        const artMime = String(artUrl || '').startsWith('data:image/png')
          ? 'image/png'
          : 'image/jpeg';
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: currentTrack.title || 'MyMusicAnywhere',
          artist: currentTrack.artist || 'Artista',
          album: currentTrack.album || 'MyMusicAnywhere',
          artwork: artUrl ? [{ src: artUrl, sizes: '300x300', type: artMime }] : []
        });
      }
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch {}

    const handlers = [
      ['play', () => {
        if (audioRef.current && currentIndexRef.current >= 0) {
          audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
        }
      }],
      ['pause', () => {
        if (audioRef.current) {
          audioRef.current.pause();
          setIsPlaying(false);
        }
      }],
      ['nexttrack', () => playNext()],
      ['previoustrack', () => playPrev()],
      ['seekto', details => {
        if (audioRef.current && details && typeof details.seekTime === 'number') {
          audioRef.current.currentTime = details.seekTime;
        }
      }]
    ];

    for (const [action, fn] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {}
    }
  }, [currentTrack, isPlaying, queue, currentIndex, shuffle, repeatMode]);

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
    if (syncDebounceTimerRef.current) {
      clearTimeout(syncDebounceTimerRef.current);
      syncDebounceTimerRef.current = null;
    }
    if (listeningSyncTimerRef.current) {
      clearTimeout(listeningSyncTimerRef.current);
      listeningSyncTimerRef.current = null;
    }
    collectionsHydratedForUserRef.current = '';
    collectionsVersionRef.current = 0;
    reconcilingCollectionsRef.current = false;
    pendingSaveAfterReconcileRef.current = false;
    setSyncConflictNotice('');
    listeningStateRef.current = {
      userId: '',
      version: 0,
      syncedEntries: {},
      pendingDelta: {}
    };
    setListeningEntries({});
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

  function parseTrackDurationHintSec(track) {
    if (!track) return 0;
    const direct = Number(track.durationSec);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const str = String(track.duration || '').trim();
    const match = str.match(/^(\d+):(\d{2})$/);
    if (match) {
      return Number(match[1]) * 60 + Number(match[2]);
    }
    return 0;
  }

  function finalizeActivePlaybackSession(didComplete = false) {
    const sess = playbackSessionRef.current;
    if (!sess || !sess.trackId) return;
    const tid = sess.trackId;
    const now = Date.now();

    if (didComplete) {
      const needPlay = !sess.playCounted;
      const needComplete = !sess.completeCounted;
      sess.playCounted = true;
      sess.completeCounted = true;
      if (needPlay || needComplete) {
        recordListeningDeltaSync(tid, {
          plays: needPlay ? 1 : 0,
          completes: needComplete ? 1 : 0,
          lastPlayedAt: now,
          ...(needPlay ? { hourBucket: sess.hourBucket } : {})
        });
      }
      return;
    }

    // Track switched before ending: count as skip if playback actually started (>0.25s) and stayed <25%
    if (!sess.playCounted && !sess.completeCounted && !sess.skipCounted) {
      const playedAny = sess.listenedSec > 0.25 || sess.lastTimeSec > 0.25;
      if (playedAny) {
        const dur = sess.durationSec;
        const skippedEarly = dur > 0 ? sess.listenedSec / dur < 0.25 : sess.listenedSec < 15;
        if (skippedEarly) {
          sess.skipCounted = true;
          recordListeningDeltaSync(tid, { skips: 1 });
        }
      }
    }
  }

  function beginPlaybackSessionForTrack(track) {
    if (!track || track.id == null) {
      playbackSessionRef.current = {
        trackId: '',
        lastTimeSec: 0,
        listenedSec: 0,
        durationSec: 0,
        playCounted: false,
        completeCounted: false,
        skipCounted: false,
        hourBucket: getHourBucketName(new Date())
      };
      return;
    }
    playbackSessionRef.current = {
      trackId: String(track.id),
      lastTimeSec: 0,
      listenedSec: 0,
      durationSec: parseTrackDurationHintSec(track),
      playCounted: false,
      completeCounted: false,
      skipCounted: false,
      hourBucket: getHourBucketName(new Date())
    };
  }

  function handlePlaybackTimeTick(curSec, rawDurationSec) {
    const sess = playbackSessionRef.current;
    if (!sess || !sess.trackId) return;
    if (Number.isFinite(rawDurationSec) && rawDurationSec > 0) {
      sess.durationSec = rawDurationSec;
    }
    const dt = curSec - sess.lastTimeSec;
    if (dt > 0 && dt < 2.5) {
      sess.listenedSec += dt;
    }
    sess.lastTimeSec = curSec;

    if (!sess.playCounted) {
      const reached30s = sess.listenedSec >= 30;
      const reachedHalf = sess.durationSec > 0 && sess.listenedSec / sess.durationSec >= 0.5;
      if (reached30s || reachedHalf) {
        sess.playCounted = true;
        recordListeningDeltaSync(sess.trackId, {
          plays: 1,
          lastPlayedAt: Date.now(),
          hourBucket: sess.hourBucket
        });
      }
    }
  }

  function preloadUpcomingQueueBlobs(list = queueRef.current, fromIdx = currentIndexRef.current) {
    if (!Array.isArray(list) || list.length === 0) return;
    if (warmingInProgressRef.current) return;

    const buildUncachedOrderedList = () => {
      const activeList = queueRef.current.length > 0 ? queueRef.current : list;
      const activeFrom = currentIndexRef.current >= 0 ? currentIndexRef.current : fromIdx;
      const orderedIndices = [];
      const seen = new Set();
      const pushIdx = idx => {
        if (idx >= 0 && idx < activeList.length && !seen.has(idx)) {
          seen.add(idx);
          orderedIndices.push(idx);
        }
      };

      const { order, pos } = shuffleStateRef.current;
      if (Array.isArray(order) && order.length > 0) {
        const startPos = Math.max(0, pos);
        for (let offset = 0; offset < order.length; offset++) {
          pushIdx(order[(startPos + offset) % order.length]);
        }
      }

      if (activeFrom >= 0 && activeFrom < activeList.length) {
        pushIdx(activeFrom);
        pushIdx(activeFrom + 1);
        pushIdx(activeFrom + 2);
        pushIdx(activeFrom - 1);
      }

      for (let offset = 0; offset < activeList.length; offset++) {
        const base = activeFrom >= 0 ? activeFrom : 0;
        pushIdx((base + offset) % activeList.length);
      }

      const uncached = [];
      for (const idx of orderedIndices) {
        const t = activeList[idx];
        if (!t || getCachedBlobUrlForTrack(t)) continue;
        const streamUrl = getTrackStreamUrl(t);
        if (streamUrl && !inflightBlobPromisesRef.current.has(streamUrl)) {
          uncached.push(t);
        }
      }
      return uncached;
    };

    const initialCheck = buildUncachedOrderedList();
    if (initialCheck.length === 0) return;

    warmingInProgressRef.current = true;
    (async () => {
      try {
        while (true) {
          // Always re-evaluate priority order so newly selected tracks/queues are warmed first
          const pending = buildUncachedOrderedList();
          if (pending.length === 0) break;
          const batch = pending.slice(0, 6);
          await Promise.all(batch.map(t => resolvePlayableSource(t).catch(() => {})));
        }
      } finally {
        warmingInProgressRef.current = false;
      }
    })();
  }

  function handleTrackPlaybackFailure(failedIdx, activeQueue) {
    if (currentIndexRef.current !== failedIdx) return;
    const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (
      isHidden &&
      Array.isArray(activeQueue) &&
      activeQueue.length > 1 &&
      consecutivePlayFailuresRef.current < Math.min(activeQueue.length, 8)
    ) {
      consecutivePlayFailuresRef.current += 1;
      playNext();
      return;
    }
    isPlayingRef.current = false;
    setIsPlaying(false);
  }

  function startTrackAtIndexImmediate(nextIdx, listOverride = null) {
    const activeQueue = listOverride || queueRef.current;
    if (!Array.isArray(activeQueue) || nextIdx < 0 || nextIdx >= activeQueue.length) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }
    const nextTrack = activeQueue[nextIdx];
    if (!nextTrack) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }

    finalizeActivePlaybackSession(false);
    beginPlaybackSessionForTrack(nextTrack);

    const trackHistoryKey = getShuffleTrackKey(nextTrack);
    if (trackHistoryKey) {
      const filteredHistory = recentPlayedKeysRef.current.filter(k => k !== trackHistoryKey);
      filteredHistory.push(trackHistoryKey);
      if (filteredHistory.length > 15) {
        filteredHistory.splice(0, filteredHistory.length - 15);
      }
      recentPlayedKeysRef.current = filteredHistory;
    }

    currentIndexRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    isPlayingRef.current = true;
    setIsPlaying(true);

    const cachedBlobUrl = getCachedBlobUrlForTrack(nextTrack);
    const directOnlinePreview = !isTrackAvailableOffline(nextTrack) ? nextTrack.previewUrl : null;
    const isHiddenScreen =
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    // 1. Fast synchronous path: when the track's Blob URL is already in RAM (or screen is locked on iOS),
    // assign audio.src and call audio.play() synchronously in the same turn.
    const syncSrc =
      cachedBlobUrl ||
      directOnlinePreview ||
      (isHiddenScreen ? getSyncPlayableSource(nextTrack) : null);

    if (syncSrc && audioRef.current) {
      lastDirectPlayRef.current = {
        index: nextIdx,
        id: String(nextTrack.id),
        src: syncSrc
      };
      if (audioRef.current.src !== syncSrc) {
        audioRef.current.src = syncSrc;
      }
      playInFlightRef.current = true;
      const playPromise = audioRef.current.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            playInFlightRef.current = false;
            consecutivePlayFailuresRef.current = 0;
            isPlayingRef.current = true;
            setIsPlaying(true);
            preloadUpcomingQueueBlobs(activeQueue, nextIdx);
          })
          .catch(() => {
            resolvePlayableSource(nextTrack).then(resolvedSrc => {
              if (
                resolvedSrc &&
                audioRef.current &&
                currentIndexRef.current === nextIdx
              ) {
                if (audioRef.current.src !== resolvedSrc) {
                  audioRef.current.src = resolvedSrc;
                }
                lastDirectPlayRef.current = {
                  index: nextIdx,
                  id: String(nextTrack.id),
                  src: resolvedSrc
                };
                audioRef.current
                  .play()
                  .then(() => {
                    playInFlightRef.current = false;
                    consecutivePlayFailuresRef.current = 0;
                    isPlayingRef.current = true;
                    setIsPlaying(true);
                    preloadUpcomingQueueBlobs(activeQueue, nextIdx);
                  })
                  .catch(() => {
                    playInFlightRef.current = false;
                    handleTrackPlaybackFailure(nextIdx, activeQueue);
                  });
              } else {
                playInFlightRef.current = false;
                handleTrackPlaybackFailure(nextIdx, activeQueue);
              }
            });
          });
      } else {
        playInFlightRef.current = false;
        consecutivePlayFailuresRef.current = 0;
        isPlayingRef.current = true;
        setIsPlaying(true);
        preloadUpcomingQueueBlobs(activeQueue, nextIdx);
      }
      return;
    }

    // 2. Priority Blob resolution path (when user clicks a track or Play button before its Blob URL is in RAM):
    // Resolve the clicked track's Blob URL from CacheStorage FIRST (~5ms, without assigning a deleted /api/stream URL)
    // and then call audio.play() once inside the active user gesture window.
    lastDirectPlayRef.current = {
      index: nextIdx,
      id: String(nextTrack.id),
      src: 'pending'
    };
    playInFlightRef.current = true;
    resolvePlayableSource(nextTrack)
      .then(resolvedSrc => {
        if (!resolvedSrc || !audioRef.current || currentIndexRef.current !== nextIdx) {
          playInFlightRef.current = false;
          return;
        }
        if (audioRef.current.src !== resolvedSrc) {
          audioRef.current.src = resolvedSrc;
        }
        lastDirectPlayRef.current = {
          index: nextIdx,
          id: String(nextTrack.id),
          src: resolvedSrc
        };
        return audioRef.current
          .play()
          .then(() => {
            playInFlightRef.current = false;
            consecutivePlayFailuresRef.current = 0;
            isPlayingRef.current = true;
            setIsPlaying(true);
            preloadUpcomingQueueBlobs(activeQueue, nextIdx);
          })
          .catch(() => {
            playInFlightRef.current = false;
            handleTrackPlaybackFailure(nextIdx, activeQueue);
          });
      })
      .catch(() => {
        playInFlightRef.current = false;
        handleTrackPlaybackFailure(nextIdx, activeQueue);
      });
  }

  function toggleShuffle() {
    setShuffle(prev => {
      const next = !prev;
      shuffleRef.current = next;
      const activeQueue = queueRef.current;
      const curIdx = currentIndexRef.current;
      if (next && Array.isArray(activeQueue) && activeQueue.length > 0) {
        const order = buildSmartShuffleOrder(activeQueue, {
          startIdx: curIdx >= 0 ? curIdx : -1,
          recentKeys: recentPlayedKeysRef.current
        });
        shuffleStateRef.current = { order, pos: 0, queueLen: activeQueue.length };
        preloadUpcomingQueueBlobs(activeQueue, curIdx);
      } else {
        shuffleStateRef.current = {
          order: [],
          pos: -1,
          queueLen: Array.isArray(activeQueue) ? activeQueue.length : 0
        };
      }
      return next;
    });
  }

  function playFromList(list, index, startRandom = false, options = {}) {
    if (!Array.isArray(list) || list.length === 0) return;
    const {
      forceIncludeTrack = null,
      allowSinglePreview = false,
      preserveOrder = false
    } = options || {};
    const clickedTrack = index >= 0 && index < list.length ? list[index] : null;

    if (allowSinglePreview && clickedTrack && !isTrackAvailableOffline(clickedTrack)) {
      if (isOffline) return;
      const singleQueue = [clickedTrack];
      queueRef.current = singleQueue;
      setQueue(singleQueue);
      shuffleStateRef.current = { order: [0], pos: 0, queueLen: 1 };
      startTrackAtIndexImmediate(0, singleQueue);
      return;
    }

    // Normal and shuffle playback ONLY ever queue downloaded tracks
    const playableList = list.filter(
      t =>
        isTrackAvailableOffline(t) ||
        (forceIncludeTrack && String(t.id) === String(forceIncludeTrack.id))
    );
    if (playableList.length === 0) return;

    const targetId = forceIncludeTrack?.id ?? clickedTrack?.id;
    const foundIdx = targetId
      ? playableList.findIndex(t => String(t.id) === String(targetId))
      : 0;
    const mappedIdx = foundIdx >= 0 ? foundIdx : 0;

    queueRef.current = playableList;
    setQueue(playableList);

    if (preserveOrder && !startRandom) {
      shuffleRef.current = false;
      setShuffle(false);
      shuffleStateRef.current = { order: [], pos: -1, queueLen: playableList.length };
      startTrackAtIndexImmediate(mappedIdx, playableList);
      return;
    }

    if (!shuffleRef.current) {
      shuffleRef.current = true;
      setShuffle(true);
    }
    const order = buildSmartShuffleOrder(playableList, {
      startIdx: startRandom ? -1 : mappedIdx,
      recentKeys: recentPlayedKeysRef.current
    });

    // When starting random playback (top orange-black Play button), if order[0]'s Blob URL is not yet in RAM
    // but another candidate in the shuffle order already has its Blob URL ready in RAM, promote it to order[0]
    // so playback begins in 0ms synchronously on the very first tap.
    if (startRandom && order.length > 1 && !getCachedBlobUrlForTrack(playableList[order[0]])) {
      const readyPos = order.findIndex(idx => Boolean(getCachedBlobUrlForTrack(playableList[idx])));
      if (readyPos > 0) {
        [order[0], order[readyPos]] = [order[readyPos], order[0]];
      }
    }

    shuffleStateRef.current = { order, pos: 0, queueLen: playableList.length };
    const firstIdx = order[0] ?? mappedIdx;
    startTrackAtIndexImmediate(firstIdx, playableList);
  }

  function togglePlayPause() {
    if (!audioRef.current || !currentTrack) return;
    const audioEl = audioRef.current;
    const actuallyPlaying = !audioEl.paused && !audioEl.ended && audioEl.readyState > 0;
    if (actuallyPlaying) {
      audioEl.pause();
      isPlayingRef.current = false;
      setIsPlaying(false);
    } else {
      if (!audioEl.src) {
        startTrackAtIndexImmediate(currentIndexRef.current, queueRef.current);
        return;
      }
      playInFlightRef.current = true;
      audioEl
        .play()
        .then(() => {
          playInFlightRef.current = false;
          isPlayingRef.current = true;
          setIsPlaying(true);
          preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
        })
        .catch(() => {
          playInFlightRef.current = false;
          startTrackAtIndexImmediate(currentIndexRef.current, queueRef.current);
        });
    }
  }

  function playNext() {
    const activeQueue = queueRef.current;
    const curIdx = currentIndexRef.current;
    const isShuffle = shuffleRef.current;
    const curRepeat = repeatModeRef.current;

    if (!Array.isArray(activeQueue) || activeQueue.length === 0) return;
    const validIndices = activeQueue
      .map((t, i) => (isTrackAvailableOffline(t) ? i : -1))
      .filter(i => i !== -1);
    if (validIndices.length === 0) {
      setIsPlaying(false);
      return;
    }

    if (isShuffle && validIndices.length > 1) {
      let { order, pos, queueLen } = shuffleStateRef.current;
      const filteredOrder = Array.isArray(order)
        ? order.filter(idx => idx >= 0 && idx < activeQueue.length && isTrackAvailableOffline(activeQueue[idx]))
        : [];
      if (filteredOrder.length !== validIndices.length || queueLen !== activeQueue.length) {
        order = buildSmartShuffleOrder(activeQueue, {
          startIdx: curIdx,
          recentKeys: recentPlayedKeysRef.current
        }).filter(idx => isTrackAvailableOffline(activeQueue[idx]));
        pos = Math.max(0, order.indexOf(curIdx));
      } else {
        order = filteredOrder;
        const currentPosInOrder = order.indexOf(curIdx);
        if (currentPosInOrder !== -1) pos = currentPosInOrder;
      }
      const nextPos = pos + 1;
      if (nextPos < order.length) {
        shuffleStateRef.current = { order, pos: nextPos, queueLen: activeQueue.length };
        startTrackAtIndexImmediate(order[nextPos], activeQueue);
      } else {
        const freshOrder = buildSmartShuffleOrder(activeQueue, {
          startIdx: -1,
          recentKeys: recentPlayedKeysRef.current
        }).filter(idx => isTrackAvailableOffline(activeQueue[idx]));
        if (freshOrder.length > 1 && freshOrder[0] === curIdx) {
          [freshOrder[0], freshOrder[1]] = [freshOrder[1], freshOrder[0]];
        }
        shuffleStateRef.current = { order: freshOrder, pos: 0, queueLen: activeQueue.length };
        startTrackAtIndexImmediate(freshOrder[0] ?? validIndices[0], activeQueue);
      }
      return;
    }

    const nextValid = validIndices.find(i => i > curIdx);
    if (nextValid !== undefined) {
      startTrackAtIndexImmediate(nextValid, activeQueue);
    } else if (curRepeat === 'all' || isShuffle) {
      startTrackAtIndexImmediate(validIndices[0], activeQueue);
    } else {
      setIsPlaying(false);
    }
  }

  function playPrev() {
    const activeQueue = queueRef.current;
    const curIdx = currentIndexRef.current;
    const isShuffle = shuffleRef.current;
    const curRepeat = repeatModeRef.current;

    if (!Array.isArray(activeQueue) || activeQueue.length === 0) return;
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    const validIndices = activeQueue
      .map((t, i) => (isTrackAvailableOffline(t) ? i : -1))
      .filter(i => i !== -1);
    if (validIndices.length === 0) return;

    if (isShuffle && validIndices.length > 1) {
      const { order, pos, queueLen } = shuffleStateRef.current;
      if (Array.isArray(order) && queueLen === activeQueue.length && pos > 0) {
        for (let p = pos - 1; p >= 0; p--) {
          if (isTrackAvailableOffline(activeQueue[order[p]])) {
            shuffleStateRef.current = { order, pos: p, queueLen: activeQueue.length };
            startTrackAtIndexImmediate(order[p], activeQueue);
            return;
          }
        }
      }
    }

    const prevValid = [...validIndices].reverse().find(i => i < curIdx);
    if (prevValid !== undefined) {
      startTrackAtIndexImmediate(prevValid, activeQueue);
    } else if (curRepeat === 'all' || isShuffle) {
      startTrackAtIndexImmediate(validIndices[validIndices.length - 1], activeQueue);
    }
  }

  function handleTrackEnded() {
    finalizeActivePlaybackSession(true);
    if (repeatModeRef.current === 'one' && audioRef.current) {
      beginPlaybackSessionForTrack(queueRef.current[currentIndexRef.current]);
      audioRef.current.currentTime = 0;
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
      return;
    }
    playNext();
  }

  function cycleRepeatMode() {
    setRepeatMode(prev => (prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off'));
  }

  Object.assign(apiRef.current, {
    playFromList
  });

  async function handleInstallPwa() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  }

  const trackRowSharedProps = {
    downloads,
    activeDownloadEntries,
    findOfflineItem,
    offlineUrls,
    blobUrlCacheRef,
    isOffline,
    currentTrack,
    optimisticTrack,
    setOptimisticTrack,
    downloadPrompt,
    isLiked,
    toggleLike,
    isPlaying,
    libraryQuery,
    setLibraryQuery,
    promoteTrackToTopOfLibrary,
    resolvePlayableSource,
    playFromList,
    togglePlayPause,
    openDownloadPromptModal,
    enrichedArtworkRef,
    updateTrackMetadataAcrossLibraries,
    openTrackMenu,
    startDownload,
    cacheOwnTrackAndConfirmDelete
  };

  if (!authChecked || !user) {
    return (
      <AuthScreen
        authChecked={authChecked}
        authMode={authMode}
        setAuthMode={setAuthMode}
        authError={authError}
        setAuthError={setAuthError}
        isOffline={isOffline}
        username={username}
        setUsername={setUsername}
        password={password}
        setPassword={setPassword}
        inviteCode={inviteCode}
        setInviteCode={setInviteCode}
        showPassword={showPassword}
        setShowPassword={setShowPassword}
        authBusy={authBusy}
        onSubmit={handleAuthSubmit}
        offlineCount={offlineCatalog.length}
        onEnterOfflineMode={() => {
          setUser({ username: 'Offline', is_admin: false, offline: true });
          setActiveTab('library');
          setSelectedLibrary('offline');
        }}
      />
    );
  }

  // ==================== AUTHENTICATED APP SHELL ====================
  const topFrequentArtists = getLikedCategories().slice(0, 5);

  return (
    <div className="app-shell">
      <AppTopbar
        user={user}
        isOffline={isOffline}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        likedCount={likedTracks.length}
        offlineCount={offlineCatalog.length}
        accountRef={accountRef}
        accountOpen={accountOpen}
        setAccountOpen={setAccountOpen}
        fetchAdminData={fetchAdminData}
        deferredPrompt={deferredPrompt}
        handleInstallPwa={handleInstallPwa}
        handleLogout={handleLogout}
      />

      <main className="main-container">

      {isOffline && (
        <div className="offline-pill-bar">
          <div className="offline-pill-copy">
            <Icon name="wifi-off" size={14} />
            <div className="offline-pill-text">
              <strong>Modo sin conexión</strong>
              <span>Reproduciendo música guardada</span>
            </div>
          </div>
          <div className="offline-pill-actions">
            {activeTab !== 'library' || selectedLibrary !== 'offline' ? (
              <button
                type="button"
                onClick={() => {
                  setActiveTab('library');
                  setSelectedLibrary('offline');
                }}
              >
                Offline ({offlineCatalog.length})
              </button>
            ) : null}
            <button type="button" onClick={() => verifyInternetConnection()}>
              Reconectar
            </button>
          </div>
        </div>
      )}

      {syncConflictNotice && (
        <div className="offline-pill-bar" role="status" aria-live="polite">
          <div className="offline-pill-copy">
            <Icon name="refresh" size={14} />
            <div className="offline-pill-text">
              <strong>Sincronización pendiente</strong>
              <span>{syncConflictNotice}</span>
            </div>
          </div>
          <div className="offline-pill-actions">
            <button
              type="button"
              onClick={() => {
                setSyncConflictNotice('');
                pushCollectionsToServerNow();
              }}
            >
              Reintentar
            </button>
            <button type="button" onClick={() => setSyncConflictNotice('')}>
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* ==================== TAB 1: EXPLORAR ==================== */}
      {activeTab === 'explore' && (
        <ExploreSection
          isOffline={isOffline}
          query={query}
          setQuery={setQuery}
          loading={loading}
          openYtLinkModal={openYtLinkModal}
          activeChip={activeChip}
          setActiveChip={setActiveChip}
          searchTracks={searchTracks}
          loadRecommendedOrRandomFeed={loadRecommendedOrRandomFeed}
          likedTracks={likedTracks}
          customPlaylistsCount={customPlaylists.length}
          topFrequentArtists={topFrequentArtists}
          feedInfo={feedInfo}
          results={results}
          ownUploadState={ownUploadState}
          setOwnUploadState={setOwnUploadState}
          ownUploadInputExpRef={ownUploadInputExpRef}
          handleOwnAudioUpload={handleOwnAudioUpload}
          activeDownloadEntries={activeDownloadEntries}
          syncingAll={syncingAll}
          syncProgress={syncProgress}
          trackRowSharedProps={trackRowSharedProps}
        />
      )}

      {/* ==================== TAB 2: BIBLIOTECA (FAVORITOS / OFFLINE / PROPIAS) ==================== */}
      {activeTab === 'library' && (
        <LibrarySection
          isOffline={isOffline}
          selectedLibrary={selectedLibrary}
          setSelectedLibrary={setSelectedLibrary}
          libraryQuery={libraryQuery}
          setLibraryQuery={setLibraryQuery}
          likedTracks={likedTracks}
          offlineCatalog={offlineCatalog}
          customPlaylists={customPlaylists}
          creatingPlaylist={creatingPlaylist}
          setCreatingPlaylist={setCreatingPlaylist}
          newPlaylistName={newPlaylistName}
          setNewPlaylistName={setNewPlaylistName}
          createCustomPlaylist={createCustomPlaylist}
          deleteCustomPlaylist={deleteCustomPlaylist}
          openYtLinkModal={openYtLinkModal}
          ownUploadState={ownUploadState}
          setOwnUploadState={setOwnUploadState}
          ownUploadInputLibRef={ownUploadInputLibRef}
          handleOwnAudioUpload={handleOwnAudioUpload}
          coverSync={coverSync}
          deviceQuota={deviceQuota}
          isTrackAvailableOffline={isTrackAvailableOffline}
          resolveOwnUploadId={resolveOwnUploadId}
          shuffle={shuffle}
          toggleShuffle={toggleShuffle}
          repeatMode={repeatMode}
          cycleRepeatMode={cycleRepeatMode}
          syncMissingCoversForList={syncMissingCoversForList}
          syncingAll={syncingAll}
          syncProgress={syncProgress}
          downloadCollectionForOffline={downloadCollectionForOffline}
          resolvePlayableSource={resolvePlayableSource}
          playFromList={playFromList}
          activeDownloadEntries={activeDownloadEntries}
          trackRowSharedProps={trackRowSharedProps}
        />
      )}

      {/* ==================== AJUSTES & SPOTIFY SYNC ==================== */}
      {activeTab === 'settings' && (
        <SettingsPanel
          user={user}
          isOffline={isOffline}
          Icon={Icon}
          syncState={syncState}
          likedCount={likedTracks.length}
          playlistsCount={customPlaylists.length}
          backupMsg={backupMsg}
          onExportBackupJson={handleExportBackupJson}
          onExportUserData={handleExportUserData}
          onImportBackupJson={handleImportBackupJson}
          onForceCloudSync={() => pushCollectionsToServerNow()}
          spotifyUrl={spotifyUrl}
          setSpotifyUrl={setSpotifyUrl}
          spotifyBusy={spotifyBusy}
          spotifyMsg={spotifyMsg}
          pendingSpotifyImport={pendingSpotifyImport}
          spotifyNewLibName={spotifyNewLibName}
          setSpotifyNewLibName={setSpotifyNewLibName}
          customPlaylists={customPlaylists}
          onSpotifyUrlSubmit={handleSpotifyUrlSubmit}
          onSpotifyCsvFile={handleSpotifyCsvFile}
          onConfirmSpotifyImport={confirmSpotifyImport}
          onCloseSpotifyImport={closeSpotifyImportModal}
          onGoToLibrary={() => setActiveTab('library')}
          deviceQuota={deviceQuota}
          offlineCount={offlineCatalog.length}
          storagePersisted={storagePersisted}
          storagePersistMsg={storagePersistMsg}
          onRequestPersistentStorage={() => ensurePersistentStorage(true)}
          onClearOfflineCache={async () => {
            if ('caches' in window) {
              await caches.delete(AUDIO_CACHE_NAME);
            }
            persistOfflineCatalog([]);
            await refreshOfflineCacheList();
          }}
          adminYtCookies={adminData.ytCookies}
          ytCookiesText={ytCookiesText}
          setYtCookiesText={setYtCookiesText}
          ytCookiesBusy={ytCookiesBusy}
          ytCookiesMsg={ytCookiesMsg}
          onSaveYtCookies={saveYtCookiesContent}
          onClearYtCookies={handleClearYtCookies}
        />
      )}

      {/* ==================== TAB: PARA TI (AUTOMATIC PLAYLISTS) ==================== */}
      {activeTab === 'foryou' && (
        <ForYouPanel
          playlists={autoPlaylistsData.playlists}
          coldStart={autoPlaylistsData.coldStart}
          coldStartMessage={autoPlaylistsData.message}
          totalPlays={autoPlaylistsData.totalPlays}
          isOffline={isOffline}
          isRefreshing={forYouRefreshing}
          savedFeedbackMap={forYouSavedMap}
          currentTrackId={currentTrack?.id ?? null}
          isPlaying={isPlaying}
          compressArtworkUrl={compressArtworkUrl}
          isTrackAvailableOffline={isTrackAvailableOffline}
          onRefresh={handleRefreshForYou}
          onPlayPlaylist={handlePlayAutoPlaylist}
          onSaveAsPlaylist={handleSaveAutoPlaylist}
          onSelectTrack={handleSelectForYouTrack}
          Icon={Icon}
        />
      )}

      {/* ==================== TAB 5: ADMIN PANEL ==================== */}
      {activeTab === 'admin' && user.is_admin && (
        <AdminPanel
          isOffline={isOffline}
          adminData={adminData}
          adminMsg={adminMsg}
          inviteLabel={inviteLabel}
          setInviteLabel={setInviteLabel}
          inviteMaxUses={inviteMaxUses}
          setInviteMaxUses={setInviteMaxUses}
          copiedCode={copiedCode}
          onCreateInvite={handleCreateInvite}
          onCopyInviteCode={copyInviteCode}
          onAdminAction={handleAdminAction}
          Icon={Icon}
        />
      )}
      </main>

      <AppDialogs
        isOffline={isOffline}
        menuDialogRef={menuDialogRef}
        saveDialogRef={saveDialogRef}
        spotifyDialogRef={spotifyDialogRef}
        downloadDialogRef={downloadDialogRef}
        ytDialogRef={ytDialogRef}
        editDialogRef={editDialogRef}
        ownUploadInputLibRef={ownUploadInputLibRef}
        ownUploadInputExpRef={ownUploadInputExpRef}
        menuTrack={menuTrack}
        setMenuTrack={setMenuTrack}
        closeTrackMenu={closeTrackMenu}
        trackToSave={trackToSave}
        setTrackToSave={setTrackToSave}
        closeSaveModal={closeSaveModal}
        modalNewPlaylistName={modalNewPlaylistName}
        setModalNewPlaylistName={setModalNewPlaylistName}
        pendingSpotifyImport={pendingSpotifyImport}
        spotifyNewLibName={spotifyNewLibName}
        setSpotifyNewLibName={setSpotifyNewLibName}
        closeSpotifyImportModal={closeSpotifyImportModal}
        confirmSpotifyImport={confirmSpotifyImport}
        downloadPrompt={downloadPrompt}
        setDownloadPrompt={setDownloadPrompt}
        closeDownloadPromptModal={closeDownloadPromptModal}
        ownUploadState={ownUploadState}
        setOptimisticTrack={setOptimisticTrack}
        ytLinkUrl={ytLinkUrl}
        setYtLinkUrl={setYtLinkUrl}
        ytLinkStage={ytLinkStage}
        setYtLinkStage={setYtLinkStage}
        ytLinkLoading={ytLinkLoading}
        ytLinkProgress={ytLinkProgress}
        ytLinkNotice={ytLinkNotice}
        setYtLinkNotice={setYtLinkNotice}
        ytLinkPreview={ytLinkPreview}
        setYtLinkPreview={setYtLinkPreview}
        ytLinkError={ytLinkError}
        setYtLinkError={setYtLinkError}
        setYtLinkReadyTrack={setYtLinkReadyTrack}
        ytLinkTargetLib={ytLinkTargetLib}
        setYtLinkTargetLib={setYtLinkTargetLib}
        setYtModalOpen={setYtModalOpen}
        closeYtLinkModal={closeYtLinkModal}
        resolveYtLinkPreview={resolveYtLinkPreview}
        runDirectLinkDownload={runDirectLinkDownload}
        handleYtLinkSubmit={handleYtLinkSubmit}
        editingTrack={editingTrack}
        setEditingTrack={setEditingTrack}
        editForm={editForm}
        setEditForm={setEditForm}
        closeEditTrackModal={closeEditTrackModal}
        handleEditTrackSubmit={handleEditTrackSubmit}
        customPlaylists={customPlaylists}
        isLiked={isLiked}
        toggleLike={toggleLike}
        openSaveModal={openSaveModal}
        openEditTrackModal={openEditTrackModal}
        isTrackAvailableOffline={isTrackAvailableOffline}
        exportTrackFile={exportTrackFile}
        deleteOfflineTrack={deleteOfflineTrack}
        startDownload={startDownload}
        cacheOwnTrackAndConfirmDelete={cacheOwnTrackAndConfirmDelete}
        playFromList={playFromList}
        removeTrackFromPlaylist={removeTrackFromPlaylist}
        isTrackInPlaylist={isTrackInPlaylist}
        toggleTrackInPlaylist={toggleTrackInPlaylist}
        createCustomPlaylist={createCustomPlaylist}
        resolveOwnUploadId={resolveOwnUploadId}
        deleteOwnUploadEverywhere={deleteOwnUploadEverywhere}
      />

      <PlayerDock
        currentTrack={currentTrack}
        audioRef={audioRef}
        isLiked={isLiked}
        toggleLike={toggleLike}
        shuffle={shuffle}
        toggleShuffle={toggleShuffle}
        playPrev={playPrev}
        isPlaying={isPlaying}
        setIsPlaying={setIsPlaying}
        togglePlayPause={togglePlayPause}
        playNext={playNext}
        repeatMode={repeatMode}
        cycleRepeatMode={cycleRepeatMode}
        handlePlaybackTimeTick={handlePlaybackTimeTick}
        currentIndexRef={currentIndexRef}
        queueRef={queueRef}
        lastWarmedKeyRef={lastWarmedKeyRef}
        preloadUpcomingQueueBlobs={preloadUpcomingQueueBlobs}
        isPlayingRef={isPlayingRef}
        playInFlightRef={playInFlightRef}
        consecutivePlayFailuresRef={consecutivePlayFailuresRef}
        handleTrackEnded={handleTrackEnded}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isOffline={isOffline}
      />
    </div>
  );
}
