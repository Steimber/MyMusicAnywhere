'use client';

import { Icon } from './Icons';
import TrackRow, {
  OwnUploadStatusBanner,
  SimultaneousDownloadsBanner,
  TrackSkeletons
} from './TrackRow';
import { EXPLORE_CHIPS, OWN_AUDIO_ACCEPT } from '../hooks/trackUtils';
import { classifyDirectLinkSource } from '../../lib/download/youtube-status';

export default function ExploreSection({
  isOffline,
  query,
  setQuery,
  loading,
  openYtLinkModal,
  activeChip,
  setActiveChip,
  searchTracks,
  loadRecommendedOrRandomFeed,
  likedTracks,
  customPlaylistsCount,
  topFrequentArtists,
  feedInfo,
  results,
  ownUploadState,
  setOwnUploadState,
  ownUploadInputExpRef,
  handleOwnAudioUpload,
  activeDownloadEntries,
  syncingAll,
  syncProgress,
  trackRowSharedProps
}) {
  return (
    <section className="tab-section">
      <div className="sticky-top-zone">
        <div className="sticky-top-inner">
          <form
            className={`search-bar ${isOffline ? 'offline-section-disabled' : ''}`.trim()}
            onSubmit={e => {
              e.preventDefault();
              const trimmed = query.trim();
              if (!isOffline && trimmed) {
                if (classifyDirectLinkSource(trimmed).isUrl) {
                  setQuery('');
                  openYtLinkModal('offline', trimmed);
                  return;
                }
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
                  : '¿Qué querés escuchar hoy? Canción, artista o enlace…'
              }
              value={query}
              onChange={e => setQuery(e.target.value)}
              onPaste={e => {
                if (isOffline) return;
                const pasted = e.clipboardData?.getData('text')?.trim() || '';
                if (!query.trim() && classifyDirectLinkSource(pasted).isUrl) {
                  e.preventDefault();
                  openYtLinkModal('offline', pasted);
                }
              }}
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
              title="Pegar enlace directo de YouTube o SoundCloud"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}
            >
              <Icon name="link" size={15} />
              <span>Enlace</span>
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

          <div className="section-bar">
            <div>
              <h1 className="section-bar-title">
                {feedInfo.mode === 'search'
                  ? `Resultados para «${feedInfo.label}»`
                  : feedInfo.mode === 'genre' || feedInfo.mode === 'artist'
                  ? feedInfo.label
                  : likedTracks.length > 0 || customPlaylistsCount > 0
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

      {loading ? (
        <div className="track-list" aria-busy="true" aria-label="Cargando canciones">
          <TrackSkeletons count={8} />
        </div>
      ) : results.length === 0 ? (
        <div className="empty">
          <div className="empty-title">Sin resultados por ahora</div>
          <p>Probá buscando otro artista o tocá actualizar.</p>
        </div>
      ) : (
        <div className="track-list">
          {results.map((track, idx) => (
            <TrackRow
              key={`exp_${track.id}_${idx}`}
              track={track}
              idx={idx}
              list={results}
              contextLib={null}
              {...trackRowSharedProps}
            />
          ))}
        </div>
      )}
    </section>
  );
}
