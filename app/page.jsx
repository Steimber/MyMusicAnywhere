'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { normalizeTombstoneList } from '../lib/collections-merge';
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
import { useAudioPlayer } from './hooks/useAudioPlayer';
import {
  AUDIO_CACHE_NAME,
  SHELL_CACHE_NAME,
  FORYOU_RECS_STORAGE_KEY,
  USER_STORAGE_KEY,
  LIKES_STORAGE_KEY,
  DELETED_LIKES_STORAGE_KEY,
  OFFLINE_CATALOG_KEY,
  PLAYLISTS_STORAGE_KEY,
  DELETED_PLAYLISTS_STORAGE_KEY,
  COLLECTIONS_VERSION_KEY_PREFIX,
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

  const {
    handlePlaybackTimeTick,
    preloadUpcomingQueueBlobs,
    toggleShuffle,
    playFromList,
    togglePlayPause,
    playNext,
    playPrev,
    handleTrackEnded,
    cycleRepeatMode
  } = useAudioPlayer({
    apiRef,
    isOffline,
    offlineCatalog,
    queue,
    setQueue,
    currentIndex,
    setCurrentIndex,
    currentTrack,
    isPlaying,
    setIsPlaying,
    setOptimisticTrack,
    shuffle,
    setShuffle,
    repeatMode,
    setRepeatMode,
    audioRef,
    shuffleStateRef,
    recentPlayedKeysRef,
    queueRef,
    currentIndexRef,
    isPlayingRef,
    shuffleRef,
    repeatModeRef,
    playbackSessionRef,
    inflightBlobPromisesRef,
    warmingInProgressRef,
    playInFlightRef,
    consecutivePlayFailuresRef,
    lastDirectPlayRef,
    recordListeningDeltaSync,
    getTrackStreamUrl,
    getCachedBlobUrlForTrack,
    getSyncPlayableSource,
    resolvePlayableSource,
    isTrackAvailableOffline
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
