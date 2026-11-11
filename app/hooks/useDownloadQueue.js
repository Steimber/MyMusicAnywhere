import { NoSleepController } from '../../lib/nosleep';
import {
  NO_SOURCE_FOUND_ERROR,
  classifyDirectLinkSource
} from '../../lib/download/youtube-status';
import {
  AUDIO_CACHE_NAME,
  DEFAULT_TRACK_COVER,
  LIKES_STORAGE_KEY,
  OFFLINE_CATALOG_KEY,
  PLAYLISTS_STORAGE_KEY,
  UNLIKED_OWN_STORAGE_KEY,
  MAX_SIMULTANEOUS_DOWNLOADS,
  MAX_OWN_UPLOAD_BYTES,
  OWN_UPLOAD_CHUNK_BYTES,
  isPlaceholderCover,
  getTrackDedupKey,
  deduplicateTracksList
} from './trackUtils';

export function useDownloadQueue({
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
}) {
  function openYtLinkModal(defaultLib = null, initialUrl = '') {
    const cleanInit = String(initialUrl || '').trim();
    setYtLinkUrl(cleanInit);
    setYtLinkPreview(null);
    setYtLinkError('');
    setYtLinkNotice('');
    setYtLinkProgress(0);
    setYtLinkReadyTrack(null);
    setYtLinkLoading(false);
    setYtLinkStage('idle');
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
      if (cleanInit) {
        resolveYtLinkPreview(cleanInit);
      }
    }, 15);
  }

  function closeYtLinkModal() {
    if (ytDialogRef.current && ytDialogRef.current.open) {
      ytDialogRef.current.close();
    }
    setYtModalOpen(false);
    setYtLinkError('');
    setYtLinkNotice('');
  }

  async function resolveYtLinkPreview(rawUrl) {
    const reqId = ++ytPreviewReqIdRef.current;
    const clean = String(rawUrl || '').trim();
    setYtLinkReadyTrack(null);
    setYtLinkNotice('');
    setYtLinkProgress(0);

    if (!clean) {
      setYtLinkPreview(null);
      setYtLinkError('');
      setYtLinkLoading(false);
      setYtLinkStage('idle');
      return null;
    }

    const linkInfo = classifyDirectLinkSource(clean);
    if (!linkInfo.isUrl) {
      setYtLinkPreview(null);
      setYtLinkLoading(false);
      setYtLinkStage('idle');
      return null;
    }
    if (!linkInfo.supported) {
      setYtLinkPreview(null);
      setYtLinkLoading(false);
      setYtLinkStage('error');
      setYtLinkError('Fuente no soportada (Otra fuente). Pega un enlace directo de YouTube o SoundCloud.');
      return null;
    }

    setYtLinkLoading(true);
    setYtLinkStage('analyzing');
    setYtLinkError('');
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(clean)}`);
      const data = await res.json();
      if (ytPreviewReqIdRef.current !== reqId) return null;
      if (!res.ok) {
        setYtLinkPreview(null);
        setYtLinkLoading(false);
        setYtLinkStage('error');
        setYtLinkError(data.error || 'No se pudo analizar ese enlace.');
        return null;
      }
      const first = (data.results || data.tracks || [])[0] || null;
      if (first) {
        setYtLinkPreview(first);
        setYtLinkLoading(false);
        setYtLinkStage('preview');
        return first;
      }
    } catch {}
    if (ytPreviewReqIdRef.current === reqId) {
      setYtLinkLoading(false);
      setYtLinkStage('error');
      setYtLinkError('No se pudo analizar el enlace. Verifica la dirección e inténtalo de nuevo.');
    }
    return null;
  }

  async function runDirectLinkDownload(forceAlternateSource = false) {
    if (isOffline) return;
    const clean = String(ytLinkUrl || '').trim();
    const linkInfo = classifyDirectLinkSource(clean);
    if (!linkInfo.isUrl) {
      setYtLinkStage('error');
      setYtLinkError('Pega un enlace válido de YouTube o SoundCloud.');
      return;
    }
    if (!linkInfo.supported) {
      setYtLinkStage('error');
      setYtLinkError('Fuente no soportada (Otra fuente). Pega un enlace directo de YouTube o SoundCloud.');
      return;
    }

    setYtLinkError('');
    setYtLinkNotice('');
    let trackObj = ytLinkPreview;
    if (!trackObj || trackObj.sourceUrl !== clean) {
      trackObj = await resolveYtLinkPreview(clean);
    }
    if (!trackObj) return;

    if (ytLinkTargetLib === 'liked') {
      if (!apiRef.current.isLiked?.(trackObj.id)) {
        apiRef.current.persistLikes?.([{ ...trackObj, addedAt: Date.now() }, ...likedTracks]);
      }
    } else if (ytLinkTargetLib && ytLinkTargetLib !== 'offline') {
      if (!apiRef.current.isTrackInPlaylist?.(ytLinkTargetLib, trackObj.id)) {
        apiRef.current.toggleTrackInPlaylist?.(ytLinkTargetLib, trackObj);
      }
    }

    setResults(prev => {
      if (prev.some(t => String(t.id) === String(trackObj.id))) return prev;
      return [trackObj, ...prev];
    });

    setYtLinkStage('converting');
    setYtLinkProgress(10);
    let lastErrorInfo = { error: NO_SOURCE_FOUND_ERROR, cause: null };
    let completedTrack = trackObj;

    const ok = await startDownload(trackObj, true, true, {
      forceAlternateSource,
      onProgressUpdate: info => {
        if (info.progress != null) {
          setYtLinkProgress(info.progress);
        }
        if (info.notice) {
          setYtLinkNotice(info.notice);
        }
        if (info.track) {
          completedTrack = info.track;
        }
        if (info.status === 'error') {
          lastErrorInfo = {
            error: info.error || NO_SOURCE_FOUND_ERROR,
            cause: info.cause || null
          };
        }
      }
    });

    if (ok) {
      setYtLinkProgress(100);
      setYtLinkReadyTrack(completedTrack);
      setYtLinkStage('ready');
    } else {
      setYtLinkStage('error');
      const detail = lastErrorInfo.cause
        ? `${lastErrorInfo.error} (${lastErrorInfo.cause})`
        : lastErrorInfo.error || NO_SOURCE_FOUND_ERROR;
      setYtLinkError(detail);
    }
  }

  async function handleYtLinkSubmit(e) {
    e.preventDefault();
    if (ytLinkStage === 'converting' || ytLinkLoading) return;
    if (ytLinkStage === 'ready' && ytLinkReadyTrack) {
      const readyTrack = ytLinkReadyTrack;
      closeYtLinkModal();
      apiRef.current.playFromList?.([readyTrack], 0);
      return;
    }
    await runDirectLinkDownload(false);
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
                    apiRef.current.updateTrackMetadataAcrossLibraries?.(resolvedUploadId, {
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
    apiRef.current.updateTrackFileAcrossLibraries?.(track.id, null, null);

    const nextOffline = offlineCatalog.filter(
      t =>
        String(t.id) !== String(track.id) &&
        (!streamUrl || t.streamUrl !== streamUrl) &&
        (!filename || t.filename !== filename)
    );
    apiRef.current.persistOfflineCatalog?.(nextOffline);
    await refreshOfflineCacheList();
  }

  async function deleteServerFile(filename) {
    try {
      const res = await fetch(`/api/library?file=${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setLibraryFiles(prev => prev.filter(f => f.filename !== filename));
        if (user?.is_admin) apiRef.current.fetchAdminData?.();
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
        apiRef.current.scheduleCollectionsSync?.();
      }

      const ownTracksMissingCovers = serverTracks
        .filter(st => !unlikedSet.has(String(st.id)) && isPlaceholderCover(st.artwork))
        .map(st => ({ ...st, source: 'own', uploadId: st.id }));
      if (ownTracksMissingCovers.length > 0) {
        apiRef.current.syncMissingCoversForList?.(ownTracksMissingCovers, false);
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
      apiRef.current.updateTrackMetadataAcrossLibraries?.(track.id, { fileDeleted: true });
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

        apiRef.current.scheduleCollectionsSync?.();

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
        apiRef.current.syncMissingCoversForList?.(uploadedMissingCover, false);
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

  async function startDownload(
    track,
    waitUntilFinished = false,
    forceRetry = false,
    options = {}
  ) {
    const { forceAlternateSource = false, onProgressUpdate = null } = options || {};
    const key = track.id || track.title;
    if (downloads[key]?.status === 'downloading' && !forceRetry) return false;

    const startedAt = Date.now();
    const isManual = !waitUntilFinished;

    setDownloads(prev => ({
      ...prev,
      [key]: {
        status: 'downloading',
        stage: 'analyzing',
        notice: null,
        error: null,
        cause: null,
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
          forceAlternateSource,
          priority: isManual,
          query: track.sourceUrl || `${track.title} ${track.artist || ''}`.trim()
        })
      });
      const data = await res.json();
      if (!res.ok || !data.downloadId) {
        const errMsg = data.error || NO_SOURCE_FOUND_ERROR;
        setDownloads(prev => ({
          ...prev,
          [key]: { status: 'error', stage: 'error', error: errMsg, cause: null }
        }));
        onProgressUpdate?.({ status: 'error', stage: 'error', error: errMsg, cause: null });
        return false;
      }

      const dlId = data.downloadId;
      const initialNotice = data.notice || null;
      setDownloads(prev => ({
        ...prev,
        [key]: {
          status: 'downloading',
          stage: 'analyzing',
          notice: initialNotice,
          error: null,
          cause: null,
          progress: 8,
          startedAt,
          isManual,
          downloadId: dlId,
          managedByQueue: Boolean(waitUntilFinished),
          trackMeta: track
        }
      }));
      onProgressUpdate?.({
        status: 'downloading',
        stage: 'analyzing',
        progress: 8,
        notice: initialNotice
      });

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
              setDownloads(prev => ({
                ...prev,
                [key]: { status: 'error', stage: 'error', error: NO_SOURCE_FOUND_ERROR }
              }));
              onProgressUpdate?.({
                status: 'error',
                stage: 'error',
                error: NO_SOURCE_FOUND_ERROR,
                cause: null
              });
              return false;
            }
            if (!checkRes.ok) continue;
            const checkData = await checkRes.json();
            if (checkData.status === 'ready' && checkData.filename) {
              const streamUrl = `/api/stream?file=${encodeURIComponent(checkData.filename)}`;
              const isGenericTitle =
                !track.title ||
                /^youtube\s*\(/i.test(String(track.title)) ||
                String(track.title) === 'Pista de SoundCloud';
              const isGenericArtist =
                !track.artist ||
                ['youtube', 'soundcloud'].includes(String(track.artist).toLowerCase());
              const resolvedTitle =
                (isGenericTitle && checkData.title ? checkData.title : track.title) ||
                checkData.title ||
                'Canción';
              const resolvedArtist =
                (isGenericArtist && checkData.artist ? checkData.artist : track.artist) ||
                checkData.artist ||
                'Audio MP3';
              const resolvedArtwork = track.artwork || checkData.artwork || DEFAULT_TRACK_COVER;
              const resolvedTrack = {
                ...track,
                id: track.id || `offline_${checkData.filename}`,
                title: resolvedTitle,
                artist: resolvedArtist,
                artwork: resolvedArtwork,
                filename: checkData.filename,
                streamUrl
              };
              const savedOk = await saveUrlToOfflineCache(streamUrl, resolvedTrack);
              if (!savedOk) {
                const saveErr = 'No se pudo guardar el audio en la memoria del dispositivo.';
                setDownloads(prev => ({
                  ...prev,
                  [key]: { status: 'error', stage: 'error', error: saveErr }
                }));
                onProgressUpdate?.({ status: 'error', stage: 'error', error: saveErr, cause: null });
                return false;
              }
              setDownloads(prev => ({
                ...prev,
                [key]: {
                  ...prev[key],
                  ...checkData,
                  status: 'ready',
                  stage: 'ready',
                  progress: 100
                }
              }));
              onProgressUpdate?.({
                status: 'ready',
                stage: 'ready',
                progress: 100,
                notice: checkData.notice || null,
                track: resolvedTrack
              });
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
              apiRef.current.updateTrackFileAcrossLibraries?.(key, checkData.filename, streamUrl);
              if (isGenericTitle || isGenericArtist) {
                apiRef.current.updateTrackMetadataAcrossLibraries?.(key, {
                  title: resolvedTitle,
                  artist: resolvedArtist,
                  artwork: resolvedArtwork
                });
              }
              fetchLibraryFiles();
              if (user?.is_admin) apiRef.current.fetchAdminData?.();
              return true;
            }
            if (checkData.status === 'error') {
              const errMsg = checkData.error || NO_SOURCE_FOUND_ERROR;
              setDownloads(prev => ({
                ...prev,
                [key]: {
                  status: 'error',
                  stage: 'error',
                  error: errMsg,
                  cause: checkData.cause || null,
                  notice: checkData.notice || null
                }
              }));
              onProgressUpdate?.({
                status: 'error',
                stage: 'error',
                error: errMsg,
                cause: checkData.cause || null,
                notice: checkData.notice || null
              });
              return false;
            }
            const nextProg = checkData.progress || 8;
            const nextStage = checkData.stage || 'converting';
            const nextNotice = checkData.notice || null;
            setDownloads(prev => ({
              ...prev,
              [key]: {
                ...prev[key],
                stage: nextStage,
                notice: nextNotice || prev[key]?.notice || null,
                progress: Math.max(prev[key]?.progress || 8, nextProg)
              }
            }));
            onProgressUpdate?.({
              status: 'downloading',
              stage: nextStage,
              progress: nextProg,
              notice: nextNotice
            });
          } catch {
            // Transient mobile network handoff: keep polling until timeout
          }
        }
        setDownloads(prev => ({
          ...prev,
          [key]: {
            status: 'error',
            stage: 'error',
            error: NO_SOURCE_FOUND_ERROR,
            cause: 'Tiempo de espera agotado'
          }
        }));
        onProgressUpdate?.({
          status: 'error',
          stage: 'error',
          error: NO_SOURCE_FOUND_ERROR,
          cause: 'Tiempo de espera agotado'
        });
        return false;
      };

      if (!waitUntilFinished) {
        pollToFinish().catch(() => {});
        return true;
      }

      return await pollToFinish();
    } catch {
      setDownloads(prev => ({
        ...prev,
        [key]: { status: 'error', stage: 'error', error: NO_SOURCE_FOUND_ERROR }
      }));
      onProgressUpdate?.({
        status: 'error',
        stage: 'error',
        error: NO_SOURCE_FOUND_ERROR,
        cause: null
      });
      return false;
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

  const activeDownloadEntries = Object.entries(downloads)
    .filter(([, d]) => d && d.status === 'downloading')
    .sort(([, a], [, b]) => {
      if (Boolean(a.isManual) !== Boolean(b.isManual)) {
        return a.isManual ? -1 : 1;
      }
      return (a.startedAt || 0) - (b.startedAt || 0);
    });

  const exposed = {
    openYtLinkModal,
    closeYtLinkModal,
    resolveYtLinkPreview,
    runDirectLinkDownload,
    handleYtLinkSubmit,
    refreshOfflineCacheList,
    exportTrackFile,
    deleteOfflineTrack,
    deleteServerFile,
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
  };

  if (apiRef) {
    Object.assign(apiRef.current, exposed);
  }

  return exposed;
}
