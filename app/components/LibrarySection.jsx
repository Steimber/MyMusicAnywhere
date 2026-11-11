'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import TrackRow, {
  OwnUploadStatusBanner,
  SimultaneousDownloadsBanner
} from './TrackRow';
import { OWN_AUDIO_ACCEPT, isPlaceholderCover } from '../hooks/trackUtils';

export default function LibrarySection({
  isOffline,
  selectedLibrary,
  setSelectedLibrary,
  libraryQuery,
  setLibraryQuery,
  likedTracks,
  offlineCatalog,
  customPlaylists,
  creatingPlaylist,
  setCreatingPlaylist,
  newPlaylistName,
  setNewPlaylistName,
  createCustomPlaylist,
  deleteCustomPlaylist,
  openYtLinkModal,
  ownUploadState,
  setOwnUploadState,
  ownUploadInputLibRef,
  handleOwnAudioUpload,
  coverSync,
  deviceQuota,
  isTrackAvailableOffline,
  resolveOwnUploadId,
  shuffle,
  toggleShuffle,
  repeatMode,
  cycleRepeatMode,
  syncMissingCoversForList,
  syncingAll,
  syncProgress,
  downloadCollectionForOffline,
  resolvePlayableSource,
  playFromList,
  activeDownloadEntries,
  trackRowSharedProps
}) {
  const [visibleLibraryCount, setVisibleLibraryCount] = useState(10);
  const libraryLoadMoreRef = useRef(null);

  useEffect(() => {
    setVisibleLibraryCount(10);
  }, [selectedLibrary, libraryQuery]);

  useEffect(() => {
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
  }, [
    selectedLibrary,
    libraryQuery,
    likedTracks.length,
    offlineCatalog.length,
    customPlaylists,
    visibleLibraryCount
  ]);

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

  return (
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
              title="Pegar enlace directo de YouTube o SoundCloud"
            >
              <Icon name="link" size={14} />
              <span>Pegar enlace</span>
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

          <OwnUploadStatusBanner
            ownUploadState={ownUploadState}
            setOwnUploadState={setOwnUploadState}
          />
          <SimultaneousDownloadsBanner
            activeDownloadEntries={activeDownloadEntries}
            syncingAll={syncingAll}
            syncProgress={syncProgress}
          />
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
            .map((track, idx) => (
              <TrackRow
                key={`${selectedLibrary}_${track.id}_${idx}`}
                track={track}
                idx={idx}
                list={activeLibraryTracks}
                contextLib={selectedLibrary}
                {...trackRowSharedProps}
              />
            ))}
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
  );
}
