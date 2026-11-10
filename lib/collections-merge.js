/**
 * Pure conflict-free merge utilities for MyMusicAnywhere user collections
 * (Favorites + Custom Playlists with per-item updatedAt and deletion tombstones).
 */

export function normalizeTombstoneList(raw) {
  const byId = new Map();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id ?? '').trim();
      const deletedAt = Number(entry.deletedAt);
      if (!id || !Number.isFinite(deletedAt) || deletedAt <= 0) continue;
      const prev = byId.get(id) || 0;
      if (deletedAt > prev) byId.set(id, Math.round(deletedAt));
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const id = String(k || '').trim();
      const deletedAt = Number(typeof v === 'object' ? v?.deletedAt : v);
      if (!id || !Number.isFinite(deletedAt) || deletedAt <= 0) continue;
      const prev = byId.get(id) || 0;
      if (deletedAt > prev) byId.set(id, Math.round(deletedAt));
    }
  }
  return Array.from(byId.entries())
    .map(([id, deletedAt]) => ({ id, deletedAt }))
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, 3000);
}

export function getItemTimestamp(item, fallbackField = 'addedAt') {
  if (!item || typeof item !== 'object') return 0;
  const upd = Number(item.updatedAt);
  if (Number.isFinite(upd) && upd > 0) return Math.round(upd);
  const fb = Number(item[fallbackField]);
  if (Number.isFinite(fb) && fb > 0) return Math.round(fb);
  return 0;
}

function mergeTwoTrackVersions(localTrack, serverTrack) {
  if (!localTrack) return { ...serverTrack };
  if (!serverTrack) return { ...localTrack };

  const localTs = getItemTimestamp(localTrack, 'addedAt');
  const serverTs = getItemTimestamp(serverTrack, 'addedAt');
  const winner = localTs >= serverTs ? localTrack : serverTrack;
  const loser = localTs >= serverTs ? serverTrack : localTrack;

  return {
    ...loser,
    ...winner,
    filename: winner.filename || loser.filename || null,
    streamUrl: winner.streamUrl || loser.streamUrl || null,
    uploadId: winner.uploadId || loser.uploadId || null,
    updatedAt: Math.max(localTs, serverTs) || Date.now()
  };
}

export function mergeTrackListsWithOrder(
  localTracks = [],
  serverTracks = [],
  localDeleted = [],
  serverDeleted = []
) {
  const tombstones = new Map();
  for (const t of normalizeTombstoneList(localDeleted)) {
    tombstones.set(t.id, Math.max(tombstones.get(t.id) || 0, t.deletedAt));
  }
  for (const t of normalizeTombstoneList(serverDeleted)) {
    tombstones.set(t.id, Math.max(tombstones.get(t.id) || 0, t.deletedAt));
  }

  // Also absorb inline deletedAt markers if any caller passed them inside track arrays
  for (const tr of [...(localTracks || []), ...(serverTracks || [])]) {
    if (tr && tr.id !== undefined && Number(tr.deletedAt) > 0 && tr._tombstone) {
      const id = String(tr.id).trim();
      tombstones.set(id, Math.max(tombstones.get(id) || 0, Math.round(Number(tr.deletedAt))));
    }
  }

  const serverById = new Map();
  for (const st of serverTracks || []) {
    if (!st || st.id === undefined || st.id === null || st._tombstone) continue;
    const id = String(st.id).trim();
    if (!id) continue;
    const existing = serverById.get(id);
    serverById.set(id, existing ? mergeTwoTrackVersions(st, existing) : st);
  }

  const mergedTracks = [];
  const placedIds = new Set();

  // 1. Respect local order first
  for (const lt of localTracks || []) {
    if (!lt || lt.id === undefined || lt.id === null || lt._tombstone) continue;
    const id = String(lt.id).trim();
    if (!id || placedIds.has(id)) continue;

    const st = serverById.get(id) || null;
    const combined = mergeTwoTrackVersions(lt, st);
    const itemTs = getItemTimestamp(combined, 'addedAt');
    const delTs = tombstones.get(id) || 0;

    if (delTs > 0 && delTs >= itemTs) {
      placedIds.add(id);
      continue;
    }
    if (delTs > 0 && itemTs > delTs) {
      tombstones.delete(id);
    }

    mergedTracks.push(combined);
    placedIds.add(id);
  }

  // 2. Append server-only tracks at the end
  for (const st of serverTracks || []) {
    if (!st || st.id === undefined || st.id === null || st._tombstone) continue;
    const id = String(st.id).trim();
    if (!id || placedIds.has(id)) continue;

    const candidate = serverById.get(id) || st;
    const itemTs = getItemTimestamp(candidate, 'addedAt');
    const delTs = tombstones.get(id) || 0;

    if (delTs > 0 && delTs >= itemTs) {
      placedIds.add(id);
      continue;
    }
    if (delTs > 0 && itemTs > delTs) {
      tombstones.delete(id);
    }

    mergedTracks.push({ ...candidate });
    placedIds.add(id);
  }

  const mergedDeleted = Array.from(tombstones.entries())
    .map(([id, deletedAt]) => ({ id, deletedAt }))
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, 3000);

  return {
    tracks: mergedTracks,
    deleted: mergedDeleted
  };
}

export function mergeCollectionsSnapshots(localSnap = {}, serverSnap = {}) {
  const favMerge = mergeTrackListsWithOrder(
    localSnap.likedTracks || [],
    serverSnap.likedTracks || [],
    localSnap.deletedLikes || [],
    serverSnap.deletedLikes || []
  );

  const playlistTombstones = new Map();
  for (const p of normalizeTombstoneList(localSnap.deletedPlaylists)) {
    playlistTombstones.set(p.id, Math.max(playlistTombstones.get(p.id) || 0, p.deletedAt));
  }
  for (const p of normalizeTombstoneList(serverSnap.deletedPlaylists)) {
    playlistTombstones.set(p.id, Math.max(playlistTombstones.get(p.id) || 0, p.deletedAt));
  }

  const serverPlById = new Map();
  for (const sp of serverSnap.customPlaylists || []) {
    if (!sp || !sp.id) continue;
    serverPlById.set(String(sp.id).trim(), sp);
  }

  const mergedPlaylists = [];
  const placedPlIds = new Set();

  const mergeSinglePlaylist = (localPl, serverPl) => {
    const base = !localPl
      ? serverPl
      : !serverPl
      ? localPl
      : getItemTimestamp(localPl, 'createdAt') >= getItemTimestamp(serverPl, 'createdAt')
      ? localPl
      : serverPl;

    const plUpdatedAt = Math.max(
      getItemTimestamp(localPl, 'createdAt'),
      getItemTimestamp(serverPl, 'createdAt')
    );

    const trackMerge = mergeTrackListsWithOrder(
      localPl?.tracks || [],
      serverPl?.tracks || [],
      localPl?.deletedTracks || [],
      serverPl?.deletedTracks || []
    );

    return {
      id: String(base.id).trim(),
      name: String(base.name || 'Playlist').trim(),
      createdAt:
        Math.min(
          Number(localPl?.createdAt) || Infinity,
          Number(serverPl?.createdAt) || Infinity
        ) === Infinity
          ? Date.now()
          : Math.min(
              Number(localPl?.createdAt) || Infinity,
              Number(serverPl?.createdAt) || Infinity
            ),
      updatedAt: plUpdatedAt || Date.now(),
      tracks: trackMerge.tracks,
      deletedTracks: trackMerge.deleted
    };
  };

  for (const lp of localSnap.customPlaylists || []) {
    if (!lp || !lp.id) continue;
    const id = String(lp.id).trim();
    if (!id || placedPlIds.has(id)) continue;

    const sp = serverPlById.get(id) || null;
    const combinedPl = mergeSinglePlaylist(lp, sp);
    const delTs = playlistTombstones.get(id) || 0;
    if (delTs > 0 && delTs >= combinedPl.updatedAt) {
      placedPlIds.add(id);
      continue;
    }
    if (delTs > 0 && combinedPl.updatedAt > delTs) {
      playlistTombstones.delete(id);
    }

    mergedPlaylists.push(combinedPl);
    placedPlIds.add(id);
  }

  for (const sp of serverSnap.customPlaylists || []) {
    if (!sp || !sp.id) continue;
    const id = String(sp.id).trim();
    if (!id || placedPlIds.has(id)) continue;

    const combinedPl = mergeSinglePlaylist(null, sp);
    const delTs = playlistTombstones.get(id) || 0;
    if (delTs > 0 && delTs >= combinedPl.updatedAt) {
      placedPlIds.add(id);
      continue;
    }
    if (delTs > 0 && combinedPl.updatedAt > delTs) {
      playlistTombstones.delete(id);
    }

    mergedPlaylists.push(combinedPl);
    placedPlIds.add(id);
  }

  const mergedDeletedPlaylists = Array.from(playlistTombstones.entries())
    .map(([id, deletedAt]) => ({ id, deletedAt }))
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, 500);

  return {
    likedTracks: favMerge.tracks,
    deletedLikes: favMerge.deleted,
    customPlaylists: mergedPlaylists,
    deletedPlaylists: mergedDeletedPlaylists
  };
}
