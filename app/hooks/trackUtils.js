export const AUDIO_CACHE_NAME = 'my-music-offline-audio-v1';
export const SHELL_CACHE_NAME = 'mymusic-shell-v31';
export const DEFAULT_TRACK_COVER = '/icon.svg?v=3';
export const FORYOU_RECS_STORAGE_KEY = 'mma_foryou_recs_v1';
export const USER_STORAGE_KEY = 'mma_cached_user_v1';
export const LIKES_STORAGE_KEY = 'mma_liked_tracks_v1';
export const DELETED_LIKES_STORAGE_KEY = 'mma_deleted_likes_v1';
export const OFFLINE_CATALOG_KEY = 'mma_offline_catalog_v1';
export const PLAYLISTS_STORAGE_KEY = 'mma_custom_playlists_v1';
export const DELETED_PLAYLISTS_STORAGE_KEY = 'mma_deleted_playlists_v1';
export const UNLIKED_OWN_STORAGE_KEY = 'mma_unliked_own_v1';
export const SYNCED_UID_STORAGE_KEY = 'mma_synced_uid_v1';
export const COLLECTIONS_DIRTY_KEY = 'mma_collections_dirty_v1';
export const COLLECTIONS_VERSION_KEY_PREFIX = 'mma_collections_version_v1_';
export const MAX_COLLECTION_SYNC_RETRIES = 3;
export const MAX_SIMULTANEOUS_DOWNLOADS = 4;
export const MAX_OWN_UPLOAD_BYTES = 50 * 1024 * 1024;
export const OWN_UPLOAD_CHUNK_BYTES = Math.floor(3.5 * 1024 * 1024);
export const OWN_AUDIO_ACCEPT =
  '.mp3,.m4a,.wav,.flac,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/flac,audio/x-flac';

export const EXPLORE_CHIPS = [
  { id: 'for-you', label: 'Para vos', term: null },
  { id: 'trending', label: 'Tendencias', term: 'Top Hits Global 2025' },
  { id: 'latin', label: 'Pop Latino', term: 'Pop Latino Hits' },
  { id: 'urbano', label: 'Urbano', term: 'Reggaeton Urbano Latino' },
  { id: 'rock', label: 'Rock', term: 'Rock Clásico Español' },
  { id: 'electro', label: 'Electrónica', term: 'Daft Punk Electronic Synth' },
  { id: 'rnb', label: 'R&B & Soul', term: 'The Weeknd R&B Soul' },
  { id: 'indie', label: 'Indie', term: 'Indie Alternative Hits' }
];

export function isPlaceholderCover(rawUrl) {
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

export function compressArtworkUrl(rawUrl) {
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

export function getTrackDedupKey(track) {
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

export function deduplicateTracksList(list) {
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

export function sanitizeLikedTracksList(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(
    t =>
      t &&
      !String(t.id || '').startsWith('offline_') &&
      String(t.genre || '').trim().toLowerCase() !== 'offline' &&
      String(t.album || '').trim().toLowerCase() !== 'guardado en dispositivo'
  );
}
