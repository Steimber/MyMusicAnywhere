import { normalizeTombstoneList } from '../../lib/collections-merge';
import {
  LIKES_STORAGE_KEY,
  OFFLINE_CATALOG_KEY,
  PLAYLISTS_STORAGE_KEY,
  UNLIKED_OWN_STORAGE_KEY,
  DEFAULT_TRACK_COVER,
  isPlaceholderCover,
  compressArtworkUrl,
  deduplicateTracksList
} from './trackUtils';

export function usePlaylistsAndLibrary({
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
}) {
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

  function persistLikes(nextLikes) {
    const clean = deduplicateTracksList(nextLikes);
    setLikedTracks(clean);
    likedTracksRef.current = clean;
    try {
      localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(clean));
    } catch {}
    apiRef.current.scheduleCollectionsSync?.();
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
    apiRef.current.scheduleCollectionsSync?.();
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
      apiRef.current.persistDeletedLikes?.([
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
      apiRef.current.persistDeletedLikes?.(
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
    apiRef.current.persistDeletedPlaylists?.([
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

    apiRef.current.deleteOfflineTrack?.(track);

    apiRef.current.persistDeletedLikes?.([{ id: uploadId, deletedAt: now }, ...deletedLikesRef.current]);
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
    apiRef.current.scheduleCollectionsSync?.(true, nextLikes, nextPls);

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
      if (
        menuDialogRef.current &&
        !menuDialogRef.current.open &&
        typeof menuDialogRef.current.showModal === 'function'
      ) {
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
      if (
        saveDialogRef.current &&
        !saveDialogRef.current.open &&
        typeof saveDialogRef.current.showModal === 'function'
      ) {
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
      apiRef.current.scheduleCollectionsSync?.();
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
      apiRef.current.scheduleCollectionsSync?.();
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

  const exposed = {
    resolveOwnUploadId,
    persistOwnUploadMetadataToServer,
    persistLikes,
    persistOfflineCatalog,
    persistCustomPlaylists,
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
  };

  if (apiRef) {
    Object.assign(apiRef.current, exposed);
  }

  return exposed;
}
