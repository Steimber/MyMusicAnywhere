'use client';

import { Icon } from './Icons';
import {
  DEFAULT_TRACK_COVER,
  MAX_SIMULTANEOUS_DOWNLOADS,
  getTrackDedupKey,
  isPlaceholderCover
} from '../hooks/trackUtils';
import { NO_SOURCE_FOUND_ERROR } from '../../lib/download/youtube-status';

export function SimultaneousDownloadsBanner({
  activeDownloadEntries,
  syncingAll,
  syncProgress
}) {
  const totalActiveDownloads = activeDownloadEntries.length;
  if (totalActiveDownloads === 0) return null;
  const simultaneousActiveCount = Math.min(
    MAX_SIMULTANEOUS_DOWNLOADS,
    totalActiveDownloads
  );
  const queuedWaitingCount = Math.max(
    0,
    totalActiveDownloads - MAX_SIMULTANEOUS_DOWNLOADS
  );
  const activeSlots = activeDownloadEntries.slice(0, MAX_SIMULTANEOUS_DOWNLOADS);
  const activeNotice =
    activeDownloadEntries.map(([, d]) => d?.notice).find(Boolean) || null;
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
      {activeNotice && <div className="sim-download-notice">{activeNotice}</div>}
    </div>
  );
}

export function OwnUploadStatusBanner({ ownUploadState, setOwnUploadState }) {
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

export function TrackSkeletons({ count = 8 }) {
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

export default function TrackRow({
  track,
  idx,
  list,
  contextLib = null,
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
}) {
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
            <span className={`track-sub-text ${dl?.status === 'error' ? 'is-error-text' : ''}`.trim()}>
              {dl?.status === 'downloading'
                ? isQueuedForSlot
                  ? `En cola · ${track.artist}`
                  : `${Math.round(dl.progress || 8)}% · ${dl.notice || track.artist}`
                : dl?.status === 'error'
                ? `${dl.error || NO_SOURCE_FOUND_ERROR}${dl.cause ? ` (${dl.cause})` : ''}`
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
        ) : dl?.status === 'error' && track.source !== 'own' ? (
          <button
            type="button"
            className="btn secondary sm retry-alt-btn"
            disabled={isOffline}
            onClick={() => startDownload(track, false, true, { forceAlternateSource: true })}
            title="Reintentar con otra fuente"
          >
            <Icon name="refresh" size={13} />
            <span>Reintentar con otra fuente</span>
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
