'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { NoSleepController } from '../lib/nosleep';
import { buildSmartShuffleOrder, getShuffleTrackKey } from '../lib/shuffle';
import { mergeCollectionsSnapshots, normalizeTombstoneList } from '../lib/collections-merge';
import {
  HOUR_BUCKETS,
  applyListeningDeltaToMap,
  getHourBucketName,
  mergeListeningEntries,
  normalizeListeningEntry
} from '../lib/listening-shared';
import { readListeningStateFromIdb, writeListeningStateToIdb } from '../lib/listening-idb';
import {
  formatLocalDateKey,
  generateAutoPlaylists,
  getTopAffinityArtists,
  isRealGenre
} from '../lib/autoplaylists';
import PlayerScrubber from './components/PlayerScrubber';
import SettingsPanel from './components/SettingsPanel';
import AdminPanel from './components/AdminPanel';
import ForYouPanel from './components/ForYouPanel';

const AUDIO_CACHE_NAME = 'my-music-offline-audio-v1';
const SHELL_CACHE_NAME = 'mymusic-shell-v29';
const DEFAULT_TRACK_COVER = '/icon.svg?v=3';
const FORYOU_RECS_STORAGE_KEY = 'mma_foryou_recs_v1';
const USER_STORAGE_KEY = 'mma_cached_user_v1';
const LIKES_STORAGE_KEY = 'mma_liked_tracks_v1';
const DELETED_LIKES_STORAGE_KEY = 'mma_deleted_likes_v1';
const OFFLINE_CATALOG_KEY = 'mma_offline_catalog_v1';
const PLAYLISTS_STORAGE_KEY = 'mma_custom_playlists_v1';
const DELETED_PLAYLISTS_STORAGE_KEY = 'mma_deleted_playlists_v1';
const UNLIKED_OWN_STORAGE_KEY = 'mma_unliked_own_v1';
const SYNCED_UID_STORAGE_KEY = 'mma_synced_uid_v1';
const COLLECTIONS_DIRTY_KEY = 'mma_collections_dirty_v1';
const COLLECTIONS_VERSION_KEY_PREFIX = 'mma_collections_version_v1_';
const MAX_COLLECTION_SYNC_RETRIES = 3;
const MAX_SIMULTANEOUS_DOWNLOADS = 4;
const MAX_OWN_UPLOAD_BYTES = 50 * 1024 * 1024;
const OWN_UPLOAD_CHUNK_BYTES = Math.floor(3.5 * 1024 * 1024);
const OWN_AUDIO_ACCEPT =
  '.mp3,.m4a,.wav,.flac,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/flac,audio/x-flac';

function isPlaceholderCover(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return true;
  const trimmed = rawUrl.trim();
  const u = trimmed.toLowerCase();
  if (u.startsWith('data:image/')) return false;
  if (/^\/api\/cover\/upl_[a-f0-9]{32}$/i.test(trimmed)) return false;
  return (
    !u.startsWith('http') ||
    u.includes('/icon.svg') ||
    u.includes('/brand/logo')
  );
}

function compressArtworkUrl(rawUrl) {
  if (isPlaceholderCover(rawUrl)) return DEFAULT_TRACK_COVER;
  const trimmed = rawUrl.trim();
  if (trimmed.toLowerCase().startsWith('data:image/')) {
    return trimmed;
  }
  if (/^\/api\/cover\/upl_[a-f0-9]{32}$/i.test(trimmed)) {
    return trimmed;
  }
  // Spotify CDN: replace 640x640 (ab67616d0000b273) with compact 300x300 (ab67616d00001e02)
  if (rawUrl.includes('i.scdn.co/image/')) {
    return rawUrl.replace('ab67616d0000b273', 'ab67616d00001e02');
  }
  // Apple/iTunes CDN: use 100x100bb.jpg (~4 KB per thumbnail instead of ~80 KB 600x600bb.jpg)
  if (rawUrl.includes('mzstatic.com')) {
    return rawUrl.replace(/\d+x\d+bb\.(jpg|png|webp)/i, '100x100bb.jpg');
  }
  // Deezer CDN: use compact 250x250 thumbnail
  if (rawUrl.includes('dzcdn.net/images/cover/')) {
    return rawUrl.replace(/\/\d+x\d+(-000000-\d+-0-0)?\.(jpg|png)/i, '/250x250-000000-80-0-0.jpg');
  }
  return rawUrl;
}

const dedupKeyMemo = new Map();

function getTrackDedupKey(track) {
  if (!track) return '';
  if (track.source === 'own' && String(track.id || '').startsWith('upl_')) {
    return `own:${track.id}`;
  }
  const memoSignature = `${track.title || ''}\0${track.artist || ''}\0${track.id || ''}`;
  const cached = dedupKeyMemo.get(memoSignature);
  if (cached !== undefined) return cached;

  const normTitle = String(track.title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(
      /\s*[-–—]\s*(remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|radio\s+edit|album\s+version|single\s+version).*/i,
      ''
    )
    .replace(/\s*\((remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|feat\.?[^)]+|ft\.?[^)]+)\)/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const normArtist = String(track.artist || '')
    .split(/[,;&]/)[0]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const computed = !normTitle ? String(track.id || '') : `${normTitle}|${normArtist}`;
  if (dedupKeyMemo.size > 5000) dedupKeyMemo.clear();
  dedupKeyMemo.set(memoSignature, computed);
  return computed;
}

function deduplicateTracksList(list) {
  if (!Array.isArray(list)) return [];
  const byKey = new Map();
  const result = [];

  for (const item of list) {
    if (!item || !item.title) continue;
    const key = getTrackDedupKey(item);
    if (!byKey.has(key)) {
      const cloned = { ...item };
      byKey.set(key, cloned);
      result.push(cloned);
    } else {
      // Merge useful fields (downloaded file, real cover, duration, previewUrl) into the existing entry
      const existing = byKey.get(key);
      if (!existing.filename && item.filename) existing.filename = item.filename;
      if (!existing.streamUrl && item.streamUrl) existing.streamUrl = item.streamUrl;
      if (!existing.source && item.source) existing.source = item.source;
      if (item.fileDeleted !== undefined) {
        existing.fileDeleted = Boolean(existing.fileDeleted || item.fileDeleted);
      }
      if (!existing.uploadId && item.uploadId) existing.uploadId = item.uploadId;
      if (isPlaceholderCover(existing.artwork) && !isPlaceholderCover(item.artwork)) {
        existing.artwork = item.artwork;
      }
      if ((!existing.duration || existing.duration === '—') && item.duration && item.duration !== '—') {
        existing.duration = item.duration;
      }
      if (!existing.previewUrl && item.previewUrl) {
        existing.previewUrl = item.previewUrl;
      }
    }
  }

  return result;
}

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
    case 'upload':
      return (
        <svg {...props}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
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
    case 'image':
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case 'youtube':
      return (
        <svg {...props}>
          <rect x="2" y="4" width="20" height="16" rx="4" ry="4" />
          <polygon points="10 9 15 12 10 15 10 9" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...props}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      );
    case 'sparkles':
      return (
        <svg {...props}>
          <path d="M12 3l1.9 5.3L19 10.2l-5.1 1.9L12 17.4l-1.9-5.3L5 10.2l5.1-1.9L12 3z" />
          <path d="M19 3v4M17 5h4M6 17v3M4.5 18.5h3" />
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
  const [visibleLibraryCount, setVisibleLibraryCount] = useState(10);
  const libraryLoadMoreRef = useRef(null);
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
  const [adminData, setAdminData] = useState({ users: [], invites: [], storage: null, ytCookies: null });
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

  function findOfflineItem(track) {
    if (!track) return null;
    return (
      offlineLookup.byId.get(String(track.id)) ||
      (track.filename ? offlineLookup.byFile.get(track.filename) : null) ||
      offlineLookup.byDedup.get(getTrackDedupKey(track)) ||
      null
    );
  }

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

  // Reset rendered library DOM window to 10 tracks when switching library or searching
  useEffect(() => {
    setVisibleLibraryCount(10);
  }, [selectedLibrary, libraryQuery, activeTab]);

  // Progressive scroll loader for Library view (loads +15 tracks as user approaches bottom)
  useEffect(() => {
    if (activeTab !== 'library') return;
    const node = libraryLoadMoreRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const scrollRoot = node.closest('.track-list') || null;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) {
          setVisibleLibraryCount(prev => prev + 15);
        }
      },
      { root: scrollRoot, rootMargin: '280px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeTab, selectedLibrary, libraryQuery, likedTracks.length, offlineCatalog.length, customPlaylists, visibleLibraryCount]);

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

  // ==================== PERSISTENT STORAGE, CLOUD SYNC & JSON BACKUP ====================
  async function ensurePersistentStorage(manualClick = false) {
    if (typeof navigator === 'undefined' || !navigator.storage) {
      setStoragePersisted('unsupported');
      return;
    }
    try {
      if (typeof navigator.storage.persisted === 'function') {
        const already = await navigator.storage.persisted();
        if (already) {
          setStoragePersisted('granted');
          if (manualClick) {
            setStoragePersistMsg(
              'El navegador protege las canciones guardadas frente a limpiezas automáticas de espacio.'
            );
          }
          return;
        }
      }
      if (typeof navigator.storage.persist === 'function') {
        const granted = await navigator.storage.persist();
        setStoragePersisted(granted ? 'granted' : 'prompt');
        if (manualClick) {
          setStoragePersistMsg(
            granted
              ? 'Protección activada: tus canciones Offline no se borrarán automáticamente.'
              : 'El navegador aún no concedió almacenamiento persistente. Instalar la app en la pantalla de inicio suele habilitarlo automáticamente.'
          );
        }
      } else {
        setStoragePersisted('unsupported');
      }
    } catch {
      setStoragePersisted('prompt');
    }
  }

  function resolveOwnUploadId(track) {
    if (!track) return null;
    const direct = String(track.uploadId || '').trim();
    if (/^upl_[a-f0-9]{32}$/.test(direct)) return direct;
    const byId = String(track.id || '').trim();
    if (/^upl_[a-f0-9]{32}$/.test(byId)) return byId;
    const byFile = String(track.filename || '')
      .trim()
      .replace(/\.(m4a|mp3|wav|flac|opus)$/i, '');
    if (/^upl_[a-f0-9]{32}$/.test(byFile)) return byFile;
    return null;
  }

  async function persistOwnUploadMetadataToServer(trackOrId, patch) {
    if (!patch || typeof patch !== 'object') return;
    const activeUser = userRef.current;
    if (!activeUser || activeUser.offline || isOfflineRef.current) return;
    const uploadId =
      typeof trackOrId === 'string' && /^upl_[a-f0-9]{32}$/.test(trackOrId)
        ? trackOrId
        : resolveOwnUploadId(trackOrId);
    if (!uploadId) return;
    const body = {};
    if (typeof patch.title === 'string' && patch.title.trim()) body.title = patch.title.trim();
    if (typeof patch.artist === 'string' && patch.artist.trim()) body.artist = patch.artist.trim();
    if (typeof patch.album === 'string' && patch.album.trim()) body.album = patch.album.trim();
    if (typeof patch.artwork === 'string' && patch.artwork.trim()) body.artwork = patch.artwork.trim();
    if (Object.keys(body).length === 0) return;
    try {
      await fetch(`/api/upload/${encodeURIComponent(uploadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch {}
  }

  function markCollectionsDirtyOffline() {
    try {
      localStorage.setItem(COLLECTIONS_DIRTY_KEY, '1');
    } catch {}
  }

  function persistDeletedLikes(nextDeleted) {
    const clean = normalizeTombstoneList(nextDeleted);
    deletedLikesRef.current = clean;
    try {
      localStorage.setItem(DELETED_LIKES_STORAGE_KEY, JSON.stringify(clean));
    } catch {}
    return clean;
  }

  function persistDeletedPlaylists(nextDeleted) {
    const clean = normalizeTombstoneList(nextDeleted);
    deletedPlaylistsRef.current = clean;
    try {
      localStorage.setItem(DELETED_PLAYLISTS_STORAGE_KEY, JSON.stringify(clean));
    } catch {}
    return clean;
  }

  function persistCollectionsVersion(userId, versionNum) {
    const safeVersion = Number.isInteger(versionNum) && versionNum >= 0 ? versionNum : 0;
    collectionsVersionRef.current = safeVersion;
    if (userId) {
      try {
        localStorage.setItem(`${COLLECTIONS_VERSION_KEY_PREFIX}${userId}`, String(safeVersion));
      } catch {}
    }
  }

  function reattachOfflinePointers(list) {
    return deduplicateTracksList(list).map(tr => {
      const off = findOfflineItem(tr);
      if (!off) return tr;
      return {
        ...tr,
        filename: off.filename || tr.filename || null,
        streamUrl: off.streamUrl || tr.streamUrl || null,
        artwork: !isPlaceholderCover(tr.artwork) ? tr.artwork : off.artwork || tr.artwork
      };
    });
  }

  function applyMergedSnapshotToClientState(userId, localSnap, serverSnap) {
    const merged = mergeCollectionsSnapshots(localSnap, serverSnap);
    const resolvedLikes = reattachOfflinePointers(merged.likedTracks);
    const resolvedPlaylists = (merged.customPlaylists || []).map(pl => ({
      ...pl,
      tracks: reattachOfflinePointers(pl.tracks || []),
      deletedTracks: normalizeTombstoneList(pl.deletedTracks)
    }));

    setLikedTracks(resolvedLikes);
    likedTracksRef.current = resolvedLikes;
    persistDeletedLikes(merged.deletedLikes);
    setCustomPlaylists(resolvedPlaylists);
    customPlaylistsRef.current = resolvedPlaylists;
    persistDeletedPlaylists(merged.deletedPlaylists);

    if (Number.isInteger(serverSnap?.version) && serverSnap.version >= 0) {
      persistCollectionsVersion(userId, serverSnap.version);
    }

    try {
      localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(resolvedLikes));
      localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(resolvedPlaylists));
    } catch {}

    return {
      likedTracks: resolvedLikes,
      deletedLikes: deletedLikesRef.current,
      customPlaylists: resolvedPlaylists,
      deletedPlaylists: deletedPlaylistsRef.current
    };
  }

  async function pushCollectionsToServerNow(likesOverride = null, playlistsOverride = null) {
    const activeUser = userRef.current;
    if (!activeUser || activeUser.offline || !activeUser.id || isOfflineRef.current) {
      markCollectionsDirtyOffline();
      return false;
    }

    // Hold saves until any active focus/visibility GET + merge finishes
    if (reconcilingCollectionsRef.current) {
      pendingSaveAfterReconcileRef.current = true;
      markCollectionsDirtyOffline();
      return false;
    }

    if (pushInFlightRef.current) {
      pendingSaveAfterReconcileRef.current = true;
      markCollectionsDirtyOffline();
      return false;
    }

    pushInFlightRef.current = true;
    setSyncState(prev => ({ ...prev, status: 'syncing' }));

    try {
      let currentLikes = sanitizeLikedTracksList(likesOverride ?? likedTracksRef.current);
      let currentPlaylists = Array.isArray(playlistsOverride ?? customPlaylistsRef.current)
        ? (playlistsOverride ?? customPlaylistsRef.current).map(pl => ({
            ...pl,
            tracks: sanitizeLikedTracksList(deduplicateTracksList(pl.tracks || [])),
            deletedTracks: normalizeTombstoneList(pl.deletedTracks)
          }))
        : [];

      for (let retry = 0; retry <= MAX_COLLECTION_SYNC_RETRIES; retry++) {
        const baseVersion = collectionsVersionRef.current;
        const payload = {
          baseVersion,
          likedTracks: currentLikes,
          deletedLikes: deletedLikesRef.current,
          customPlaylists: currentPlaylists,
          deletedPlaylists: deletedPlaylistsRef.current
        };

        const res = await fetch('/api/collections', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.status === 409) {
          const conflictBody = await res.json().catch(() => ({}));
          const mergedState = applyMergedSnapshotToClientState(
            activeUser.id,
            {
              likedTracks: currentLikes,
              deletedLikes: deletedLikesRef.current,
              customPlaylists: currentPlaylists,
              deletedPlaylists: deletedPlaylistsRef.current
            },
            conflictBody
          );

          currentLikes = sanitizeLikedTracksList(mergedState.likedTracks);
          currentPlaylists = mergedState.customPlaylists.map(pl => ({
            ...pl,
            tracks: sanitizeLikedTracksList(deduplicateTracksList(pl.tracks || [])),
            deletedTracks: normalizeTombstoneList(pl.deletedTracks)
          }));

          if (retry < MAX_COLLECTION_SYNC_RETRIES) {
            continue;
          }

          markCollectionsDirtyOffline();
          setSyncState(prev => ({ ...prev, status: 'conflict' }));
          setSyncConflictNotice(
            'No se pudo completar el guardado en la nube tras 3 reintentos por cambios simultáneos en otro dispositivo. Tus canciones y playlists locales se conservaron intactas.'
          );
          return false;
        }

        if (!res.ok) {
          markCollectionsDirtyOffline();
          setSyncState(prev => ({ ...prev, status: 'error' }));
          return false;
        }

        const data = await res.json().catch(() => ({}));
        if (Number.isInteger(data.version)) {
          persistCollectionsVersion(activeUser.id, data.version);
        }
        try {
          localStorage.setItem(SYNCED_UID_STORAGE_KEY, String(activeUser.id));
          localStorage.removeItem(COLLECTIONS_DIRTY_KEY);
        } catch {}
        setSyncConflictNotice('');
        setSyncState({ status: 'synced', updatedAt: data.updatedAt || Date.now() });
        return true;
      }
      return false;
    } catch {
      markCollectionsDirtyOffline();
      setSyncState(prev => ({ ...prev, status: 'error' }));
      return false;
    } finally {
      pushInFlightRef.current = false;
      if (pendingSaveAfterReconcileRef.current && !reconcilingCollectionsRef.current) {
        pendingSaveAfterReconcileRef.current = false;
        scheduleCollectionsSync(false);
      }
    }
  }

  function scheduleCollectionsSync(immediate = false, likesOverride = null, playlistsOverride = null) {
    const activeUser = userRef.current;
    if (!activeUser || activeUser.offline || !activeUser.id) return;
    markCollectionsDirtyOffline();
    if (isOfflineRef.current || collectionsHydratedForUserRef.current !== String(activeUser.id)) {
      return;
    }
    if (reconcilingCollectionsRef.current) {
      pendingSaveAfterReconcileRef.current = true;
      return;
    }
    if (syncDebounceTimerRef.current) {
      clearTimeout(syncDebounceTimerRef.current);
      syncDebounceTimerRef.current = null;
    }
    if (immediate) {
      pushCollectionsToServerNow(likesOverride, playlistsOverride);
      return;
    }
    syncDebounceTimerRef.current = setTimeout(() => {
      syncDebounceTimerRef.current = null;
      pushCollectionsToServerNow();
    }, 650);
  }

  async function reconcileCollectionsOnAppReturn() {
    const activeUser = userRef.current;
    if (!activeUser || activeUser.offline || !activeUser.id || isOfflineRef.current) return;
    if (collectionsHydratedForUserRef.current !== String(activeUser.id)) return;
    if (reconcilingCollectionsRef.current) return;

    const now = Date.now();
    if (now - lastFocusReconcileAtRef.current < 1200) return;
    lastFocusReconcileAtRef.current = now;

    let hadUnsavedLocal = pendingSaveAfterReconcileRef.current;
    if (syncDebounceTimerRef.current) {
      clearTimeout(syncDebounceTimerRef.current);
      syncDebounceTimerRef.current = null;
      hadUnsavedLocal = true;
    }
    try {
      if (localStorage.getItem(COLLECTIONS_DIRTY_KEY) === '1') {
        hadUnsavedLocal = true;
      }
    } catch {}

    reconcilingCollectionsRef.current = true;
    try {
      const res = await fetch('/api/collections', { cache: 'no-store' });
      if (!res.ok) return;
      const serverData = await res.json();

      if (!serverData.hasSnapshot) {
        persistCollectionsVersion(activeUser.id, 0);
        return;
      }

      const prevServerVer = collectionsVersionRef.current;
      applyMergedSnapshotToClientState(
        activeUser.id,
        {
          likedTracks: sanitizeLikedTracksList(likedTracksRef.current),
          deletedLikes: deletedLikesRef.current,
          customPlaylists: (customPlaylistsRef.current || []).map(pl => ({
            ...pl,
            tracks: sanitizeLikedTracksList(deduplicateTracksList(pl.tracks || [])),
            deletedTracks: normalizeTombstoneList(pl.deletedTracks)
          })),
          deletedPlaylists: deletedPlaylistsRef.current
        },
        serverData
      );

      if (!hadUnsavedLocal && serverData.version >= prevServerVer) {
        setSyncState({ status: 'synced', updatedAt: serverData.updatedAt || Date.now() });
      }
    } catch {
      // Keep local state untouched on transient network errors
    } finally {
      reconcilingCollectionsRef.current = false;
      if (hadUnsavedLocal || pendingSaveAfterReconcileRef.current) {
        pendingSaveAfterReconcileRef.current = false;
        pushCollectionsToServerNow();
      }
    }
  }

  function mergePlaylistsByIdOrName(primaryList, secondaryList) {
    const out = [];
    const byId = new Map();
    const byName = new Map();

    for (const pl of [...(primaryList || []), ...(secondaryList || [])]) {
      if (!pl || !pl.name) continue;
      const normName = String(pl.name).trim().toLowerCase();
      const existing = byId.get(String(pl.id)) || byName.get(normName);
      if (!existing) {
        const copy = {
          id: pl.id || `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: String(pl.name).trim(),
          createdAt: Number(pl.createdAt) || Date.now(),
          updatedAt: Number(pl.updatedAt) || Number(pl.createdAt) || Date.now(),
          tracks: deduplicateTracksList(pl.tracks || []),
          deletedTracks: normalizeTombstoneList(pl.deletedTracks)
        };
        byId.set(String(copy.id), copy);
        byName.set(normName, copy);
        out.push(copy);
      } else {
        existing.tracks = deduplicateTracksList([...(existing.tracks || []), ...(pl.tracks || [])]);
      }
    }
    return out;
  }

  async function syncCollectionsWithServer(userId) {
    if (!userId || isOfflineRef.current) return;
    reconcilingCollectionsRef.current = true;
    setSyncState(prev => ({ ...prev, status: 'syncing' }));
    try {
      const res = await fetch('/api/collections', { cache: 'no-store' });
      if (!res.ok) {
        setSyncState(prev => ({ ...prev, status: 'idle' }));
        return;
      }
      const data = await res.json();
      let localLikes = likedTracksRef.current;
      let localPlaylists = customPlaylistsRef.current;
      try {
        const rawL = localStorage.getItem(LIKES_STORAGE_KEY);
        if (rawL) localLikes = deduplicateTracksList(sanitizeLikedTracksList(JSON.parse(rawL)));
      } catch {}
      try {
        const rawP = localStorage.getItem(PLAYLISTS_STORAGE_KEY);
        if (rawP) {
          const parsedP = JSON.parse(rawP);
          if (Array.isArray(parsedP)) {
            localPlaylists = parsedP.map(pl => ({
              ...pl,
              tracks: deduplicateTracksList(pl.tracks || []),
              deletedTracks: normalizeTombstoneList(pl.deletedTracks)
            }));
          }
        }
      } catch {}

      let syncedUid = '';
      let wasDirtyOffline = false;
      try {
        syncedUid = localStorage.getItem(SYNCED_UID_STORAGE_KEY) || '';
        wasDirtyOffline = localStorage.getItem(COLLECTIONS_DIRTY_KEY) === '1';
      } catch {}

      collectionsHydratedForUserRef.current = String(userId);

      // If switching to a different user on the same browser without prior sync for that user,
      // do not leak the previous account's cached local tracks into the new user's snapshot.
      const isDifferentPreviousAccount = Boolean(syncedUid && syncedUid !== String(userId));
      if (isDifferentPreviousAccount) {
        localLikes = [];
        localPlaylists = [];
        persistDeletedLikes([]);
        persistDeletedPlaylists([]);
      }

      if (!data.hasSnapshot) {
        persistCollectionsVersion(userId, 0);
        try {
          localStorage.setItem(SYNCED_UID_STORAGE_KEY, String(userId));
          localStorage.removeItem(COLLECTIONS_DIRTY_KEY);
        } catch {}
        reconcilingCollectionsRef.current = false;
        if (localLikes.length > 0 || localPlaylists.length > 0) {
          await pushCollectionsToServerNow(localLikes, localPlaylists);
        } else {
          setSyncState({ status: 'synced', updatedAt: Date.now() });
        }
        return;
      }

      const localSnapForMerge =
        wasDirtyOffline || !syncedUid
          ? {
              likedTracks: localLikes,
              deletedLikes: deletedLikesRef.current,
              customPlaylists: localPlaylists,
              deletedPlaylists: deletedPlaylistsRef.current
            }
          : {
              likedTracks: [],
              deletedLikes: [],
              customPlaylists: [],
              deletedPlaylists: []
            };

      const merged = applyMergedSnapshotToClientState(userId, localSnapForMerge, data);

      try {
        localStorage.setItem(SYNCED_UID_STORAGE_KEY, String(userId));
        if (!wasDirtyOffline) {
          localStorage.removeItem(COLLECTIONS_DIRTY_KEY);
        }
      } catch {}

      reconcilingCollectionsRef.current = false;

      if (
        (wasDirtyOffline || (!syncedUid && (localLikes.length > 0 || localPlaylists.length > 0)))
      ) {
        await pushCollectionsToServerNow(merged.likedTracks, merged.customPlaylists);
      } else {
        setSyncState({ status: 'synced', updatedAt: data.updatedAt || Date.now() });
      }
    } catch {
      setSyncState(prev => ({ ...prev, status: 'error' }));
    } finally {
      reconcilingCollectionsRef.current = false;
    }
  }

  // ==================== LISTENING HISTORY (INDEXEDDB + /api/listening SYNC) ====================
  function subtractFlushedListeningDelta(currentDelta = {}, flushedDelta = {}) {
    const remaining = {};
    for (const [trackId, curRaw] of Object.entries(currentDelta)) {
      const cur = normalizeListeningEntry(curRaw);
      const sent = flushedDelta[trackId] ? normalizeListeningEntry(flushedDelta[trackId]) : null;
      if (!sent) {
        remaining[trackId] = cur;
        continue;
      }
      const remPlays = Math.max(0, cur.plays - sent.plays);
      const remSkips = Math.max(0, cur.skips - sent.skips);
      const remCompletes = Math.max(0, cur.completes - sent.completes);
      const remBuckets = {};
      let hasBucket = false;
      for (const slot of HOUR_BUCKETS) {
        remBuckets[slot] = Math.max(0, (cur.hourBuckets[slot] || 0) - (sent.hourBuckets[slot] || 0));
        if (remBuckets[slot] > 0) hasBucket = true;
      }
      if (remPlays > 0 || remSkips > 0 || remCompletes > 0 || hasBucket) {
        remaining[trackId] = {
          plays: remPlays,
          skips: remSkips,
          completes: remCompletes,
          lastPlayedAt: cur.lastPlayedAt,
          hourBuckets: remBuckets
        };
      }
    }
    return remaining;
  }

  async function pushListeningHistoryNow() {
    const activeUser = userRef.current;
    if (!activeUser || activeUser.offline || !activeUser.id || isOfflineRef.current) {
      return false;
    }
    if (listeningPushInFlightRef.current) return false;

    const uid = String(activeUser.id);
    if (listeningStateRef.current.userId !== uid) return false;
    if (Object.keys(listeningStateRef.current.pendingDelta || {}).length === 0) return true;

    listeningPushInFlightRef.current = true;
    try {
      for (let retry = 0; retry <= MAX_COLLECTION_SYNC_RETRIES; retry++) {
        const snapshotDelta = { ...(listeningStateRef.current.pendingDelta || {}) };
        if (Object.keys(snapshotDelta).length === 0) return true;

        const baseVersion = listeningStateRef.current.version || 0;
        const candidateEntries = mergeListeningEntries(
          listeningStateRef.current.syncedEntries,
          snapshotDelta
        );

        const res = await fetch('/api/listening', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseVersion,
            entries: candidateEntries
          })
        });

        if (res.status === 409) {
          const conflictBody = await res.json().catch(() => ({}));
          const serverEntries =
            conflictBody && typeof conflictBody.entries === 'object' ? conflictBody.entries : {};
          const serverVer = Number.isInteger(conflictBody?.version) ? conflictBody.version : 0;

          listeningStateRef.current = {
            ...listeningStateRef.current,
            version: serverVer,
            syncedEntries: serverEntries
          };
          setListeningEntries(
            mergeListeningEntries(serverEntries, listeningStateRef.current.pendingDelta)
          );
          await writeListeningStateToIdb(uid, listeningStateRef.current);

          if (retry < MAX_COLLECTION_SYNC_RETRIES) {
            continue;
          }
          return false;
        }

        if (!res.ok) {
          return false;
        }

        const data = await res.json().catch(() => ({}));
        const nextVer = Number.isInteger(data.version) ? data.version : baseVersion + 1;
        const leftoverDelta = subtractFlushedListeningDelta(
          listeningStateRef.current.pendingDelta,
          snapshotDelta
        );

        listeningStateRef.current = {
          userId: uid,
          version: nextVer,
          syncedEntries: candidateEntries,
          pendingDelta: leftoverDelta
        };
        setListeningEntries(mergeListeningEntries(candidateEntries, leftoverDelta));
        await writeListeningStateToIdb(uid, listeningStateRef.current);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      listeningPushInFlightRef.current = false;
    }
  }

  function scheduleListeningSync() {
    const activeUser = userRef.current;
    if (!activeUser || activeUser.offline || !activeUser.id || isOfflineRef.current) return;
    if (listeningSyncTimerRef.current) {
      clearTimeout(listeningSyncTimerRef.current);
    }
    listeningSyncTimerRef.current = setTimeout(() => {
      listeningSyncTimerRef.current = null;
      pushListeningHistoryNow();
    }, 2500);
  }

  async function hydrateAndSyncListeningHistory(userId) {
    const uid = String(userId || 'offline_local').trim() || 'offline_local';
    try {
      const localRecord = await readListeningStateFromIdb(uid);
      listeningStateRef.current = {
        userId: uid,
        version: localRecord.version || 0,
        syncedEntries: localRecord.syncedEntries || {},
        pendingDelta: localRecord.pendingDelta || {}
      };
      setListeningEntries(
        mergeListeningEntries(
          listeningStateRef.current.syncedEntries,
          listeningStateRef.current.pendingDelta
        )
      );

      if (isOfflineRef.current || uid === 'offline_local' || userRef.current?.offline) {
        return;
      }

      const res = await fetch('/api/listening', { cache: 'no-store' });
      if (!res.ok) return;
      const serverData = await res.json();
      const serverVer = Number.isInteger(serverData.version) ? serverData.version : 0;
      const serverEntries =
        serverData && typeof serverData.entries === 'object' ? serverData.entries : {};

      listeningStateRef.current = {
        userId: uid,
        version: serverVer,
        syncedEntries: serverEntries,
        pendingDelta: listeningStateRef.current.pendingDelta
      };
      setListeningEntries(
        mergeListeningEntries(serverEntries, listeningStateRef.current.pendingDelta)
      );
      await writeListeningStateToIdb(uid, listeningStateRef.current);

      if (Object.keys(listeningStateRef.current.pendingDelta || {}).length > 0) {
        await pushListeningHistoryNow();
      }
    } catch {}
  }

  function recordListeningDeltaSync(trackId, delta) {
    const cleanId = String(trackId || '').trim();
    if (!cleanId) return;
    const uid = String(userRef.current?.id || 'offline_local');
    if (listeningStateRef.current.userId !== uid) {
      listeningStateRef.current.userId = uid;
    }
    const nextPending = applyListeningDeltaToMap(
      listeningStateRef.current.pendingDelta,
      cleanId,
      delta
    );
    listeningStateRef.current = {
      ...listeningStateRef.current,
      pendingDelta: nextPending
    };
    const combined = mergeListeningEntries(listeningStateRef.current.syncedEntries, nextPending);
    setListeningEntries(combined);
    // Persist asynchronously in background — never block synchronous <audio> calls
    writeListeningStateToIdb(uid, listeningStateRef.current).catch(() => {});
    scheduleListeningSync();
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

  function handleExportBackupJson() {
    setBackupMsg({ type: '', text: '' });
    try {
      const payload = {
        app: 'MyMusicAnywhere',
        version: 1,
        exportedAt: new Date().toISOString(),
        likedTracks: sanitizeLikedTracksList(likedTracksRef.current),
        customPlaylists: (customPlaylistsRef.current || []).map(pl => ({
          id: pl.id,
          name: pl.name,
          createdAt: pl.createdAt || Date.now(),
          tracks: sanitizeLikedTracksList(deduplicateTracksList(pl.tracks || []))
        }))
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mineral-music-respaldo-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1200);
      setBackupMsg({
        type: 'ok',
        text: `Respaldo exportado (${payload.likedTracks.length} en Favoritos y ${payload.customPlaylists.length} librerías).`
      });
    } catch {
      setBackupMsg({ type: 'err', text: 'No se pudo generar el archivo de respaldo.' });
    }
  }

  async function handleImportBackupJson(file) {
    if (!file) return;
    setBackupMsg({ type: '', text: '' });
    if (file.size > 5 * 1024 * 1024) {
      setBackupMsg({ type: 'err', text: 'El archivo JSON supera el límite permitido de 5 MB.' });
      return;
    }
    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText);
      const incomingLikes = Array.isArray(parsed?.likedTracks)
        ? sanitizeLikedTracksList(parsed.likedTracks)
        : Array.isArray(parsed)
        ? sanitizeLikedTracksList(parsed)
        : null;
      const incomingPlaylists = Array.isArray(parsed?.customPlaylists)
        ? parsed.customPlaylists
        : [];

      if (!incomingLikes && incomingPlaylists.length === 0) {
        setBackupMsg({
          type: 'err',
          text: 'El archivo JSON no contiene librerías válidas (likedTracks o customPlaylists).'
        });
        return;
      }

      const mergedLikes = deduplicateTracksList([
        ...(incomingLikes || []),
        ...likedTracksRef.current
      ]);
      const mergedPlaylists = mergePlaylistsByIdOrName(
        customPlaylistsRef.current,
        incomingPlaylists
      );

      setLikedTracks(mergedLikes);
      likedTracksRef.current = mergedLikes;
      setCustomPlaylists(mergedPlaylists);
      customPlaylistsRef.current = mergedPlaylists;

      try {
        localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(mergedLikes));
        localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(mergedPlaylists));
      } catch {}

      scheduleCollectionsSync(true, mergedLikes, mergedPlaylists);
      setBackupMsg({
        type: 'ok',
        text: `Respaldo restaurado: ${mergedLikes.length} canciones en Favoritos y ${mergedPlaylists.length} librerías.`
      });

      const allImported = [
        ...(incomingLikes || []),
        ...incomingPlaylists.flatMap(p => p?.tracks || [])
      ];
      if (allImported.some(t => isPlaceholderCover(t?.artwork))) {
        syncMissingCoversForList(allImported, false);
      }
    } catch {
      setBackupMsg({
        type: 'err',
        text: 'No se pudo leer el respaldo. Verifica que sea un archivo JSON válido.'
      });
    }
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

  async function saveYtCookiesContent(rawContent) {
    setYtCookiesBusy(true);
    setYtCookiesMsg({ type: '', text: '' });
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_yt_cookies',
          content: rawContent,
          cookiesText: rawContent
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setYtCookiesMsg({ type: 'error', text: data.error || 'No se pudieron guardar las cookies.' });
      } else {
        setYtCookiesText('');
        setYtCookiesMsg({
          type: 'ok',
          text: `Cookies de YouTube activas (${data.ytCookies?.cookieLines || 0} entradas guardadas en el servidor).`
        });
        fetchAdminData();
      }
    } catch {
      setYtCookiesMsg({ type: 'error', text: 'Error de red al guardar cookies.' });
    } finally {
      setYtCookiesBusy(false);
    }
  }

  async function handleClearYtCookies() {
    setYtCookiesBusy(true);
    setYtCookiesMsg({ type: '', text: '' });
    try {
      await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_yt_cookies' })
      });
      setYtCookiesMsg({ type: 'ok', text: 'Cookies de YouTube eliminadas del servidor.' });
      fetchAdminData();
    } catch {
      setYtCookiesMsg({ type: 'error', text: 'No se pudieron eliminar las cookies.' });
    } finally {
      setYtCookiesBusy(false);
    }
  }

  // ==================== LIBRARIES & OFFLINE PERSISTENCE ====================
  function persistLikes(nextLikes) {
    const clean = deduplicateTracksList(nextLikes);
    setLikedTracks(clean);
    likedTracksRef.current = clean;
    try {
      localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(clean));
    } catch {}
    scheduleCollectionsSync();
  }

  function persistOfflineCatalog(nextOffline) {
    const clean = deduplicateTracksList(nextOffline);
    setOfflineCatalog(clean);
    try {
      localStorage.setItem(OFFLINE_CATALOG_KEY, JSON.stringify(clean));
    } catch {}
  }

  function persistCustomPlaylists(nextPlaylists) {
    const cleanPls = Array.isArray(nextPlaylists)
      ? nextPlaylists.map(pl => ({
          ...pl,
          tracks: deduplicateTracksList(pl.tracks || [])
        }))
      : [];
    setCustomPlaylists(cleanPls);
    customPlaylistsRef.current = cleanPls;
    try {
      localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(cleanPls));
    } catch {}
    scheduleCollectionsSync();
  }

  function isLiked(trackId) {
    return likedLookup.byId.has(String(trackId));
  }

  function isTrackInPlaylist(playlistId, trackId) {
    const pl = customPlaylists.find(p => p.id === playlistId);
    if (!pl) return false;
    return pl.tracks.some(t => String(t.id) === String(trackId));
  }

  function toggleLike(track) {
    const now = Date.now();
    if (isLiked(track.id)) {
      if (track?.source === 'own' && String(track.id || '').startsWith('upl_')) {
        try {
          const raw = JSON.parse(localStorage.getItem(UNLIKED_OWN_STORAGE_KEY) || '[]');
          const nextUnliked = Array.from(new Set([...(Array.isArray(raw) ? raw : []), String(track.id)]));
          localStorage.setItem(UNLIKED_OWN_STORAGE_KEY, JSON.stringify(nextUnliked));
        } catch {}
      }
      persistDeletedLikes([
        { id: String(track.id), deletedAt: now },
        ...deletedLikesRef.current
      ]);
      persistLikes(likedTracks.filter(t => String(t.id) !== String(track.id)));
    } else {
      if (track?.source === 'own' && String(track.id || '').startsWith('upl_')) {
        try {
          const raw = JSON.parse(localStorage.getItem(UNLIKED_OWN_STORAGE_KEY) || '[]');
          if (Array.isArray(raw) && raw.includes(String(track.id))) {
            localStorage.setItem(
              UNLIKED_OWN_STORAGE_KEY,
              JSON.stringify(raw.filter(id => id !== String(track.id)))
            );
          }
        } catch {}
      }
      persistDeletedLikes(
        deletedLikesRef.current.filter(item => String(item.id) !== String(track.id))
      );
      const existingDl = downloads[track.id];
      const offMatch = offlineCatalog.find(t => String(t.id) === String(track.id));
      const filename = existingDl?.filename || offMatch?.filename || track.filename || null;
      const entry = {
        ...track,
        addedAt: now,
        updatedAt: now,
        filename,
        streamUrl: filename
          ? `/api/stream?file=${encodeURIComponent(filename)}`
          : track.streamUrl || null
      };
      persistLikes([entry, ...likedTracks]);
      if (isPlaceholderCover(entry.artwork)) {
        syncMissingCoversForList([entry], false);
      }
    }
  }

  function createCustomPlaylist(name, initialTracks = []) {
    const clean = (name || '').trim();
    if (!clean) return null;
    const now = Date.now();
    const dedupedInitial = deduplicateTracksList(initialTracks).map(tr => ({
      ...tr,
      addedAt: Number(tr.addedAt) || now,
      updatedAt: Number(tr.updatedAt) || now
    }));
    const existingPl = customPlaylists.find(
      p => String(p.name || '').trim().toLowerCase() === clean.toLowerCase()
    );
    if (existingPl) {
      const addedIds = new Set(dedupedInitial.map(tr => String(tr.id)));
      const mergedTracks = deduplicateTracksList([...dedupedInitial, ...(existingPl.tracks || [])]);
      const updatedPl = {
        ...existingPl,
        updatedAt: now,
        tracks: mergedTracks,
        deletedTracks: normalizeTombstoneList(existingPl.deletedTracks).filter(
          d => !addedIds.has(String(d.id))
        )
      };
      const next = customPlaylists.map(p => (p.id === existingPl.id ? updatedPl : p));
      persistCustomPlaylists(next);
      if (dedupedInitial.some(t => isPlaceholderCover(t?.artwork))) {
        syncMissingCoversForList(dedupedInitial, false);
      }
      return updatedPl;
    }
    const newPl = {
      id: `pl_${now}_${Math.random().toString(36).slice(2, 6)}`,
      name: clean,
      createdAt: now,
      updatedAt: now,
      tracks: dedupedInitial,
      deletedTracks: []
    };
    const next = [...customPlaylists, newPl];
    persistCustomPlaylists(next);
    if (dedupedInitial.some(t => isPlaceholderCover(t?.artwork))) {
      syncMissingCoversForList(dedupedInitial, false);
    }
    return newPl;
  }

  function deleteCustomPlaylist(playlistId) {
    const now = Date.now();
    persistDeletedPlaylists([
      { id: String(playlistId), deletedAt: now },
      ...deletedPlaylistsRef.current
    ]);
    const next = customPlaylists.filter(p => p.id !== playlistId);
    persistCustomPlaylists(next);
    if (selectedLibrary === playlistId) {
      setSelectedLibrary('liked');
    }
  }

  function toggleTrackInPlaylist(playlistId, track) {
    const now = Date.now();
    const existingDl = downloads[track.id];
    const offMatch = offlineCatalog.find(t => String(t.id) === String(track.id));
    const filename = existingDl?.filename || offMatch?.filename || track.filename || null;
    const preparedTrack = {
      ...track,
      addedAt: now,
      updatedAt: now,
      filename,
      streamUrl: filename
        ? `/api/stream?file=${encodeURIComponent(filename)}`
        : track.streamUrl || null
    };

    let addedNew = false;
    const next = customPlaylists.map(pl => {
      if (pl.id !== playlistId) return pl;
      const exists = pl.tracks.some(t => String(t.id) === String(track.id));
      if (!exists) addedNew = true;
      const prevDeleted = normalizeTombstoneList(pl.deletedTracks);
      return {
        ...pl,
        updatedAt: now,
        tracks: exists
          ? pl.tracks.filter(t => String(t.id) !== String(track.id))
          : [preparedTrack, ...pl.tracks],
        deletedTracks: exists
          ? normalizeTombstoneList([{ id: String(track.id), deletedAt: now }, ...prevDeleted])
          : prevDeleted.filter(d => String(d.id) !== String(track.id))
      };
    });
    persistCustomPlaylists(next);
    if (addedNew && isPlaceholderCover(preparedTrack.artwork)) {
      syncMissingCoversForList([preparedTrack], false);
    }
  }

  function removeTrackFromPlaylist(playlistId, trackId) {
    const now = Date.now();
    const next = customPlaylists.map(pl =>
      pl.id === playlistId
        ? {
            ...pl,
            updatedAt: now,
            tracks: pl.tracks.filter(t => String(t.id) !== String(trackId)),
            deletedTracks: normalizeTombstoneList([
              { id: String(trackId), deletedAt: now },
              ...normalizeTombstoneList(pl.deletedTracks)
            ])
          }
        : pl
    );
    persistCustomPlaylists(next);
  }

  async function deleteOwnUploadEverywhere(track) {
    const uploadId = resolveOwnUploadId(track);
    if (!uploadId) return;
    const now = Date.now();

    deleteOfflineTrack(track);

    persistDeletedLikes([{ id: uploadId, deletedAt: now }, ...deletedLikesRef.current]);
    const nextLikes = likedTracksRef.current.filter(
      t => String(t.id) !== uploadId && resolveOwnUploadId(t) !== uploadId
    );
    const nextPls = (customPlaylistsRef.current || []).map(pl => {
      const had = (pl.tracks || []).some(
        t => String(t.id) === uploadId || resolveOwnUploadId(t) === uploadId
      );
      if (!had) return pl;
      return {
        ...pl,
        updatedAt: now,
        tracks: (pl.tracks || []).filter(
          t => String(t.id) !== uploadId && resolveOwnUploadId(t) !== uploadId
        ),
        deletedTracks: normalizeTombstoneList([
          { id: uploadId, deletedAt: now },
          ...normalizeTombstoneList(pl.deletedTracks)
        ])
      };
    });

    setLikedTracks(nextLikes);
    likedTracksRef.current = nextLikes;
    setCustomPlaylists(nextPls);
    customPlaylistsRef.current = nextPls;
    try {
      localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(nextLikes));
      localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(nextPls));
    } catch {}
    scheduleCollectionsSync(true, nextLikes, nextPls);

    if (!isOfflineRef.current) {
      try {
        await fetch(`/api/upload/${encodeURIComponent(uploadId)}?record=1`, {
          method: 'DELETE'
        });
      } catch {}
    }
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

  function openDownloadPromptModal(track, list = [], idx = 0) {
    setDownloadPrompt({ track, list, idx });
    setTimeout(() => {
      if (
        downloadDialogRef.current &&
        !downloadDialogRef.current.open &&
        typeof downloadDialogRef.current.showModal === 'function'
      ) {
        downloadDialogRef.current.showModal();
      }
    }, 15);
  }

  function closeDownloadPromptModal() {
    if (downloadDialogRef.current && downloadDialogRef.current.open) {
      downloadDialogRef.current.close();
    }
    setDownloadPrompt(null);
  }

  function openYtLinkModal(defaultLib = null) {
    setYtLinkUrl('');
    setYtLinkPreview(null);
    setYtLinkError('');
    setYtLinkLoading(false);
    setYtLinkTargetLib(defaultLib || (activeTab === 'library' ? selectedLibrary : 'offline'));
    setYtModalOpen(true);
    setTimeout(() => {
      if (
        ytDialogRef.current &&
        !ytDialogRef.current.open &&
        typeof ytDialogRef.current.showModal === 'function'
      ) {
        ytDialogRef.current.showModal();
      }
    }, 15);
  }

  function closeYtLinkModal() {
    if (ytDialogRef.current && ytDialogRef.current.open) {
      ytDialogRef.current.close();
    }
    setYtModalOpen(false);
    setYtLinkError('');
  }

  function openEditTrackModal(track) {
    if (!track) return;
    closeTrackMenu();
    const genericArtists = new Set([
      'archivo propio',
      'audio subido',
      'guardado en dispositivo',
      'artista',
      'audio mp3',
      'youtube'
    ]);
    const genericAlbums = new Set([
      'mi música',
      'mi musica',
      'offline pwa',
      'guardado en dispositivo',
      'spotify csv',
      'youtube'
    ]);
    const rawArtist = String(track.artist || '').trim();
    const rawAlbum = String(track.album || '').trim();
    setEditingTrack(track);
    setEditForm({
      title: String(track.title || ''),
      artist: genericArtists.has(rawArtist.toLowerCase()) ? '' : rawArtist,
      album: genericAlbums.has(rawAlbum.toLowerCase()) ? '' : rawAlbum,
      refreshCover: isPlaceholderCover(track.artwork)
    });
    setTimeout(() => {
      if (
        editDialogRef.current &&
        !editDialogRef.current.open &&
        typeof editDialogRef.current.showModal === 'function'
      ) {
        editDialogRef.current.showModal();
      }
    }, 20);
  }

  function closeEditTrackModal() {
    if (editDialogRef.current && editDialogRef.current.open) {
      editDialogRef.current.close();
    }
    setEditingTrack(null);
  }

  function handleEditTrackSubmit(e) {
    e.preventDefault();
    if (!editingTrack) return;
    const nextTitle = editForm.title.trim() || editingTrack.title || 'Canción';
    const nextArtist = editForm.artist.trim() || editingTrack.artist || 'Artista';
    const nextAlbum = editForm.album.trim() || editingTrack.album || '';
    const shouldRefreshCover = Boolean(editForm.refreshCover) && !isOffline;

    const patch = {
      title: nextTitle,
      artist: nextArtist,
      ...(nextAlbum ? { album: nextAlbum } : {})
    };

    if (shouldRefreshCover) {
      enrichedArtworkRef.current.delete(String(editingTrack.id));
      const upId = resolveOwnUploadId(editingTrack);
      if (upId) enrichedArtworkRef.current.delete(upId);
      patch.artwork = DEFAULT_TRACK_COVER;
    }

    updateTrackMetadataAcrossLibraries(editingTrack.id, patch, editingTrack.filename);
    persistOwnUploadMetadataToServer(editingTrack, patch);
    const updatedCandidate = { ...editingTrack, ...patch };
    closeEditTrackModal();

    if (shouldRefreshCover) {
      syncMissingCoversForList([updatedCandidate], false);
    }
  }

  async function resolveYtLinkPreview(rawUrl) {
    const reqId = ++ytPreviewReqIdRef.current;
    const clean = String(rawUrl || '').trim();
    if (!clean) {
      setYtLinkPreview(null);
      setYtLinkError('');
      setYtLinkLoading(false);
      return null;
    }
    const isYt = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i.test(
      clean
    );
    if (!isYt) {
      setYtLinkPreview(null);
      setYtLinkLoading(false);
      return null;
    }
    setYtLinkLoading(true);
    setYtLinkError('');
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(clean)}`);
      const data = await res.json();
      const first = (data.results || data.tracks || [])[0] || null;
      if (ytPreviewReqIdRef.current !== reqId) return first;
      if (first) {
        setYtLinkPreview(first);
        setYtLinkLoading(false);
        return first;
      }
    } catch {}
    if (ytPreviewReqIdRef.current === reqId) {
      setYtLinkLoading(false);
    }
    return null;
  }

  async function handleYtLinkSubmit(e) {
    e.preventDefault();
    if (isOffline) return;
    const clean = String(ytLinkUrl || '').trim();
    const match = clean.match(
      /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i
    );
    if (!match) {
      setYtLinkError('Pegá un link válido de YouTube (ej. https://youtu.be/... o youtube.com/watch?v=...).');
      return;
    }
    const videoId = match[1];
    let trackObj = ytLinkPreview;
    if (!trackObj || trackObj.id !== `yt_${videoId}`) {
      trackObj = await resolveYtLinkPreview(clean);
    }
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const finalTrack = trackObj || {
      id: `yt_${videoId}`,
      title: `YouTube (${videoId})`,
      artist: 'YouTube',
      album: 'YouTube',
      genre: 'YouTube',
      artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      previewUrl: null,
      duration: '—',
      sourceUrl: canonicalUrl
    };

    if (ytLinkTargetLib === 'liked') {
      if (!isLiked(finalTrack.id)) {
        persistLikes([{ ...finalTrack, addedAt: Date.now() }, ...likedTracks]);
      }
    } else if (ytLinkTargetLib && ytLinkTargetLib !== 'offline') {
      if (!isTrackInPlaylist(ytLinkTargetLib, finalTrack.id)) {
        toggleTrackInPlaylist(ytLinkTargetLib, finalTrack);
      }
    }

    setResults(prev => {
      if (prev.some(t => String(t.id) === String(finalTrack.id))) return prev;
      return [finalTrack, ...prev];
    });

    closeYtLinkModal();
    await startDownload(finalTrack);
  }

  function handleDialogBackdropClick(e, closeFn) {
    if (typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype) {
      return;
    }
    const dialog = e.currentTarget;
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const isDialogContent =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width;
    if (!isDialogContent) {
      closeFn();
    }
  }

  function updateTrackFileAcrossLibraries(trackId, filename, streamUrl) {
    const now = Date.now();
    let collectionsChanged = false;
    setLikedTracks(prev => {
      if (!prev.some(t => String(t.id) === String(trackId))) return prev;
      collectionsChanged = true;
      const updated = prev.map(t =>
        String(t.id) === String(trackId) ? { ...t, filename, streamUrl, updatedAt: now } : t
      );
      likedTracksRef.current = updated;
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
          updatedAt: now,
          tracks: pl.tracks.map(t =>
            String(t.id) === String(trackId) ? { ...t, filename, streamUrl, updatedAt: now } : t
          )
        };
      });
      if (changed) {
        collectionsChanged = true;
        customPlaylistsRef.current = updated;
        try {
          localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(updated));
        } catch {}
        return updated;
      }
      return prev;
    });

    if (collectionsChanged) {
      scheduleCollectionsSync();
    }
  }

  function updateTrackMetadataAcrossLibraries(trackId, patch, targetFilename = null) {
    const now = Date.now();
    const stampedPatch = { ...patch, updatedAt: now };
    const resolvedTargetUploadId = resolveOwnUploadId({
      id: trackId,
      uploadId: trackId,
      filename: targetFilename
    });

    const matchesTarget = t => {
      if (!t) return false;
      if (String(t.id) === String(trackId)) return true;
      if (t.uploadId && String(t.uploadId) === String(trackId)) return true;
      if (resolvedTargetUploadId && resolveOwnUploadId(t) === resolvedTargetUploadId) return true;
      if (targetFilename && t.filename && t.filename === targetFilename) return true;
      return false;
    };

    let collectionsChanged = false;

    setLikedTracks(prev => {
      if (!prev.some(matchesTarget)) return prev;
      collectionsChanged = true;
      const updated = prev.map(t => (matchesTarget(t) ? { ...t, ...stampedPatch } : t));
      likedTracksRef.current = updated;
      try {
        localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(updated));
      } catch {}
      return updated;
    });

    setOfflineCatalog(prev => {
      if (!prev.some(matchesTarget)) return prev;
      const updated = prev.map(t => (matchesTarget(t) ? { ...t, ...stampedPatch } : t));
      try {
        localStorage.setItem(OFFLINE_CATALOG_KEY, JSON.stringify(updated));
      } catch {}
      return updated;
    });

    setCustomPlaylists(prev => {
      let changed = false;
      const updated = prev.map(pl => {
        if (!pl.tracks.some(matchesTarget)) return pl;
        changed = true;
        return {
          ...pl,
          updatedAt: now,
          tracks: pl.tracks.map(t => (matchesTarget(t) ? { ...t, ...stampedPatch } : t))
        };
      });
      if (changed) {
        collectionsChanged = true;
        customPlaylistsRef.current = updated;
        try {
          localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(updated));
        } catch {}
        return updated;
      }
      return prev;
    });

    setQueue(prev => {
      if (!prev.some(matchesTarget)) return prev;
      const updatedQueue = prev.map(t => (matchesTarget(t) ? { ...t, ...patch } : t));
      queueRef.current = updatedQueue;
      return updatedQueue;
    });

    if (collectionsChanged) {
      scheduleCollectionsSync();
    }
  }

  // Moves the chosen track to position #1 (index 0) of the specified library and returns the reordered full list
  function promoteTrackToTopOfLibrary(libId, track) {
    if (!libId || !track) return [];
    const matchTrack = t =>
      String(t.id) === String(track.id) ||
      (track.filename && t.filename === track.filename);

    if (libId === 'liked') {
      const rest = likedTracks.filter(t => !matchTrack(t));
      const reordered = [track, ...rest];
      persistLikes(reordered);
      return reordered;
    }

    if (libId === 'offline') {
      const rest = offlineCatalog.filter(t => !matchTrack(t));
      const reordered = [track, ...rest];
      persistOfflineCatalog(reordered);
      return reordered;
    }

    const targetPl = customPlaylists.find(p => p.id === libId);
    if (targetPl) {
      const rest = targetPl.tracks.filter(t => !matchTrack(t));
      const reordered = [track, ...rest];
      const nextPlaylists = customPlaylists.map(pl =>
        pl.id === libId ? { ...pl, tracks: reordered } : pl
      );
      persistCustomPlaylists(nextPlaylists);
      return reordered;
    }

    return [track];
  }

  // Resolve & compress missing album covers (~4 KB 100x100bb.jpg) respecting iTunes ~20 req/min rate limit (~3.1s pause)
  async function syncMissingCoversForList(targetTracks, manualClick = false) {
    if (isOffline) return;
    if (enrichingBusyRef.current) {
      if (manualClick) {
        cancelCoverSyncRef.current = true;
      }
      return;
    }

    if (manualClick) {
      enrichedArtworkRef.current.clear();
    }

    // When manually triggered from Biblioteca, also include ALL previously uploaded user songs
    // across Favoritos, Offline, and custom playlists that still lack cover art.
    const combinedInput = [...(targetTracks || [])];
    if (manualClick) {
      const extraPools = [
        ...(likedTracksRef.current || []),
        ...(offlineCatalog || []),
        ...(customPlaylistsRef.current || []).flatMap(pl => pl?.tracks || [])
      ];
      for (const tr of extraPools) {
        if (!tr || !isPlaceholderCover(tr.artwork)) continue;
        const isOwn =
          tr.source === 'own' ||
          Boolean(resolveOwnUploadId(tr)) ||
          String(tr.artist || '').trim().toLowerCase() === 'archivo propio';
        if (isOwn) {
          combinedInput.push(tr);
        }
      }
    }

    const seenMissingKeys = new Set();
    const missing = [];
    for (const t of combinedInput) {
      if (!t || !t.id || !t.title || !isPlaceholderCover(t.artwork)) continue;
      const dedupId = resolveOwnUploadId(t) || String(t.id);
      if (seenMissingKeys.has(dedupId)) continue;
      if (!manualClick && enrichedArtworkRef.current.has(dedupId)) continue;
      seenMissingKeys.add(dedupId);
      missing.push(t);
    }
    if (missing.length === 0) return;

    enrichingBusyRef.current = true;
    cancelCoverSyncRef.current = false;
    setCoverSync({ active: true, done: 0, total: missing.length });

    const resolvedIdsInRun = new Set();
    const ignoredAlbums = new Set([
      'spotify csv',
      'offline pwa',
      'guardado en dispositivo',
      'mi música',
      'mi musica',
      'archivo propio',
      'audio subido',
      'youtube'
    ]);

    const isGenericTrackArtist = raw => {
      const low = String(raw || '').trim().toLowerCase();
      if (!low) return true;
      if (
        low === 'artista' ||
        low === 'guardado en dispositivo' ||
        low === 'archivo propio' ||
        low === 'audio subido' ||
        low === 'audio mp3' ||
        low === 'youtube' ||
        low === 'desconocido' ||
        low === 'unknown' ||
        low === 'unknown artist'
      ) {
        return true;
      }
      return /\b(y2mate|y2meta|ytmp3|yt1s|spotifydown|spotidown|savetube|savefrom|ssyoutube|loader|cnvmp3|snapinsta|snaptik|cobalt|mp3juices|flvto|2conv|notube)\b/i.test(
        low
      );
    };

    const getAlbumKey = tr => {
      const alb = String(tr.album || '').trim().toLowerCase();
      const art = String(tr.artist || '').split(',')[0].trim().toLowerCase();
      if (!alb || ignoredAlbums.has(alb) || isGenericTrackArtist(art)) {
        return null;
      }
      return `${alb}|${art}`;
    };

    const stripTitleNoise = raw =>
      String(raw || '')
        .replace(/_/g, ' ')
        .replace(
          /^(?:www\.)?(?:y2mate|y2meta|ytmp3|yt1s|savefrom|savetube|ssyoutube|spotifydown|spotidown|loader|cnvmp3|snapinsta|snaptik|cobalt|mp3juices|flvto|2conv|notube)(?:\.[a-z]{2,6})?\s*[-–—:|]+\s*/i,
          ''
        )
        .replace(/^\d{1,3}\s*[-._)]\s*/, '')
        .replace(/\.(mp3|m4a|wav|flac|ogg|opus|aac|mp4|webm|mkv|avi)$/i, '')
        .replace(/(?<=[a-zA-ZáéíóúñÁÉÍÓÚÑ]{3})(avi|mp4|mkv|webm|mov|flv|wmv|m4a|mp3|wav|flac)\b/gi, '')
        .replace(/\b\d{2,4}\s*kbps\b/gi, '')
        .replace(
          /\s*[-–—]\s*(remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|radio\s+edit|album\s+version|single\s+version|official\s*(music\s*)?video|video\s*oficial|lyric\s*video|lyrics?|letra|audio\s*oficial|hq|hd|4k|solo|demo|live|acoustic|bonus\s+track|\d+\/\d+.*).*/i,
          ''
        )
        .replace(
          /\s*\((remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|feat\.?[^)]+|ft\.?[^)]+|official[^)]*|video\s*oficial|lyrics?|letra|audio[^)]*|hq|hd|4k|\d{2,4}\s*kbps|solo|live|demo)\)/gi,
          ''
        )
        .replace(/\s*\[[^\]]+\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const cleanArtistPart = raw =>
      String(raw || '')
        .replace(/\b(archive|archives|vault|topic|reupload|official|vevo|canal)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

    const isUnsearchableGenericTitle = cleaned => {
      const low = String(cleaned || '').trim().toLowerCase();
      if (!low || low.length < 2) return true;
      return /^(whatsapp\s+audio|aud[-_\s]?\d{4}|ptt[-_\s]?\d{4}|grabaci[oó]n|nota\s+de\s+voz|voice\s+memo|recording|track\s*\d+|pista\s*\d+|audio\s*\d+|cancion|canci[oó]n|sin\s+t[ií]tulo|untitled)\b/i.test(
        low
      );
    };

    const normAscii = str =>
      String(str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

    const stopWords = new Set(['de', 'la', 'el', 'los', 'las', 'del', 'the', 'and', 'con', 'por', 'para', 'feat', 'ft']);

    const extractSigTokens = str => {
      const all = normAscii(str).split(/\s+/).filter(w => w.length >= 2);
      const filtered = all.filter(w => w.length >= 3 && !stopWords.has(w));
      return filtered.length > 0 ? filtered : all;
    };

    const pickBestCatalogCoverHit = (candidates, targetTitle, targetArtist) => {
      if (!Array.isArray(candidates) || candidates.length === 0) return null;
      const queryTokens = extractSigTokens(targetTitle);
      const artistTokens = targetArtist ? extractSigTokens(targetArtist) : [];
      const compactQuery = normAscii(targetTitle).replace(/\s+/g, '');
      if (queryTokens.length === 0 && !compactQuery) return null;

      let best = null;
      let bestScore = -1;

      for (const cand of candidates) {
        const artUrl = cand?.artwork || cand?.artworkUrl100;
        if (!artUrl || isPlaceholderCover(artUrl)) continue;
        const candTitle = cand.title || cand.trackName || '';
        const candArtist = cand.artist || cand.artistName || '';
        const normCandTitle = normAscii(candTitle);
        const normCandFull = normAscii(`${candTitle} ${candArtist}`);
        const compactCandTitle = normCandTitle.replace(/\s+/g, '');
        const compactCandFull = normCandFull.replace(/\s+/g, '');
        if (!compactCandTitle) continue;

        let matchedTitleTokens = 0;
        let matchedInTitleOnly = 0;
        for (const tok of queryTokens) {
          if (normCandTitle.split(/\s+/).includes(tok) || compactCandTitle.includes(tok)) {
            matchedTitleTokens += 1;
            matchedInTitleOnly += 1;
          } else if (normCandFull.split(/\s+/).includes(tok) || compactCandFull.includes(tok)) {
            matchedTitleTokens += 1;
          }
        }

        let matchedArtistTokens = 0;
        for (const aTok of artistTokens) {
          if (normAscii(candArtist).includes(aTok) || compactCandFull.includes(aTok)) {
            matchedArtistTokens += 1;
          }
        }

        const overlapRatio = queryTokens.length > 0 ? matchedTitleTokens / queryTokens.length : 0;
        const exactCompactTitle = compactQuery.length >= 4 && compactCandTitle === compactQuery;

        // Require genuine title/artist correspondence so unrelated tracks never receive random covers
        const accepted =
          (matchedArtistTokens > 0 && (matchedInTitleOnly >= 1 || exactCompactTitle)) ||
          (matchedTitleTokens >= 2 && overlapRatio >= 0.6) ||
          (exactCompactTitle && compactQuery.length >= 5);

        if (!accepted) continue;

        const score =
          matchedTitleTokens * 3 +
          matchedInTitleOnly * 2 +
          matchedArtistTokens * 4 +
          (exactCompactTitle ? 5 : 0) +
          overlapRatio * 2;

        if (score > bestScore) {
          bestScore = score;
          let resolvedDuration = cand.duration && cand.duration !== '—' ? cand.duration : null;
          if (!resolvedDuration && cand.trackTimeMillis && cand.trackTimeMillis >= 45000) {
            const totalSec = Math.round(cand.trackTimeMillis / 1000);
            resolvedDuration = `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
          }
          best = {
            artwork: artUrl,
            previewUrl: cand.previewUrl || null,
            title: candTitle || null,
            artist: candArtist || null,
            album: cand.album || cand.collectionName || null,
            duration: resolvedDuration,
            matchedArtistTokens
          };
        }
      }
      return best;
    };

    try {
      let done = 0;
      for (let i = 0; i < missing.length; i++) {
        const item = missing[i];
        const itemDedupId = resolveOwnUploadId(item) || String(item.id);
        if (cancelCoverSyncRef.current || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
          break;
        }

        // Wait if the user switched away from the app so we never abort/skip covers in background
        while (
          typeof document !== 'undefined' &&
          document.visibilityState === 'hidden' &&
          !cancelCoverSyncRef.current
        ) {
          await new Promise(r => setTimeout(r, 1000));
        }
        if (cancelCoverSyncRef.current) break;

        if (resolvedIdsInRun.has(itemDedupId)) {
          done += 1;
          setCoverSync({ active: true, done, total: missing.length });
          continue;
        }

        let rateLimited = false;
        let networkAborted = false;
        try {
          const rawArtists =
            item.artist && !isGenericTrackArtist(item.artist)
              ? String(item.artist)
                  .split(/[,;&]/)
                  .map(a => a.trim())
                  .filter(a => a && !isGenericTrackArtist(a))
              : [];
          const cleanTitle = stripTitleNoise(item.title) || String(item.title || '').trim();
          if (isUnsearchableGenericTitle(cleanTitle)) {
            enrichedArtworkRef.current.add(itemDedupId);
            done += 1;
            setCoverSync({ active: true, done, total: missing.length });
            continue;
          }

          let embeddedArtist = '';
          let embeddedSongTitle = cleanTitle;
          const dashIdx = cleanTitle.indexOf(' - ');
          if (dashIdx > 1 && dashIdx < cleanTitle.length - 3) {
            embeddedArtist = cleanArtistPart(cleanTitle.slice(0, dashIdx));
            embeddedSongTitle = stripTitleNoise(cleanTitle.slice(dashIdx + 3)) || cleanTitle;
          }

          const primaryArtist = cleanArtistPart(rawArtists[0] || embeddedArtist || '');
          const secondaryArtist = cleanArtistPart(rawArtists[1] || '');
          const candidateQueries = Array.from(
            new Set(
              [
                primaryArtist ? `${embeddedSongTitle} ${primaryArtist}`.trim() : '',
                primaryArtist && embeddedSongTitle !== cleanTitle
                  ? `${cleanTitle} ${primaryArtist}`.trim()
                  : '',
                secondaryArtist ? `${embeddedSongTitle} ${secondaryArtist}`.trim() : '',
                embeddedArtist ? `${embeddedSongTitle} ${embeddedArtist}`.trim() : '',
                cleanTitle.trim(),
                embeddedSongTitle.trim()
              ].filter(Boolean)
            )
          );
          const q = candidateQueries[0] || cleanTitle;
          let bestHit = null;
          let directRespondedOk = false;
          let fallbackRespondedOk = false;

          try {
            const res = await fetch(
              `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=5`
            );
            if (res.status === 429 || res.status === 403) {
              rateLimited = true;
            } else if (res.ok) {
              directRespondedOk = true;
              const data = await res.json();
              bestHit = pickBestCatalogCoverHit(
                data?.results || [],
                embeddedSongTitle || cleanTitle,
                primaryArtist
              );
              if (!bestHit && embeddedSongTitle !== cleanTitle) {
                bestHit = pickBestCatalogCoverHit(data?.results || [], cleanTitle, primaryArtist);
              }
            }
          } catch {
            networkAborted = true;
          }

          // If iTunes direct didn't find a verified cover (e.g. YouTube uploader channel in artist, SoundCloud/Deezer exclusive, or CORS block),
          // query /api/search (which checks both iTunes and Deezer API) across our cleaned candidate queries
          if (!bestHit && !rateLimited) {
            for (const cand of candidateQueries.slice(0, 4)) {
              try {
                const fallbackRes = await fetch(`/api/search?q=${encodeURIComponent(cand)}`);
                if (fallbackRes.status === 429 || fallbackRes.status === 403) {
                  rateLimited = true;
                  break;
                } else if (fallbackRes.ok) {
                  fallbackRespondedOk = true;
                  networkAborted = false;
                  const fbData = await fallbackRes.json();
                  const fbCandidates = (fbData?.results || []).slice(0, 8);
                  bestHit =
                    pickBestCatalogCoverHit(
                      fbCandidates,
                      embeddedSongTitle || cleanTitle,
                      primaryArtist
                    ) || pickBestCatalogCoverHit(fbCandidates, cleanTitle, primaryArtist);
                  if (bestHit) break;
                }
              } catch {
                networkAborted = true;
                break;
              }
            }
          }

          const smallCover = bestHit?.artwork ? compressArtworkUrl(bestHit.artwork) : null;

          // If the user switched apps mid-request and the fetch aborted, wait until visible and retry this exact song
          if (
            networkAborted &&
            !smallCover &&
            typeof document !== 'undefined' &&
            document.visibilityState === 'hidden'
          ) {
            i -= 1;
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }

          // Only mark as checked if we actually got a cover OR the API genuinely returned 200 OK with 0 results
          if (smallCover || directRespondedOk || fallbackRespondedOk) {
            enrichedArtworkRef.current.add(itemDedupId);
            enrichedArtworkRef.current.add(String(item.id));
          }

          if (smallCover && !isPlaceholderCover(smallCover)) {
            const patch = { artwork: smallCover };
            if (!item.previewUrl && bestHit.previewUrl) {
              patch.previewUrl = bestHit.previewUrl;
            }
            if ((!item.duration || item.duration === '—') && bestHit.duration) {
              patch.duration = bestHit.duration;
            }
            if (isGenericTrackArtist(item.artist) && bestHit.artist) {
              patch.artist = bestHit.artist;
              if (bestHit.title) patch.title = bestHit.title;
            }
            if (
              (!item.album || ignoredAlbums.has(String(item.album).trim().toLowerCase())) &&
              bestHit.album
            ) {
              patch.album = bestHit.album;
            }
            updateTrackMetadataAcrossLibraries(item.id, patch, item.filename);
            if (resolveOwnUploadId(item)) {
              persistOwnUploadMetadataToServer(item, patch);
            }
            resolvedIdsInRun.add(itemDedupId);
            resolvedIdsInRun.add(String(item.id));

            // Reuse the same compressed cover for other tracks in this library from the exact same real album + artist (saves API calls!)
            const itemAlbKey = getAlbumKey(item);
            if (itemAlbKey) {
              for (const sibling of missing) {
                const sibDedupId = resolveOwnUploadId(sibling) || String(sibling.id);
                if (
                  sibDedupId !== itemDedupId &&
                  !resolvedIdsInRun.has(sibDedupId) &&
                  getAlbumKey(sibling) === itemAlbKey
                ) {
                  updateTrackMetadataAcrossLibraries(
                    sibling.id,
                    { artwork: smallCover },
                    sibling.filename
                  );
                  if (resolveOwnUploadId(sibling)) {
                    persistOwnUploadMetadataToServer(sibling, { artwork: smallCover });
                  }
                  enrichedArtworkRef.current.add(sibDedupId);
                  resolvedIdsInRun.add(sibDedupId);
                }
              }
            }

            // Warm image into Service Worker cache (~4 KB)
            if (typeof window !== 'undefined' && 'Image' in window) {
              const img = new window.Image();
              img.src = smallCover;
            }
          }
        } catch {}

        done += 1;
        setCoverSync({ active: true, done, total: missing.length });
        // Respect iTunes ~20 searches/min limit (~3.1s between lookups; 10s cooldown if rate-limited)
        await new Promise(r => setTimeout(r, rateLimited ? 10000 : 3100));
      }
    } finally {
      enrichingBusyRef.current = false;
      cancelCoverSyncRef.current = false;
      setCoverSync({ active: false, done: 0, total: 0 });
    }
  }

  function getOpenAudioCache() {
    if (typeof window === 'undefined' || !('caches' in window)) return Promise.resolve(null);
    if (!audioCachePromiseRef.current) {
      audioCachePromiseRef.current = caches.open(AUDIO_CACHE_NAME).catch(() => {
        audioCachePromiseRef.current = null;
        return null;
      });
    }
    return audioCachePromiseRef.current;
  }

  function registerBlobUrlForKeys(blobUrl, streamUrl, filename = null, track = null) {
    if (!blobUrl) return;
    if (streamUrl) {
      blobUrlCacheRef.current.set(streamUrl, blobUrl);
      try {
        const parsed = new URL(streamUrl, window.location.origin);
        blobUrlCacheRef.current.set(parsed.href, blobUrl);
        blobUrlCacheRef.current.set(parsed.pathname + parsed.search, blobUrl);
        const fnFromUrl = parsed.searchParams.get('file');
        if (fnFromUrl && !filename) filename = fnFromUrl;
      } catch {}
    }
    if (filename) {
      blobUrlCacheRef.current.set(`file:${filename}`, blobUrl);
      const encodedRel = `/api/stream?file=${encodeURIComponent(filename)}`;
      blobUrlCacheRef.current.set(encodedRel, blobUrl);
      try {
        const fullEncoded = new URL(encodedRel, window.location.origin).href;
        blobUrlCacheRef.current.set(fullEncoded, blobUrl);
      } catch {}
      const matchedOff = offlineLookup.byFile.get(filename);
      if (matchedOff) {
        const dk = getTrackDedupKey(matchedOff);
        if (dk) blobUrlCacheRef.current.set(`dedup:${dk}`, blobUrl);
      }
    }
    if (track) {
      const dk = getTrackDedupKey(track);
      if (dk) blobUrlCacheRef.current.set(`dedup:${dk}`, blobUrl);
    }
  }

  async function refreshOfflineCacheList() {
    if (typeof window === 'undefined') return;
    if ('caches' in window) {
      try {
        const cache = await getOpenAudioCache();
        if (!cache) return;
        const keys = await cache.keys();
        const map = {};
        const cachedFilenames = [];
        for (const req of keys) {
          const url = new URL(req.url);
          const rel = url.pathname + url.search;
          map[rel] = true;
          cachedStreamKeysRef.current.set(rel, req.url);
          cachedStreamKeysRef.current.set(req.url, req.url);
          const fileParam = url.searchParams.get('file');
          if (fileParam) {
            cachedFilenames.push({ filename: fileParam, streamUrl: rel });
            cachedStreamKeysRef.current.set(`file:${fileParam}`, req.url);
            const encodedRel = `/api/stream?file=${encodeURIComponent(fileParam)}`;
            map[encodedRel] = true;
            cachedStreamKeysRef.current.set(encodedRel, req.url);
          }
        }
        setOfflineUrls(map);

        setOfflineCatalog(prev => {
          const validSet = new Set(cachedFilenames.map(c => c.streamUrl));
          const validFileSet = new Set(cachedFilenames.map(c => c.filename));
          const filtered = prev.filter(
            item =>
              (item.streamUrl && validSet.has(item.streamUrl)) ||
              (item.filename && validFileSet.has(item.filename))
          );
          let changed = filtered.length !== prev.length;
          const next = [...filtered];

          for (const item of cachedFilenames) {
            const exists = next.some(
              t => t.filename === item.filename || t.streamUrl === item.streamUrl
            );
            if (!exists) {
              const cleanTitle = item.filename
                .replace(/_\d+\.(mp3|m4a|opus|wav|flac)$/i, '')
                .replace(/\.(mp3|m4a|opus|wav|flac)$/i, '')
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
      const cache = await getOpenAudioCache();
      if (!cache) return false;
      const response = await fetch(url);
      if (response.ok) {
        const clonedForCache = response.clone();
        const clonedForBlob = response.clone();
        await cache.put(url, clonedForCache);
        const fileToDelete =
          trackMeta?.filename ||
          new URL(url, window.location.origin).searchParams.get('file');
        try {
          const blob = await clonedForBlob.blob();
          if (blob && blob.size > 0) {
            const existingBlobUrl = blobUrlCacheRef.current.get(url);
            if (existingBlobUrl) URL.revokeObjectURL(existingBlobUrl);
            const blobUrl = URL.createObjectURL(blob);
            registerBlobUrlForKeys(blobUrl, url, fileToDelete);
          }
        } catch {}
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

        if (fileToDelete) {
          const isOwnUpload =
            trackMeta?.source === 'own' || String(fileToDelete).startsWith('upl_');
          if (isOwnUpload) {
            const resolvedUploadId =
              trackMeta?.uploadId ||
              (String(trackMeta?.id || '').startsWith('upl_')
                ? String(trackMeta.id)
                : String(fileToDelete).replace(/\.(m4a|mp3|wav|flac)$/i, ''));
            if (resolvedUploadId && /^upl_[a-f0-9]{32}$/.test(resolvedUploadId)) {
              fetch(`/api/upload/${encodeURIComponent(resolvedUploadId)}`, {
                method: 'DELETE'
              })
                .then(r => {
                  if (r.ok) {
                    updateTrackMetadataAcrossLibraries(resolvedUploadId, {
                      source: 'own',
                      fileDeleted: true
                    });
                  }
                  fetchLibraryFiles();
                })
                .catch(() => {});
            }
          } else {
            fetch(`/api/library?file=${encodeURIComponent(fileToDelete)}`, {
              method: 'DELETE'
            })
              .then(() => fetchLibraryFiles())
              .catch(() => {});
          }
        }
        return true;
      }
    } catch {}
    return false;
  }

  async function exportTrackFile(filename, streamUrl) {
    if (typeof window === 'undefined') return;
    const url = streamUrl || `/api/stream?file=${encodeURIComponent(filename)}`;
    let resolvedFilename = filename;
    if (!resolvedFilename && url) {
      try {
        resolvedFilename = new URL(url, window.location.origin).searchParams.get('file');
      } catch {}
    }
    if ('caches' in window) {
      try {
        const cache = await getOpenAudioCache();
        const fullUrl = new URL(url, window.location.origin).href;
        const cachedResp = cache ? (await cache.match(url)) || (await cache.match(fullUrl)) : null;
        if (cachedResp) {
          const contentType = (cachedResp.headers.get('Content-Type') || '').toLowerCase();
          const defaultExt = contentType.includes('mp4') ? '.m4a' : '.mp3';
          const blob = await cachedResp.blob();
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = resolvedFilename || `track${defaultExt}`;
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
    a.download = resolvedFilename || 'track.m4a';
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

    if (streamUrl && blobUrlCacheRef.current.has(streamUrl)) {
      try {
        URL.revokeObjectURL(blobUrlCacheRef.current.get(streamUrl));
      } catch {}
      blobUrlCacheRef.current.delete(streamUrl);
    }
    if (filename && blobUrlCacheRef.current.has(`file:${filename}`)) {
      blobUrlCacheRef.current.delete(`file:${filename}`);
    }

    try {
      const cache = await getOpenAudioCache();
      if (cache && streamUrl) {
        await cache.delete(streamUrl);
        const fullUrl = new URL(streamUrl, window.location.origin).href;
        await cache.delete(fullUrl);
      }
    } catch {}

    setDownloads(prev => {
      const next = { ...prev };
      delete next[track.id];
      return next;
    });
    updateTrackFileAcrossLibraries(track.id, null, null);

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

  function getTrackStreamUrl(track) {
    if (!track) return null;
    const dl = downloads[track.id];
    const dedupKey = getTrackDedupKey(track);
    const offItem = findOfflineItem(track);
    const likedItem =
      likedLookup.byId.get(String(track.id)) ||
      (dedupKey ? likedLookup.byDedup.get(dedupKey) : null);

    const candidateFilenames = [
      offItem?.filename,
      track.filename,
      dl?.filename,
      likedItem?.filename
    ].filter(Boolean);

    const candidateUrls = [
      offItem?.streamUrl,
      track.streamUrl,
      likedItem?.streamUrl,
      ...candidateFilenames.map(fn => `/api/stream?file=${encodeURIComponent(fn)}`)
    ].filter(Boolean);

    // Prefer a candidate URL that is verified to exist in RAM blob cache or CacheStorage
    for (const u of candidateUrls) {
      if (
        blobUrlCacheRef.current.has(u) ||
        offlineUrls[u] ||
        cachedStreamKeysRef.current.has(u)
      ) {
        return u;
      }
    }
    for (const fn of candidateFilenames) {
      if (
        blobUrlCacheRef.current.has(`file:${fn}`) ||
        cachedStreamKeysRef.current.has(`file:${fn}`)
      ) {
        return `/api/stream?file=${encodeURIComponent(fn)}`;
      }
    }

    return candidateUrls[0] || null;
  }

  function getCachedBlobUrlForTrack(track) {
    if (!track) return null;
    const offItem = findOfflineItem(track);
    const dedupKey = getTrackDedupKey(track);
    const likedItem =
      likedLookup.byId.get(String(track.id)) ||
      (dedupKey ? likedLookup.byDedup.get(dedupKey) : null);
    const dl = downloads[track.id];

    const candidateUrls = [
      getTrackStreamUrl(track),
      offItem?.streamUrl,
      track.streamUrl,
      likedItem?.streamUrl
    ].filter(Boolean);

    for (const u of candidateUrls) {
      if (blobUrlCacheRef.current.has(u)) {
        return blobUrlCacheRef.current.get(u);
      }
    }

    const candidateFilenames = [
      offItem?.filename,
      track.filename,
      dl?.filename,
      likedItem?.filename
    ].filter(Boolean);

    for (const fn of candidateFilenames) {
      if (blobUrlCacheRef.current.has(`file:${fn}`)) {
        return blobUrlCacheRef.current.get(`file:${fn}`);
      }
    }

    if (dedupKey && blobUrlCacheRef.current.has(`dedup:${dedupKey}`)) {
      return blobUrlCacheRef.current.get(`dedup:${dedupKey}`);
    }

    return null;
  }

  function getSyncPlayableSource(track) {
    if (!track) return null;
    const cachedBlob = getCachedBlobUrlForTrack(track);
    if (cachedBlob) return cachedBlob;
    const streamUrl = getTrackStreamUrl(track);
    return streamUrl || track.previewUrl || null;
  }

  async function resolvePlayableSource(track) {
    if (!track) return null;
    const existingBlob = getCachedBlobUrlForTrack(track);
    if (existingBlob) return existingBlob;

    const streamUrl = getTrackStreamUrl(track);
    if (!streamUrl) return track.previewUrl || null;

    if (inflightBlobPromisesRef.current.has(streamUrl)) {
      return inflightBlobPromisesRef.current.get(streamUrl);
    }

    if (typeof window !== 'undefined' && 'caches' in window) {
      const promise = (async () => {
        try {
          const already = getCachedBlobUrlForTrack(track);
          if (already) return already;
          const cache = await getOpenAudioCache();
          if (!cache) return streamUrl;
          const offItem = findOfflineItem(track);
          const fullUrl = new URL(streamUrl, window.location.origin).href;
          const filename =
            offItem?.filename ||
            track.filename ||
            downloads[track.id]?.filename ||
            new URL(fullUrl).searchParams.get('file');
          const exactCachedKey =
            cachedStreamKeysRef.current.get(streamUrl) ||
            (filename ? cachedStreamKeysRef.current.get(`file:${filename}`) : null) ||
            null;

          const cachedResp =
            (exactCachedKey ? await cache.match(exactCachedKey) : null) ||
            (await cache.match(streamUrl)) ||
            (await cache.match(fullUrl)) ||
            (offItem?.streamUrl ? await cache.match(offItem.streamUrl) : null);

          if (cachedResp) {
            const blob = await cachedResp.blob();
            if (blob && blob.size > 0) {
              const recheck = getCachedBlobUrlForTrack(track);
              if (recheck) return recheck;
              const blobUrl = URL.createObjectURL(blob);
              registerBlobUrlForKeys(blobUrl, streamUrl, filename, track);
              if (offItem?.streamUrl && offItem.streamUrl !== streamUrl) {
                registerBlobUrlForKeys(blobUrl, offItem.streamUrl, offItem.filename, offItem);
              }
              return blobUrl;
            }
          }
        } catch {} finally {
          inflightBlobPromisesRef.current.delete(streamUrl);
        }
        return streamUrl;
      })();

      inflightBlobPromisesRef.current.set(streamUrl, promise);
      return promise;
    }

    return streamUrl || track.previewUrl || null;
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

  async function fetchLibraryFiles() {
    try {
      const res = await fetch('/api/library');
      if (!res.ok) return;
      const data = await res.json();
      setLibraryFiles(data.files || []);
    } catch {}
  }

  async function syncOwnUploadedTracks() {
    try {
      const res = await fetch('/api/upload', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const serverTracks = Array.isArray(data?.tracks) ? data.tracks : [];
      if (serverTracks.length === 0) return;

      let unlikedSet = new Set();
      try {
        const rawUnliked = JSON.parse(localStorage.getItem(UNLIKED_OWN_STORAGE_KEY) || '[]');
        if (Array.isArray(rawUnliked)) {
          unlikedSet = new Set(rawUnliked.map(String));
        }
      } catch {}

      const byId = new Map(serverTracks.map(t => [String(t.id), { ...t, source: 'own', uploadId: t.id }]));
      const byFile = new Map(
        serverTracks
          .filter(t => t.filename)
          .map(t => [String(t.filename), { ...t, source: 'own', uploadId: t.id }])
      );

      const playlistIds = new Set();
      try {
        const storedPls = JSON.parse(localStorage.getItem(PLAYLISTS_STORAGE_KEY) || '[]');
        if (Array.isArray(storedPls)) {
          for (const pl of storedPls) {
            for (const tr of pl?.tracks || []) {
              if (tr?.id != null) playlistIds.add(String(tr.id));
            }
          }
        }
      } catch {}

      let playlistsChanged = false;
      setCustomPlaylists(prev => {
        let changed = false;
        const next = prev.map(pl => {
          const updatedTracks = (pl.tracks || []).map(t => {
            const match = byId.get(String(t.id)) || (t.filename ? byFile.get(t.filename) : null);
            if (!match) return t;
            changed = true;
            return {
              ...t,
              id: match.id,
              title: t.title || match.title,
              artist: t.artist || match.artist,
              album: t.album || match.album,
              artwork: !isPlaceholderCover(t.artwork)
                ? t.artwork
                : !isPlaceholderCover(match.artwork)
                ? match.artwork
                : t.artwork,
              source: 'own',
              uploadId: match.id,
              fileDeleted: Boolean(match.fileDeleted),
              filename: match.filename || t.filename,
              streamUrl: match.streamUrl || t.streamUrl
            };
          });
          return { ...pl, tracks: updatedTracks };
        });
        if (changed) {
          playlistsChanged = true;
          customPlaylistsRef.current = next;
          try {
            localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(next));
          } catch {}
          return next;
        }
        return prev;
      });

      setOfflineCatalog(prev => {
        let changed = false;
        const next = prev.map(t => {
          const match = byId.get(String(t.id)) || (t.filename ? byFile.get(t.filename) : null);
          if (!match) return t;
          changed = true;
          return {
            ...t,
            id: match.id,
            title: match.title || t.title,
            artist: match.artist || t.artist,
            album: match.album || t.album,
            duration: match.duration || t.duration,
            artwork: !isPlaceholderCover(t.artwork)
              ? t.artwork
              : !isPlaceholderCover(match.artwork)
              ? match.artwork
              : t.artwork,
            source: 'own',
            uploadId: match.id,
            fileDeleted: Boolean(match.fileDeleted),
            filename: match.filename || t.filename,
            streamUrl: match.streamUrl || t.streamUrl
          };
        });
        if (changed) {
          try {
            localStorage.setItem(OFFLINE_CATALOG_KEY, JSON.stringify(next));
          } catch {}
          return next;
        }
        return prev;
      });

      let likesAdded = false;
      setLikedTracks(prev => {
        let changed = false;
        const seenIds = new Set(prev.map(t => String(t.id)));
        const updated = prev.map(t => {
          const match = byId.get(String(t.id)) || (t.filename ? byFile.get(t.filename) : null);
          if (!match) return t;
          changed = true;
          seenIds.add(String(match.id));
          return {
            ...t,
            id: match.id,
            artwork: !isPlaceholderCover(t.artwork)
              ? t.artwork
              : !isPlaceholderCover(match.artwork)
              ? match.artwork
              : t.artwork,
            source: 'own',
            uploadId: match.id,
            fileDeleted: Boolean(match.fileDeleted),
            filename: match.filename || t.filename,
            streamUrl: match.streamUrl || t.streamUrl
          };
        });

        const missingFromLocal = serverTracks
          .filter(
            st =>
              !seenIds.has(String(st.id)) &&
              !playlistIds.has(String(st.id)) &&
              !unlikedSet.has(String(st.id))
          )
          .map(st => ({
            ...st,
            source: 'own',
            uploadId: st.id,
            addedAt: st.createdAt || Date.now()
          }));

        if (missingFromLocal.length > 0) {
          changed = true;
          likesAdded = true;
        }

        if (!changed) return prev;
        const merged = deduplicateTracksList([...missingFromLocal, ...updated]);
        likedTracksRef.current = merged;
        try {
          localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(merged));
        } catch {}
        return merged;
      });

      if (playlistsChanged || likesAdded) {
        scheduleCollectionsSync();
      }

      const ownTracksMissingCovers = serverTracks
        .filter(st => !unlikedSet.has(String(st.id)) && isPlaceholderCover(st.artwork))
        .map(st => ({ ...st, source: 'own', uploadId: st.id }));
      if (ownTracksMissingCovers.length > 0) {
        syncMissingCoversForList(ownTracksMissingCovers, false);
      }
    } catch {}
  }

  async function cacheOwnTrackAndConfirmDelete(track) {
    if (!track) return false;
    const filename = track.filename;
    const streamUrl =
      track.streamUrl || (filename ? `/api/stream?file=${encodeURIComponent(filename)}` : null);
    if (!streamUrl) return false;
    const key = track.id;
    setDownloads(prev => ({
      ...prev,
      [key]: { status: 'downloading', progress: 65, startedAt: Date.now(), isManual: true, trackMeta: track }
    }));
    const saved = await saveUrlToOfflineCache(streamUrl, {
      ...track,
      source: 'own',
      uploadId: track.uploadId || track.id
    });
    setDownloads(prev => ({
      ...prev,
      [key]: { status: saved ? 'ready' : 'error', progress: saved ? 100 : 0, filename }
    }));
    if (!saved) {
      updateTrackMetadataAcrossLibraries(track.id, { fileDeleted: true });
    }
    return saved;
  }

  async function handleOwnAudioUpload(rawFiles) {
    const files = Array.from(rawFiles || []).filter(Boolean);
    if (files.length === 0 || isOffline || ownUploadState.busy) return;

    setOwnUploadState({ busy: true, type: 'info', text: 'Preparando subida…' });
    let uploadedCount = 0;
    let lastError = '';
    const uploadedMissingCover = [];

    try {
      for (let fIdx = 0; fIdx < files.length; fIdx++) {
        const file = files[fIdx];
        const prefix = files.length > 1 ? `(${fIdx + 1}/${files.length}) ` : '';

        if (!file.size || file.size <= 0) {
          lastError = `«${file.name}» está vacío.`;
          continue;
        }
        if (file.size > MAX_OWN_UPLOAD_BYTES) {
          lastError = `«${file.name}» supera el límite máximo de 50 MB.`;
          continue;
        }

        const totalChunks = Math.max(1, Math.ceil(file.size / OWN_UPLOAD_CHUNK_BYTES));
        let sessionId = '';
        let finalPayload = null;
        let failedThisFile = false;

        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
          const start = chunkIdx * OWN_UPLOAD_CHUNK_BYTES;
          const end = Math.min(file.size, start + OWN_UPLOAD_CHUNK_BYTES);
          const slice = file.slice(start, end);
          const pct = Math.max(8, Math.round(((chunkIdx + 1) / (totalChunks + 1)) * 82));

          setOwnUploadState({
            busy: true,
            type: 'info',
            text:
              chunkIdx === totalChunks - 1
                ? `${prefix}Convirtiendo «${file.name}» a M4A…`
                : `${prefix}Subiendo «${file.name}» · ${pct}%`
          });

          let res;
          try {
            res = await fetch('/api/upload', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'x-upload-mode': 'chunk',
                'x-chunk-index': String(chunkIdx),
                'x-total-chunks': String(totalChunks),
                'x-total-size': String(file.size),
                'x-file-name': encodeURIComponent(file.name),
                ...(sessionId ? { 'x-upload-session': sessionId } : {})
              },
              body: slice
            });
          } catch {
            lastError = `Error de red al subir «${file.name}».`;
            failedThisFile = true;
            break;
          }

          const payload = await res.json().catch(() => ({}));
          if (!res.ok || !payload.ok) {
            lastError = payload.error || `No se pudo procesar «${file.name}».`;
            failedThisFile = true;
            break;
          }

          if (payload.partial) {
            sessionId = payload.uploadSession || sessionId;
          } else {
            finalPayload = payload;
          }
        }

        if (failedThisFile || !finalPayload?.track) continue;

        const ownTrack = {
          ...finalPayload.track,
          id: finalPayload.id,
          uploadId: finalPayload.id,
          source: 'own',
          fileDeleted: false,
          addedAt: Date.now()
        };

        // Add to user's library marked as source: "own"
        setLikedTracks(prev => {
          const next = deduplicateTracksList([ownTrack, ...prev]);
          likedTracksRef.current = next;
          try {
            localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(next));
          } catch {}
          return next;
        });

        const targetCustomId =
          activeTab === 'library' && selectedLibrary !== 'liked' && selectedLibrary !== 'offline'
            ? selectedLibrary
            : null;
        if (targetCustomId) {
          setCustomPlaylists(prev => {
            const next = prev.map(pl =>
              pl.id === targetCustomId
                ? { ...pl, tracks: deduplicateTracksList([ownTrack, ...(pl.tracks || [])]) }
                : pl
            );
            customPlaylistsRef.current = next;
            try {
              localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(next));
            } catch {}
            return next;
          });
        }

        scheduleCollectionsSync();

        if (isPlaceholderCover(ownTrack.artwork)) {
          uploadedMissingCover.push(ownTrack);
        }

        setOwnUploadState({
          busy: true,
          type: 'info',
          text: `${prefix}Guardando «${ownTrack.title}» en tu dispositivo…`
        });

        // Cache in Service Worker offline audio cache; saveUrlToOfflineCache calls DELETE /api/upload/:id once cached
        const cachedOk = await saveUrlToOfflineCache(finalPayload.streamUrl, ownTrack);
        setDownloads(prev => ({
          ...prev,
          [ownTrack.id]: {
            status: cachedOk ? 'ready' : 'error',
            progress: cachedOk ? 100 : 0,
            filename: ownTrack.filename
          }
        }));
        uploadedCount += 1;
      }

      if (uploadedMissingCover.length > 0) {
        syncMissingCoversForList(uploadedMissingCover, false);
      }

      if (uploadedCount > 0 && !lastError) {
        setOwnUploadState({
          busy: false,
          type: 'ok',
          text:
            uploadedCount === 1
              ? 'Canción guardada en tu biblioteca y en el teléfono.'
              : `${uploadedCount} canciones guardadas en tu biblioteca y en el teléfono.`
        });
        setTimeout(() => {
          setOwnUploadState(cur => (cur.busy ? cur : { busy: false, type: '', text: '' }));
        }, 5500);
      } else if (lastError) {
        setOwnUploadState({
          busy: false,
          type: 'error',
          text: uploadedCount > 0 ? `${lastError} (${uploadedCount} subida correctamente)` : lastError
        });
      } else {
        setOwnUploadState({ busy: false, type: '', text: '' });
      }
    } catch {
      setOwnUploadState({
        busy: false,
        type: 'error',
        text: 'Ocurrió un error inesperado al subir el archivo.'
      });
    }
  }

  async function startDownload(track, waitUntilFinished = false, forceRetry = false) {
    const key = track.id || track.title;
    if (downloads[key]?.status === 'downloading' && !forceRetry) return false;

    const startedAt = Date.now();
    const isManual = !waitUntilFinished;

    setDownloads(prev => ({
      ...prev,
      [key]: {
        status: 'downloading',
        progress: 0,
        startedAt,
        isManual,
        managedByQueue: Boolean(waitUntilFinished),
        trackMeta: track
      }
    }));

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: track.title,
          artist: track.artist,
          duration: track.duration || null,
          artwork: track.artwork,
          previewUrl: track.previewUrl || null,
          sourceUrl: track.sourceUrl || null,
          priority: isManual,
          query: track.sourceUrl || `${track.title} ${track.artist || ''}`.trim()
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
          startedAt,
          isManual,
          downloadId: dlId,
          managedByQueue: Boolean(waitUntilFinished),
          trackMeta: track
        }
      }));

      const pollToFinish = async () => {
        const pollStartedAt = Date.now();
        while (
          Date.now() - pollStartedAt < 130000 &&
          (!waitUntilFinished || !cancelSyncRef.current)
        ) {
          await new Promise(r => setTimeout(r, 1400));
          try {
            const checkRes = await fetch(`/api/download?id=${dlId}`, { cache: 'no-store' });
            if (checkRes.status === 404) {
              setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
              return false;
            }
            if (!checkRes.ok) continue;
            const checkData = await checkRes.json();
            if (checkData.status === 'ready' && checkData.filename) {
              const streamUrl = `/api/stream?file=${encodeURIComponent(checkData.filename)}`;
              const isGenericTitle =
                !track.title || /^youtube\s*\(/i.test(String(track.title));
              const isGenericArtist =
                !track.artist || String(track.artist).toLowerCase() === 'youtube';
              const resolvedTitle =
                (isGenericTitle && checkData.title ? checkData.title : track.title) ||
                checkData.title ||
                'Canción';
              const resolvedArtist =
                (isGenericArtist && checkData.artist ? checkData.artist : track.artist) ||
                checkData.artist ||
                'Audio MP3';
              const resolvedArtwork = track.artwork || checkData.artwork || DEFAULT_TRACK_COVER;
              const savedOk = await saveUrlToOfflineCache(streamUrl, {
                ...track,
                id: track.id || `offline_${checkData.filename}`,
                title: resolvedTitle,
                artist: resolvedArtist,
                artwork: resolvedArtwork,
                filename: checkData.filename,
                streamUrl
              });
              if (!savedOk) {
                setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
                return false;
              }
              setDownloads(prev => ({
                ...prev,
                [key]: { ...prev[key], ...checkData, status: 'ready', progress: 100 }
              }));
              setResults(prev =>
                prev.map(t =>
                  String(t.id) === String(key)
                    ? {
                        ...t,
                        title: resolvedTitle,
                        artist: resolvedArtist,
                        artwork: resolvedArtwork,
                        filename: checkData.filename,
                        streamUrl
                      }
                    : t
                )
              );
              updateTrackFileAcrossLibraries(key, checkData.filename, streamUrl);
              if (isGenericTitle || isGenericArtist) {
                updateTrackMetadataAcrossLibraries(key, {
                  title: resolvedTitle,
                  artist: resolvedArtist,
                  artwork: resolvedArtwork
                });
              }
              fetchLibraryFiles();
              if (user?.is_admin) fetchAdminData();
              return true;
            }
            if (checkData.status === 'error') {
              setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
              return false;
            }
            setDownloads(prev => ({
              ...prev,
              [key]: {
                ...prev[key],
                progress: checkData.progress || prev[key]?.progress || 8
              }
            }));
          } catch {
            // Transient mobile network handoff: keep polling until timeout
          }
        }
        setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
        return false;
      };

      if (!waitUntilFinished) {
        pollToFinish().catch(() => {});
        return true;
      }

      return await pollToFinish();
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

    await refreshOfflineCacheList();
    const pending = tracksList.filter(t => !isTrackAvailableOffline(t));
    if (pending.length === 0) return;

    // Activate NoSleep synchronously inside user gesture so screen stays awake during bulk download
    noSleepRef.current?.enable();

    cancelSyncRef.current = false;
    setSyncingAll(true);
    setSyncProgress({ done: 0, total: pending.length, currentTitle: pending[0]?.title || '' });

    let completed = 0;
    let nextIdx = 0;
    const workerCount = Math.min(MAX_SIMULTANEOUS_DOWNLOADS, pending.length);

    const runWorker = async () => {
      while (nextIdx < pending.length && !cancelSyncRef.current) {
        const myIdx = nextIdx;
        nextIdx += 1;
        const track = pending[myIdx];
        if (!track || cancelSyncRef.current) break;

        // If the user switched away from the app, wait until they return so mobile OS does not abort the download
        while (
          typeof document !== 'undefined' &&
          document.visibilityState === 'hidden' &&
          !cancelSyncRef.current
        ) {
          await new Promise(r => setTimeout(r, 1000));
        }
        if (cancelSyncRef.current) break;

        setSyncProgress(prev => ({
          done: completed,
          total: pending.length,
          currentTitle: track.title || prev.currentTitle || ''
        }));

        const streamUrl =
          track.streamUrl ||
          (track.filename ? `/api/stream?file=${encodeURIComponent(track.filename)}` : null);
        if (streamUrl && offlineUrls[streamUrl]) {
          completed += 1;
          setSyncProgress({
            done: completed,
            total: pending.length,
            currentTitle: track.title || ''
          });
          continue;
        }

        let ok = false;
        if (streamUrl && !(track.source === 'own' && track.fileDeleted)) {
          ok = await saveUrlToOfflineCache(streamUrl, track);
        }
        // If streamUrl was missing OR its temporary VPS file had already expired/deleted, run a fresh extraction (skip for user-uploaded own files)
        if (!ok && track.source !== 'own') {
          ok = await startDownload(track, true, true);
        }

        // If the download was interrupted specifically because the user briefly left the app, wait until visible and retry this track once
        if (
          !ok &&
          track.source !== 'own' &&
          !cancelSyncRef.current &&
          typeof document !== 'undefined' &&
          document.visibilityState === 'hidden'
        ) {
          while (document.visibilityState === 'hidden' && !cancelSyncRef.current) {
            await new Promise(r => setTimeout(r, 1000));
          }
          if (!cancelSyncRef.current) {
            noSleepRef.current?.enable();
            ok = await startDownload(track, true, true);
          }
        }

        completed += 1;
        setSyncProgress({
          done: completed,
          total: pending.length,
          currentTitle: track.title || ''
        });
      }
    };

    try {
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
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
        h =>
          h.includes('image') ||
          h.includes('imagen') ||
          h.includes('artwork') ||
          h.includes('cover') ||
          h.includes('portada') ||
          h.includes('thumb') ||
          h.includes('foto')
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
        const k = getTrackDedupKey({ title, artist });
        if (seen.has(k)) continue;
        seen.add(k);

        let rawImg = imageIdx >= 0 && cols[imageIdx]?.startsWith('http') ? cols[imageIdx] : null;
        if (!rawImg) {
          const detectedImgCol = cols.find(
            c =>
              c &&
              c.startsWith('http') &&
              (c.includes('scdn.co/image/') ||
                c.includes('mzstatic.com') ||
                /\.(jpg|jpeg|png|webp)(\?|$)/i.test(c))
          );
          if (detectedImgCol) rawImg = detectedImgCol;
        }
        const imgUrl = rawImg ? compressArtworkUrl(rawImg) : DEFAULT_TRACK_COVER;
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
    const deduped = deduplicateTracksList(tracks || []);
    if (deduped.length === 0) return;
    setPendingSpotifyImport({ tracks: deduped, sourceName });
    setSpotifyNewLibName(sourceName);
    setSpotifyMsg({
      type: 'ok',
      text: `Se leyeron ${deduped.length} canciones únicas de «${sourceName}». Elegí dónde guardarlas:`
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
    const freshTracks = deduplicateTracksList(pendingSpotifyImport.tracks || []);
    const fallbackName = (customName || pendingSpotifyImport.sourceName || 'Spotify Import').trim();

    if (targetType === 'liked') {
      const existingKeys = new Set(likedTracks.map(t => getTrackDedupKey(t)));
      const filtered = freshTracks.filter(t => !existingKeys.has(getTrackDedupKey(t)));
      persistLikes([...filtered, ...likedTracks]);
      setSelectedLibrary('liked');
      setSpotifyMsg({
        type: 'ok',
        text: `Listo: se guardaron ${filtered.length} canciones nuevas en Favoritos (${freshTracks.length - filtered.length} duplicadas omitidas).`
      });
      closeSpotifyImportModal();
      if (filtered.some(t => isPlaceholderCover(t?.artwork))) {
        syncMissingCoversForList(filtered, false);
      }
      return;
    }

    if (targetType === 'new_playlist') {
      const created = createCustomPlaylist(fallbackName, freshTracks);
      if (created) {
        setSelectedLibrary(created.id);
        setSpotifyMsg({
          type: 'ok',
          text: `Listo: se guardó la librería «${created.name}» con ${created.tracks.length} canciones sin duplicados.`
        });
      }
      closeSpotifyImportModal();
      return;
    }

    const targetPl = customPlaylists.find(p => p.id === targetType);
    if (targetPl) {
      const existingKeys = new Set(targetPl.tracks.map(t => getTrackDedupKey(t)));
      const filtered = freshTracks.filter(t => !existingKeys.has(getTrackDedupKey(t)));
      const next = customPlaylists.map(p =>
        p.id === targetPl.id
          ? { ...p, tracks: deduplicateTracksList([...filtered, ...p.tracks]) }
          : p
      );
      persistCustomPlaylists(next);
      setSelectedLibrary(targetPl.id);
      setSpotifyMsg({
        type: 'ok',
        text: `Listo: se guardaron ${filtered.length} canciones nuevas en «${targetPl.name}» (${freshTracks.length - filtered.length} duplicadas omitidas).`
      });
      closeSpotifyImportModal();
      if (filtered.some(t => isPlaceholderCover(t?.artwork))) {
        syncMissingCoversForList(filtered, false);
      }
    }
  }

  function isTrackAvailableOffline(track) {
    if (!track) return false;
    const dl = downloads[track.id];
    if (dl?.status === 'ready') return true;
    const offItem = findOfflineItem(track);
    if (offItem) return true;
    if (getCachedBlobUrlForTrack(track)) return true;
    const streamUrl = getTrackStreamUrl(track);
    return Boolean(
      streamUrl && (offlineUrls[streamUrl] || blobUrlCacheRef.current.has(streamUrl))
    );
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

  async function handleSpotifyUrlSubmit(e) {
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
  }

  async function handleInstallPwa() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  }

  const activeDownloadEntries = Object.entries(downloads)
    .filter(([, d]) => d && d.status === 'downloading')
    .sort(([, a], [, b]) => {
      if (Boolean(a.isManual) !== Boolean(b.isManual)) {
        return a.isManual ? -1 : 1;
      }
      return (a.startedAt || 0) - (b.startedAt || 0);
    });
  const totalActiveDownloads = activeDownloadEntries.length;
  const simultaneousActiveCount = Math.min(
    MAX_SIMULTANEOUS_DOWNLOADS,
    totalActiveDownloads
  );
  const queuedWaitingCount = Math.max(
    0,
    totalActiveDownloads - MAX_SIMULTANEOUS_DOWNLOADS
  );

  function renderSimultaneousDownloadsBanner() {
    if (totalActiveDownloads === 0) return null;
    const activeSlots = activeDownloadEntries.slice(0, MAX_SIMULTANEOUS_DOWNLOADS);
    const queueLabel =
      syncingAll && syncProgress.total > 0
        ? `${syncProgress.done}/${syncProgress.total} · ${simultaneousActiveCount}/${MAX_SIMULTANEOUS_DOWNLOADS}`
        : queuedWaitingCount > 0
        ? `${simultaneousActiveCount}/${MAX_SIMULTANEOUS_DOWNLOADS} (+${queuedWaitingCount})`
        : `${simultaneousActiveCount}/${MAX_SIMULTANEOUS_DOWNLOADS}`;
    return (
      <div className="sim-download-bar" role="status" aria-live="polite">
        <span className="sim-download-badge">
          <Icon name="loader" size={12} className="spin" />
          <span>{queueLabel}</span>
        </span>
        <div className="sim-download-slots">
          {activeSlots.map(([key, dl]) => {
            const title = dl.trackMeta?.title || dl.title || 'Canción';
            const pct = Math.round(dl.progress || 8);
            return (
              <span key={key} className="sim-download-chip">
                <span className="sim-download-chip-title">{title}</span>
                <span className="sim-download-chip-pct">{pct}%</span>
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  function renderOwnUploadStatusBanner() {
    if (!ownUploadState.text) return null;
    const toneClass =
      ownUploadState.type === 'error'
        ? 'is-error'
        : ownUploadState.type === 'ok'
        ? 'is-ok'
        : '';
    return (
      <div
        className={`own-upload-status ${toneClass}`.trim()}
        role="status"
        aria-live="polite"
      >
        <div className="own-upload-status-main">
          {ownUploadState.busy ? (
            <Icon name="loader" size={13} className="spin" />
          ) : ownUploadState.type === 'ok' ? (
            <Icon name="check" size={13} />
          ) : (
            <Icon name="upload" size={13} />
          )}
          <span className="own-upload-status-text">{ownUploadState.text}</span>
        </div>
        {!ownUploadState.busy && (
          <button
            type="button"
            className="icon-btn"
            style={{ width: 24, height: 24 }}
            onClick={() => setOwnUploadState({ busy: false, type: '', text: '' })}
            aria-label="Cerrar aviso de subida"
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
    );
  }

  function renderTrackSkeletons(count = 8) {
    return Array.from({ length: count }, (_, i) => (
      <div key={`skel_${i}`} className="track-row skeleton-row" aria-hidden="true">
        <div className="track-row-main">
          <div className="skeleton-block skeleton-cover" />
          <div className="track-text">
            <div
              className="skeleton-block skeleton-line-title"
              style={{ width: `${54 + ((i * 17) % 28)}%` }}
            />
            <div
              className="skeleton-block skeleton-line-sub"
              style={{ width: `${36 + ((i * 13) % 24)}%` }}
            />
          </div>
        </div>
        <div className="track-actions">
          <div className="skeleton-block skeleton-Action" />
          <div className="skeleton-block skeleton-Action" />
        </div>
      </div>
    ));
  }

  // Unified Single-Line Track Row component used in Explore & Libraries
  function renderTrackRow(track, idx, list, contextLib = null) {
    const dlKey = track.id || track.title;
    const dl = downloads[dlKey] || downloads[track.id];
    const dlSlotIndex =
      dl?.status === 'downloading'
        ? activeDownloadEntries.findIndex(
            ([k]) => String(k) === String(dlKey) || String(k) === String(track.id)
          )
        : -1;
    const isQueuedForSlot = dlSlotIndex >= MAX_SIMULTANEOUS_DOWNLOADS;
    const trackDedupKey = getTrackDedupKey(track);
    const offItem = findOfflineItem(track);
    const filename = track.filename || dl?.filename || offItem?.filename;
    const streamUrl =
      track.streamUrl ||
      offItem?.streamUrl ||
      (filename ? `/api/stream?file=${encodeURIComponent(filename)}` : null);
    const isOfflineReady =
      contextLib === 'offline' ||
      dl?.status === 'ready' ||
      Boolean(offItem) ||
      Boolean(streamUrl && (offlineUrls[streamUrl] || blobUrlCacheRef.current.has(streamUrl)));
    const isGreyedOffline = isOffline && !isOfflineReady;
    const isLibraryUndownloaded =
      Boolean(contextLib && contextLib !== 'offline') &&
      !isOfflineReady &&
      dl?.status !== 'downloading';
    const isActualCurrent = Boolean(
      currentTrack &&
        (String(currentTrack.id) === String(track.id) ||
          (trackDedupKey && getTrackDedupKey(currentTrack) === trackDedupKey))
    );
    const isOptimisticCurrent = Boolean(
      optimisticTrack &&
        (String(optimisticTrack.id) === String(track.id) ||
          (trackDedupKey && getTrackDedupKey(optimisticTrack) === trackDedupKey))
    );
    const isPromptTarget = Boolean(
      downloadPrompt?.track && String(downloadPrompt.track.id) === String(track.id)
    );
    const isCurrent = isActualCurrent || isOptimisticCurrent || isPromptTarget;
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
        className={`track-row ${idx >= 10 ? 'track-row-deferred' : ''} ${isCurrent ? 'playing' : ''} ${
          isGreyedOffline ? 'offline-unavailable' : ''
        } ${isLibraryUndownloaded ? 'library-undownloaded' : ''}`.trim()}
      >
        <div
          className="track-row-main"
          onPointerDown={() => {
            if (isOfflineReady && !isGreyedOffline) {
              resolvePlayableSource(track).catch(() => {});
            }
          }}
          onClick={() => {
            if (isGreyedOffline) return;
            setOptimisticTrack(track);
            let targetList = list;
            const resolvedIdx = Array.isArray(list)
              ? list.findIndex(t => String(t.id) === String(track.id))
              : -1;
            let targetIdx = resolvedIdx >= 0 ? resolvedIdx : idx;
            const wasSearching = Boolean(contextLib && libraryQuery.trim());

            if (wasSearching) {
              const reordered = promoteTrackToTopOfLibrary(contextLib, track);
              if (reordered.length > 0) {
                targetList = reordered;
                targetIdx = 0;
              }
              setLibraryQuery('');
            }

            if (isActualCurrent) {
              if (wasSearching && isOfflineReady) {
                playFromList(targetList, 0);
              } else {
                togglePlayPause();
              }
              return;
            }
            if (!isOfflineReady) {
              openDownloadPromptModal(track, targetList, targetIdx);
              return;
            }
            playFromList(targetList, targetIdx);
          }}
          title={
            isGreyedOffline
              ? 'Disponible solo con conexión a internet'
              : !isOfflineReady
              ? 'Descargar o reproducir canción'
              : 'Reproducir'
          }
        >
          <div className="track-cover">
            <img
              src={isPlaceholderCover(track.artwork) ? DEFAULT_TRACK_COVER : track.artwork}
              alt=""
              loading="lazy"
              onError={e => {
                e.currentTarget.src = DEFAULT_TRACK_COVER;
                if (!isPlaceholderCover(track.artwork)) {
                  enrichedArtworkRef.current.delete(String(track.id));
                  updateTrackMetadataAcrossLibraries(track.id, { artwork: DEFAULT_TRACK_COVER });
                }
              }}
            />
            <div className="track-cover-overlay">
              <Icon name={isActualCurrent && isPlaying ? 'pause' : 'play'} size={15} />
            </div>
          </div>

          <div className="track-text">
            <div className="track-title">{track.title}</div>
            <div className="track-sub">
              {isOfflineReady && (
                <span className="offline-inline-dot" title="Descargada en el dispositivo">
                  <Icon name="offline-pin" size={13} />
                  {!contextLib && <span className="offline-tag-label">Descargada</span>}
                </span>
              )}
              {track.source === 'own' && (
                <span className="own-tag-label" title="Subida desde tu dispositivo">
                  Propia
                </span>
              )}
              <span className="track-sub-text">
                {dl?.status === 'downloading'
                  ? isQueuedForSlot
                    ? `En cola · ${track.artist}`
                    : `${Math.round(dl.progress || 8)}% · ${track.artist}`
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
              onClick={() => {
                if (track.source === 'own') {
                  if (!track.fileDeleted) {
                    cacheOwnTrackAndConfirmDelete(track);
                  } else {
                    openDownloadPromptModal(track, list, idx);
                  }
                  return;
                }
                startDownload(track);
              }}
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
      playFromList(tracks, 0, startRandom, { preserveOrder: !startRandom });
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
      playFromList(list, idx, false, { preserveOrder: true });
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

  const playableActiveLibraryTracks = activeLibraryTracks.filter(t =>
    isTrackAvailableOffline(t)
  );

  const activeLibraryTitle =
    selectedLibrary === 'liked'
      ? 'Favoritos'
      : selectedLibrary === 'offline'
      ? 'Descargadas (Offline)'
      : activeCustomPlaylist
      ? activeCustomPlaylist.name
      : 'Favoritos';

  const missingCoversInActiveLibrary = activeLibraryTracks.filter(
    t => t && isPlaceholderCover(t.artwork)
  );

  const totalMissingCoversForButton = (() => {
    const seen = new Set();
    for (const t of missingCoversInActiveLibrary) {
      seen.add(resolveOwnUploadId(t) || String(t.id));
    }
    const ownPools = [
      ...likedTracks,
      ...offlineCatalog,
      ...customPlaylists.flatMap(pl => pl?.tracks || [])
    ];
    for (const t of ownPools) {
      if (!t || !isPlaceholderCover(t.artwork)) continue;
      const isOwn =
        t.source === 'own' ||
        Boolean(resolveOwnUploadId(t)) ||
        String(t.artist || '').trim().toLowerCase() === 'archivo propio';
      if (isOwn) {
        seen.add(resolveOwnUploadId(t) || String(t.id));
      }
    }
    return seen.size;
  })();

  const normalizedLibQuery = libraryQuery
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const filteredLibraryTracks = normalizedLibQuery
    ? activeLibraryTracks.filter(t => {
        const hay = `${t.title || ''} ${t.artist || ''} ${t.album || ''}`
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        return hay.includes(normalizedLibQuery);
      })
    : activeLibraryTracks;

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
            aria-current={activeTab === 'explore' ? 'page' : undefined}
            onClick={() => setActiveTab('explore')}
          >
            <Icon name="search" size={16} />
            <span>Explorar</span>
          </button>

          <button
            type="button"
            className={`nav-link ${activeTab === 'foryou' ? 'active' : ''}`.trim()}
            aria-current={activeTab === 'foryou' ? 'page' : undefined}
            onClick={() => setActiveTab('foryou')}
          >
            <Icon name="sparkles" size={16} />
            <span>Para ti</span>
          </button>

          <button
            type="button"
            className={`nav-link ${activeTab === 'library' ? 'active' : ''}`}
            aria-current={activeTab === 'library' ? 'page' : undefined}
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
        <section className="tab-section">
          <div className="sticky-top-zone">
            <div className="sticky-top-inner">
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
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={isOffline}
                  onClick={() => openYtLinkModal('offline')}
                  title="Pegar link directo de YouTube para descargar canción rara"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}
                >
                  <Icon name="youtube" size={15} />
                  <span>YouTube</span>
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
                  <label
                    htmlFor="upload-own-music-exp"
                    className={`library-pill upload-trigger-label ${
                      isOffline || ownUploadState.busy ? 'is-disabled' : ''
                    }`.trim()}
                    title="Subir archivo de audio propio (.mp3, .m4a, .wav o .flac)"
                  >
                    <input
                      ref={ownUploadInputExpRef}
                      id="upload-own-music-exp"
                      type="file"
                      accept={OWN_AUDIO_ACCEPT}
                      multiple
                      className="visually-hidden"
                      disabled={isOffline || ownUploadState.busy}
                      onChange={e => {
                        const selectedFiles = Array.from(e.target.files || []);
                        e.target.value = '';
                        handleOwnAudioUpload(selectedFiles);
                      }}
                    />
                    <Icon
                      name={ownUploadState.busy ? 'loader' : 'upload'}
                      size={14}
                      className={ownUploadState.busy ? 'spin' : ''}
                    />
                    <span>Subir mi música</span>
                  </label>
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
              {renderOwnUploadStatusBanner()}
              {renderSimultaneousDownloadsBanner()}
            </div>
          </div>

          {loading ? (
            <div className="track-list" aria-busy="true" aria-label="Cargando canciones">
              {renderTrackSkeletons(8)}
            </div>
          ) : results.length === 0 ? (
            <div className="empty">
              <div className="empty-title">Sin resultados por ahora</div>
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
        <section className="tab-section">
          <div className="sticky-top-zone">
            <div className="sticky-top-inner">
              <div className="library-switcher" role="tablist" aria-label="Tus librerías">
                <button
                  type="button"
                  className={`library-pill ${selectedLibrary === 'liked' ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedLibrary('liked');
                    setLibraryQuery('');
                  }}
                >
                  <Icon name="heart-fill" size={13} />
                  <span>Favoritos</span>
                  <span className="library-pill-count">{likedTracks.length}</span>
                </button>

                <button
                  type="button"
                  className={`library-pill ${selectedLibrary === 'offline' ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedLibrary('offline');
                    setLibraryQuery('');
                  }}
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
                    onClick={() => {
                      setSelectedLibrary(pl.id);
                      setLibraryQuery('');
                    }}
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

                <button
                  type="button"
                  className="library-pill"
                  disabled={isOffline}
                  onClick={() => openYtLinkModal(selectedLibrary)}
                  title="Descargar canción con link de YouTube"
                >
                  <Icon name="youtube" size={14} />
                  <span>Link YouTube</span>
                </button>

                <label
                  htmlFor="upload-own-music-lib"
                  className={`library-pill upload-trigger-label ${
                    isOffline || ownUploadState.busy ? 'is-disabled' : ''
                  }`.trim()}
                  title="Subir archivo de audio propio (.mp3, .m4a, .wav o .flac)"
                >
                  <input
                    ref={ownUploadInputLibRef}
                    id="upload-own-music-lib"
                    type="file"
                    accept={OWN_AUDIO_ACCEPT}
                    multiple
                    className="visually-hidden"
                    disabled={isOffline || ownUploadState.busy}
                    onChange={e => {
                      const selectedFiles = Array.from(e.target.files || []);
                      e.target.value = '';
                      handleOwnAudioUpload(selectedFiles);
                    }}
                  />
                  <Icon
                    name={ownUploadState.busy ? 'loader' : 'upload'}
                    size={14}
                    className={ownUploadState.busy ? 'spin' : ''}
                  />
                  <span>Subir mi música</span>
                </label>
              </div>

              {creatingPlaylist && (
                <form
                  className="search-bar"
                  style={{ marginBottom: 8 }}
                  onSubmit={e => {
                    e.preventDefault();
                    const created = createCustomPlaylist(newPlaylistName);
                    if (created) {
                      setNewPlaylistName('');
                      setCreatingPlaylist(false);
                      setSelectedLibrary(created.id);
                      setLibraryQuery('');
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
                    {coverSync.active && coverSync.total > 0 ? (
                      <>
                        <Icon name="image" size={13} />
                        <span>
                          Portadas {coverSync.done}/{coverSync.total} · {activeLibraryTracks.length}{' '}
                          {activeLibraryTracks.length === 1 ? 'canción' : 'canciones'}
                        </span>
                      </>
                    ) : (
                      <span>
                        {activeLibraryTracks.length}{' '}
                        {activeLibraryTracks.length === 1 ? 'canción' : 'canciones'}
                        {selectedLibrary === 'offline' && deviceQuota
                          ? ` · ${deviceQuota.usedMB} MB en dispositivo`
                          : selectedLibrary !== 'offline' && playableActiveLibraryTracks.length > 0
                          ? ` · ${playableActiveLibraryTracks.length} offline`
                          : missingCoversInActiveLibrary.length > 0 && !isOffline
                          ? ` · ${missingCoversInActiveLibrary.length} sin portada`
                          : ''}
                      </span>
                    )}
                  </div>
                </div>

                <div className="playlist-header-actions">
                  <button
                    type="button"
                    className={`icon-btn ${shuffle ? 'active' : ''}`}
                    onClick={toggleShuffle}
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

                  {(totalMissingCoversForButton > 0 || coverSync.active) && (
                    <button
                      type="button"
                      className={`icon-btn ${coverSync.active ? 'active' : ''}`}
                      disabled={isOffline}
                      onClick={() => syncMissingCoversForList(activeLibraryTracks, true)}
                      aria-label={
                        coverSync.active
                          ? `Pausar carga de portadas (${coverSync.done} de ${coverSync.total})`
                          : `Descargar portadas faltantes (${totalMissingCoversForButton})`
                      }
                      title={
                        coverSync.active
                          ? `Pausar carga de portadas (${coverSync.done}/${coverSync.total})`
                          : `Descargar portadas faltantes (${totalMissingCoversForButton})`
                      }
                    >
                      <Icon
                        name={coverSync.active ? 'loader' : 'image'}
                        size={17}
                        className={coverSync.active ? 'spin' : ''}
                      />
                    </button>
                  )}

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
                    onPointerDown={() => {
                      if (playableActiveLibraryTracks.length > 0) {
                        const sample = playableActiveLibraryTracks.slice(0, 4);
                        sample.forEach(t => resolvePlayableSource(t).catch(() => {}));
                      }
                    }}
                    onClick={() => playFromList(activeLibraryTracks, 0, true)}
                    title="Reproducir librería en aleatorio"
                  >
                    <Icon name="play" size={18} />
                  </button>
                </div>
              </div>

              {activeLibraryTracks.length > 0 && (
                <div className="library-search-wrap">
                  <div className="search-bar" style={{ marginBottom: libraryQuery.trim() ? 6 : 0 }}>
                    <span className="search-icon">
                      <Icon name="search" size={16} />
                    </span>
                    <input
                      type="search"
                      className="search-input"
                      placeholder={`Buscar en ${activeLibraryTitle} (canción, artista o álbum)…`}
                      value={libraryQuery}
                      onChange={e => setLibraryQuery(e.target.value)}
                    />
                    {libraryQuery && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => setLibraryQuery('')}
                        aria-label="Limpiar búsqueda"
                      >
                        <Icon name="close" size={15} />
                      </button>
                    )}
                  </div>
                  {libraryQuery.trim() && (
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-secondary)',
                        paddingLeft: 4
                      }}
                    >
                      Tocá cualquier resultado para subirlo al #1 y reproducir tu librería desde ahí ({filteredLibraryTracks.length}{' '}
                      {filteredLibraryTracks.length === 1 ? 'resultado' : 'resultados'})
                    </div>
                  )}
                </div>
              )}

              {renderOwnUploadStatusBanner()}
              {renderSimultaneousDownloadsBanner()}
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
          ) : filteredLibraryTracks.length === 0 ? (
            <div className="empty">
              <div className="empty-title">Sin coincidencias en {activeLibraryTitle}</div>
              <p>No encontramos «{libraryQuery}» en esta librería.</p>
            </div>
          ) : (
            <div className="track-list">
              {filteredLibraryTracks
                .slice(0, visibleLibraryCount)
                .map((track, idx) =>
                  renderTrackRow(track, idx, activeLibraryTracks, selectedLibrary)
                )}
              {visibleLibraryCount < filteredLibraryTracks.length && (
                <div ref={libraryLoadMoreRef} className="library-load-more">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() =>
                      setVisibleLibraryCount(prev =>
                        Math.min(prev + 15, filteredLibraryTracks.length)
                      )
                    }
                  >
                    Mostrando {Math.min(visibleLibraryCount, filteredLibraryTracks.length)} de{' '}
                    {filteredLibraryTracks.length} canciones · Cargar más
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
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

      {/* ==================== DIALOG 1: TRACK OPTIONS SHEET (⋯) ==================== */}
      <dialog
        ref={menuDialogRef}
        closedby="any"
        className="save-dialog"
        aria-labelledby="track-menu-title"
        onClose={() => setMenuTrack(null)}
        onClick={e => handleDialogBackdropClick(e, closeTrackMenu)}
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

              <button
                type="button"
                className="dialog-option"
                onClick={() => openEditTrackModal(menuTrack.track)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="edit" size={15} /> Editar título, artista y portada…
                </span>
                <Icon name="arrow-right" size={14} />
              </button>

              {isTrackAvailableOffline(menuTrack.track) ? (
                <>
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
                  <button
                    type="button"
                    className="dialog-option"
                    disabled={isOffline}
                    onClick={async () => {
                      const target = menuTrack.track;
                      closeTrackMenu();
                      await deleteOfflineTrack(target);
                      await startDownload(target, false, true);
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Icon name="refresh" size={15} /> Volver a descargar audio original (Reemplazar)
                    </span>
                  </button>
                </>
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

              {resolveOwnUploadId(menuTrack.track) && (
                <button
                  type="button"
                  className="dialog-option danger"
                  onClick={() => {
                    const target = menuTrack.track;
                    closeTrackMenu();
                    deleteOwnUploadEverywhere(target);
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="trash" size={15} /> Eliminar canción subida de mi cuenta
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
        onClick={e => handleDialogBackdropClick(e, closeSaveModal)}
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
        onClick={e => handleDialogBackdropClick(e, closeSpotifyImportModal)}
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

      {/* ==================== DIALOG 4: DOWNLOAD UNDOWNLOADED LIBRARY TRACK MODAL ==================== */}
      <dialog
        ref={downloadDialogRef}
        closedby="any"
        className="save-dialog"
        aria-labelledby="download-dialog-title"
        onClose={() => setDownloadPrompt(null)}
        onClick={e => handleDialogBackdropClick(e, closeDownloadPromptModal)}
      >
        {downloadPrompt?.track && (
          <div>
            <div className="dialog-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <div className="track-cover" style={{ width: 40, height: 40 }}>
                  <img
                    src={
                      isPlaceholderCover(downloadPrompt.track.artwork)
                        ? DEFAULT_TRACK_COVER
                        : downloadPrompt.track.artwork
                    }
                    alt=""
                    onError={e => {
                      e.currentTarget.src = DEFAULT_TRACK_COVER;
                    }}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div id="download-dialog-title" className="dialog-title">
                    ¿Deseás descargar esta canción?
                  </div>
                  <div className="dialog-sub">
                    {downloadPrompt.track.title} · {downloadPrompt.track.artist}
                  </div>
                </div>
              </div>
              <button type="button" className="icon-btn" onClick={closeDownloadPromptModal}>
                <Icon name="close" size={16} />
              </button>
            </div>

            <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', margin: '0 0 12px' }}>
              {downloadPrompt.track.source === 'own' && downloadPrompt.track.fileDeleted
                ? 'Esta canción subida ya se eliminó del servidor tras guardarse en tu otro dispositivo. Sube el archivo desde este equipo si quieres escucharla aquí también.'
                : 'Esta canción de tu librería todavía no está descargada en el dispositivo para escuchar sin internet.'}
            </p>

            <div className="dialog-list">
              {downloadPrompt.track.source === 'own' && downloadPrompt.track.fileDeleted ? (
                <button
                  type="button"
                  className="dialog-option selected"
                  disabled={isOffline || ownUploadState.busy}
                  onClick={() => {
                    setOptimisticTrack(null);
                    closeDownloadPromptModal();
                    (ownUploadInputLibRef.current || ownUploadInputExpRef.current)?.click();
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="upload" size={15} /> Subir mi música en este dispositivo
                  </span>
                  <Icon name="arrow-right" size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="dialog-option selected"
                  disabled={isOffline}
                  onClick={async () => {
                    const target = downloadPrompt;
                    setOptimisticTrack(target.track);
                    closeDownloadPromptModal();
                    const ok =
                      target.track.source === 'own'
                        ? await cacheOwnTrackAndConfirmDelete(target.track)
                        : await startDownload(target.track, true);
                    if (ok && target.list?.length > 0) {
                      playFromList(target.list, target.idx, false, {
                        forceIncludeTrack: target.track
                      });
                    } else if (!ok) {
                      setOptimisticTrack(null);
                    }
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="download" size={15} /> Sí, descargar y reproducir
                  </span>
                  <Icon name="arrow-right" size={14} />
                </button>
              )}

              {downloadPrompt.track.previewUrl && (
                <button
                  type="button"
                  className="dialog-option"
                  disabled={isOffline}
                  onClick={() => {
                    const target = downloadPrompt;
                    setOptimisticTrack(target.track);
                    closeDownloadPromptModal();
                    playFromList(target.list, target.idx, false, {
                      allowSinglePreview: true
                    });
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="play" size={15} /> Solo escuchar vista previa (30 s)
                  </span>
                </button>
              )}

              <button
                type="button"
                className="dialog-option"
                onClick={() => {
                  setOptimisticTrack(null);
                  closeDownloadPromptModal();
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="close" size={15} /> Cancelar
                </span>
              </button>
            </div>
          </div>
        )}
      </dialog>

      {/* ==================== DIALOG 5: YOUTUBE DIRECT LINK DOWNLOAD MODAL ==================== */}
      <dialog
        ref={ytDialogRef}
        closedby="any"
        className="save-dialog"
        aria-labelledby="yt-dialog-title"
        onClose={() => setYtModalOpen(false)}
        onClick={e => handleDialogBackdropClick(e, closeYtLinkModal)}
      >
        <div>
          <div className="dialog-head">
            <div style={{ minWidth: 0 }}>
              <div
                id="yt-dialog-title"
                className="dialog-title"
                style={{ display: 'flex', alignItems: 'center', gap: 7 }}
              >
                <Icon name="youtube" size={17} />
                <span>Descargar desde link de YouTube</span>
              </div>
              <div className="dialog-sub">
                Ideal para canciones raras, covers, remixes o temas que solo están en YouTube
              </div>
            </div>
            <button type="button" className="icon-btn" onClick={closeYtLinkModal}>
              <Icon name="close" size={16} />
            </button>
          </div>

          <form onSubmit={handleYtLinkSubmit}>
            <div className="search-bar" style={{ marginBottom: 10 }}>
              <Icon name="youtube" size={16} className="search-icon" />
              <input
                type="url"
                className="search-input"
                placeholder="Pegá el link (https://youtu.be/... o youtube.com/watch?v=...)"
                value={ytLinkUrl}
                onChange={e => {
                  const val = e.target.value;
                  setYtLinkUrl(val);
                  resolveYtLinkPreview(val);
                }}
                autoFocus
                required
              />
              {ytLinkUrl && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    setYtLinkUrl('');
                    setYtLinkPreview(null);
                    setYtLinkError('');
                  }}
                  aria-label="Limpiar link"
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>

            {ytLinkLoading && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 10 }}>
                Obteniendo datos del video…
              </div>
            )}

            {ytLinkPreview && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 12,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  marginBottom: 10
                }}
              >
                <div className="track-cover" style={{ width: 42, height: 42, flexShrink: 0 }}>
                  <img
                    src={
                      isPlaceholderCover(ytLinkPreview.artwork)
                        ? DEFAULT_TRACK_COVER
                        : ytLinkPreview.artwork
                    }
                    alt=""
                    onError={e => {
                      e.currentTarget.src = DEFAULT_TRACK_COVER;
                    }}
                  />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="track-title" style={{ fontSize: '0.84rem' }}>
                    {ytLinkPreview.title}
                  </div>
                  <div className="track-sub" style={{ fontSize: '0.74rem' }}>
                    {ytLinkPreview.artist}
                  </div>
                </div>
              </div>
            )}

            {ytLinkError && (
              <div
                style={{
                  fontSize: '0.78rem',
                  color: '#ef4444',
                  marginBottom: 10
                }}
              >
                {ytLinkError}
              </div>
            )}

            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginBottom: 6 }}>
              Guardar también en:
            </div>
            <div className="dialog-list" style={{ maxHeight: 165, overflowY: 'auto', marginBottom: 12 }}>
              <button
                type="button"
                className={`dialog-option ${ytLinkTargetLib === 'offline' ? 'selected' : ''}`}
                onClick={() => setYtLinkTargetLib('offline')}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Icon name="offline-pin" size={14} /> Solo en Descargadas (dispositivo)
                </span>
                {ytLinkTargetLib === 'offline' && <Icon name="check" size={14} />}
              </button>

              <button
                type="button"
                className={`dialog-option ${ytLinkTargetLib === 'liked' ? 'selected' : ''}`}
                onClick={() => setYtLinkTargetLib('liked')}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Icon name="heart-fill" size={14} /> Favoritos
                </span>
                {ytLinkTargetLib === 'liked' && <Icon name="check" size={14} />}
              </button>

              {customPlaylists.map(pl => (
                <button
                  key={pl.id}
                  type="button"
                  className={`dialog-option ${ytLinkTargetLib === pl.id ? 'selected' : ''}`}
                  onClick={() => setYtLinkTargetLib(pl.id)}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <Icon name="folder" size={14} /> {pl.name}
                  </span>
                  {ytLinkTargetLib === pl.id && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn ghost sm" onClick={closeYtLinkModal}>
                Cancelar
              </button>
              <button
                type="submit"
                className="btn sm"
                disabled={isOffline || !ytLinkUrl.trim()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Icon name="download" size={14} />
                <span>Descargar canción</span>
              </button>
            </div>
          </form>
        </div>
      </dialog>

      {/* ==================== DIALOG 6: EDIT TRACK METADATA MODAL ==================== */}
      <dialog
        ref={editDialogRef}
        closedby="any"
        className="save-dialog"
        aria-labelledby="edit-dialog-title"
        onClose={() => setEditingTrack(null)}
        onClick={e => handleDialogBackdropClick(e, closeEditTrackModal)}
      >
        {editingTrack && (
          <div>
            <div className="dialog-head">
              <div style={{ minWidth: 0 }}>
                <h2 id="edit-dialog-title" className="dialog-title" style={{ margin: 0 }}>
                  Editar canción
                </h2>
                <div className="dialog-sub">
                  Corrige el título o artista para obtener la portada exacta
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={closeEditTrackModal}
                aria-label="Cerrar editor"
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            <form className="form" onSubmit={handleEditTrackSubmit}>
              <div className="field">
                <label htmlFor="edit-track-title">Título de la canción</label>
                <input
                  id="edit-track-title"
                  name="title"
                  type="text"
                  required
                  autoFocus
                  value={editForm.title}
                  onChange={e => setEditForm(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="Ej. La Pinta La Niña y la Santa María"
                />
              </div>

              <div className="field">
                <label htmlFor="edit-track-artist">Artista o grupo</label>
                <input
                  id="edit-track-artist"
                  name="artist"
                  type="text"
                  value={editForm.artist}
                  onChange={e => setEditForm(prev => ({ ...prev, artist: e.target.value }))}
                  placeholder="Ej. Black Sun"
                />
              </div>

              <div className="field">
                <label htmlFor="edit-track-album">Álbum (opcional)</label>
                <input
                  id="edit-track-album"
                  name="album"
                  type="text"
                  value={editForm.album}
                  onChange={e => setEditForm(prev => ({ ...prev, album: e.target.value }))}
                  placeholder="Ej. La Lógica del León"
                />
              </div>

              {!isOffline && (
                <div className="checkbox-inline-row">
                  <input
                    id="edit-track-refresh-cover"
                    name="refreshCover"
                    type="checkbox"
                    checked={Boolean(editForm.refreshCover)}
                    onChange={e =>
                      setEditForm(prev => ({ ...prev, refreshCover: e.target.checked }))
                    }
                  />
                  <label htmlFor="edit-track-refresh-cover">
                    Buscar y actualizar portada automáticamente al guardar
                  </label>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                <button type="button" className="btn ghost sm" onClick={closeEditTrackModal}>
                  Cancelar
                </button>
                <button type="submit" className="btn sm">
                  Guardar cambios
                </button>
              </div>
            </form>
          </div>
        )}
      </dialog>

      {/* ==================== COMPACT FLOATING MINI-PLAYER DOCK ==================== */}
      {currentTrack && (
        <div className="player-dock">
          <PlayerScrubber audioRef={audioRef} trackKey={currentTrack.id} />

          <div className="player-main">
            <div className="player-track">
              <img
                src={
                  isPlaceholderCover(currentTrack.artwork)
                    ? DEFAULT_TRACK_COVER
                    : currentTrack.artwork
                }
                alt=""
                onError={e => {
                  e.currentTarget.src = DEFAULT_TRACK_COVER;
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
                onClick={toggleShuffle}
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
        </div>
      )}

      <audio
        ref={audioRef}
        preload="auto"
        playsInline
        onTimeUpdate={e => {
          const cur = e.currentTarget.currentTime;
          handlePlaybackTimeTick(cur, e.currentTarget.duration);
          const warmKey = `${currentIndexRef.current}_${queueRef.current.length}`;
          if (cur > 0.5 && lastWarmedKeyRef.current !== warmKey) {
            lastWarmedKeyRef.current = warmKey;
            preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
          }
        }}
        onLoadedMetadata={e => {
          const audioEl = e.currentTarget;
          const dur = audioEl.duration;
          if (isPlayingRef.current && audioEl.paused && !playInFlightRef.current) {
            playInFlightRef.current = true;
            audioEl
              .play()
              .then(() => {
                playInFlightRef.current = false;
                consecutivePlayFailuresRef.current = 0;
                isPlayingRef.current = true;
                setIsPlaying(true);
                preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
              })
              .catch(() => {
                playInFlightRef.current = false;
                const stillPlaying = !audioEl.paused;
                isPlayingRef.current = stillPlaying;
                setIsPlaying(stillPlaying);
              });
          }
          if (
            typeof navigator !== 'undefined' &&
            'mediaSession' in navigator &&
            typeof navigator.mediaSession.setPositionState === 'function' &&
            dur > 0 &&
            Number.isFinite(dur)
          ) {
            try {
              navigator.mediaSession.setPositionState({
                duration: dur,
                playbackRate: audioEl.paused ? 0 : audioEl.playbackRate || 1,
                position: Math.min(dur, audioEl.currentTime || 0)
              });
            } catch {}
          }
        }}
        onEnded={handleTrackEnded}
        onError={() => {
          playInFlightRef.current = false;
          if (
            queueRef.current.length > 1 &&
            consecutivePlayFailuresRef.current < Math.min(queueRef.current.length, 8)
          ) {
            consecutivePlayFailuresRef.current += 1;
            playNext();
          } else {
            isPlayingRef.current = false;
            setIsPlaying(false);
          }
        }}
        onPlay={e => {
          const audioEl = e.currentTarget;
          playInFlightRef.current = false;
          consecutivePlayFailuresRef.current = 0;
          isPlayingRef.current = true;
          setIsPlaying(true);
          preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
          if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
            try {
              navigator.mediaSession.playbackState = 'playing';
              const dur = audioEl.duration;
              if (
                typeof navigator.mediaSession.setPositionState === 'function' &&
                dur > 0 &&
                Number.isFinite(dur)
              ) {
                navigator.mediaSession.setPositionState({
                  duration: dur,
                  playbackRate: audioEl.playbackRate || 1,
                  position: Math.min(dur, audioEl.currentTime || 0)
                });
              }
            } catch {}
          }
        }}
        onPause={e => {
          const audioEl = e.currentTarget;
          if (audioEl.ended || playInFlightRef.current) return;
          isPlayingRef.current = false;
          setIsPlaying(false);
          if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
            try {
              navigator.mediaSession.playbackState = 'paused';
              const dur = audioEl.duration;
              if (
                typeof navigator.mediaSession.setPositionState === 'function' &&
                dur > 0 &&
                Number.isFinite(dur)
              ) {
                navigator.mediaSession.setPositionState({
                  duration: dur,
                  playbackRate: 0,
                  position: Math.min(dur, audioEl.currentTime || 0)
                });
              }
            } catch {}
          }
        }}
      />

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
          className={activeTab === 'foryou' ? 'active' : ''}
          aria-current={activeTab === 'foryou' ? 'page' : undefined}
          onClick={() => setActiveTab('foryou')}
        >
          <Icon name="sparkles" size={18} />
          <span>Para ti</span>
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
