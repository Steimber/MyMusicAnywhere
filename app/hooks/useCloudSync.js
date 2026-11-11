import { useEffect } from 'react';
import { mergeCollectionsSnapshots, normalizeTombstoneList } from '../../lib/collections-merge';
import {
  HOUR_BUCKETS,
  applyListeningDeltaToMap,
  mergeListeningEntries,
  normalizeListeningEntry
} from '../../lib/listening-shared';
import { readListeningStateFromIdb, writeListeningStateToIdb } from '../../lib/listening-idb';
import {
  LIKES_STORAGE_KEY,
  DELETED_LIKES_STORAGE_KEY,
  PLAYLISTS_STORAGE_KEY,
  DELETED_PLAYLISTS_STORAGE_KEY,
  SYNCED_UID_STORAGE_KEY,
  COLLECTIONS_DIRTY_KEY,
  COLLECTIONS_VERSION_KEY_PREFIX,
  MAX_COLLECTION_SYNC_RETRIES,
  DEFAULT_TRACK_COVER,
  isPlaceholderCover,
  compressArtworkUrl,
  getTrackDedupKey,
  deduplicateTracksList,
  sanitizeLikedTracksList
} from './trackUtils';

export function useCloudSync({
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
}) {
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
  }, [pendingSpotifyImport, spotifyDialogRef]);

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

  async function handleExportUserData() {
    setBackupMsg({ type: '', text: '' });
    if (isOffline || user?.offline) {
      setBackupMsg({
        type: 'err',
        text: 'Conéctate a internet para exportar todos tus datos desde el servidor.'
      });
      return;
    }
    try {
      await Promise.allSettled([pushCollectionsToServerNow(), pushListeningHistoryNow()]);
      const res = await fetch('/api/export', { cache: 'no-store' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setBackupMsg({
          type: 'err',
          text: errData.error || 'No se pudieron exportar tus datos.'
        });
        return;
      }
      const disposition = res.headers.get('content-disposition') || '';
      const nameMatch = disposition.match(/filename="?([^";]+)"?/i);
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = nameMatch ? nameMatch[1] : `mymusic-datos-${stamp}.json`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1200);
      setBackupMsg({
        type: 'ok',
        text: 'Datos exportados correctamente (favoritos, playlists e historial de escucha).'
      });
    } catch {
      setBackupMsg({
        type: 'err',
        text: 'No se pudieron exportar tus datos. Verifica tu conexión.'
      });
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
        apiRef.current.syncMissingCoversForList?.(allImported, false);
      }
    } catch {
      setBackupMsg({
        type: 'err',
        text: 'No se pudo leer el respaldo. Verifica que sea un archivo JSON válido.'
      });
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
      apiRef.current.persistLikes?.([...filtered, ...likedTracks]);
      setSelectedLibrary('liked');
      setSpotifyMsg({
        type: 'ok',
        text: `Listo: se guardaron ${filtered.length} canciones nuevas en Favoritos (${freshTracks.length - filtered.length} duplicadas omitidas).`
      });
      closeSpotifyImportModal();
      if (filtered.some(t => isPlaceholderCover(t?.artwork))) {
        apiRef.current.syncMissingCoversForList?.(filtered, false);
      }
      return;
    }

    if (targetType === 'new_playlist') {
      const created = apiRef.current.createCustomPlaylist?.(fallbackName, freshTracks);
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
      apiRef.current.persistCustomPlaylists?.(next);
      setSelectedLibrary(targetPl.id);
      setSpotifyMsg({
        type: 'ok',
        text: `Listo: se guardaron ${filtered.length} canciones nuevas en «${targetPl.name}» (${freshTracks.length - filtered.length} duplicadas omitidas).`
      });
      closeSpotifyImportModal();
      if (filtered.some(t => isPlaceholderCover(t?.artwork))) {
        apiRef.current.syncMissingCoversForList?.(filtered, false);
      }
    }
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

  const exposed = {
    ensurePersistentStorage,
    persistDeletedLikes,
    persistDeletedPlaylists,
    pushCollectionsToServerNow,
    scheduleCollectionsSync,
    reconcileCollectionsOnAppReturn,
    syncCollectionsWithServer,
    pushListeningHistoryNow,
    hydrateAndSyncListeningHistory,
    recordListeningDeltaSync,
    handleExportBackupJson,
    handleExportUserData,
    handleImportBackupJson,
    handleSpotifyCsvFile,
    openSpotifyImportModal,
    closeSpotifyImportModal,
    confirmSpotifyImport,
    handleSpotifyUrlSubmit,
    fetchAdminData,
    handleCreateInvite,
    handleAdminAction,
    copyInviteCode,
    saveYtCookiesContent,
    handleClearYtCookies
  };

  if (apiRef) {
    Object.assign(apiRef.current, exposed);
  }

  return exposed;
}
