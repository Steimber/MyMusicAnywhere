'use client';

import { useState } from 'react';

const FALLBACK_COVER = '/icon.svg?v=3';

export default function ForYouPanel({
  playlists = [],
  coldStart = false,
  coldStartMessage = '',
  totalPlays = 0,
  isOffline = false,
  isRefreshing = false,
  savedFeedbackMap = {},
  currentTrackId = null,
  isPlaying = false,
  compressArtworkUrl,
  isTrackAvailableOffline,
  onRefresh,
  onPlayPlaylist,
  onSaveAsPlaylist,
  onSelectTrack,
  Icon
}) {
  const [expandedId, setExpandedId] = useState(null);

  const resolveCover = raw => {
    if (typeof compressArtworkUrl === 'function') {
      return compressArtworkUrl(raw);
    }
    return raw || FALLBACK_COVER;
  };

  return (
    <section className="foryou-section" aria-labelledby="foryou-heading">
      <div className="section-bar foryou-header-bar">
        <div>
          <h1 id="foryou-heading" className="section-bar-title">
            Para ti
          </h1>
          <p className="section-bar-sub">
            {isOffline
              ? 'Playlists generadas en tu dispositivo con la música disponible sin conexión.'
              : 'Selecciones diarias calculadas en tu dispositivo según lo que escuchas.'}
          </p>
        </div>

        <button
          type="button"
          className="btn secondary sm foryou-refresh-btn"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          <Icon name={isRefreshing ? 'loader' : 'refresh'} size={14} />
          <span>{isRefreshing ? 'Actualizando…' : 'Actualizar'}</span>
        </button>
      </div>

      {coldStart && coldStartMessage && (
        <div className="foryou-notice" role="status">
          <p className="foryou-notice-text">{coldStartMessage}</p>
          <span className="foryou-notice-meta tabular-nums">
            {totalPlays} / 20 reproducciones
          </span>
        </div>
      )}

      {playlists.length === 0 ? (
        <div className="empty foryou-empty">
          <h2 className="foryou-empty-title">Todavía no hay canciones suficientes</h2>
          <p className="foryou-empty-sub">
            {isOffline
              ? 'Descarga canciones en tu teléfono para armar mezclas automáticas sin conexión.'
              : 'Guarda algunas canciones en Favoritos o explora artistas para empezar.'}
          </p>
        </div>
      ) : (
        <div className="foryou-grid">
          {playlists.map(playlist => {
            const isSaved = Boolean(savedFeedbackMap[playlist.id]);
            const isExpanded = expandedId === playlist.id;
            const offlineReadyCount = Array.isArray(playlist.tracks)
              ? playlist.tracks.filter(t =>
                  typeof isTrackAvailableOffline === 'function' ? isTrackAvailableOffline(t) : true
                ).length
              : 0;
            const mosaic = Array.isArray(playlist.mosaicCovers)
              ? playlist.mosaicCovers.slice(0, 4)
              : [FALLBACK_COVER, FALLBACK_COVER, FALLBACK_COVER, FALLBACK_COVER];

            return (
              <article
                key={playlist.id}
                className={`foryou-card ${isExpanded ? 'is-expanded' : ''}`.trim()}
              >
                <div className="media foryou-mosaic" aria-hidden="true">
                  {mosaic.map((coverUrl, idx) => (
                    <img
                      key={`${playlist.id}_cov_${idx}`}
                      src={resolveCover(coverUrl)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={e => {
                        if (e.currentTarget.src && !e.currentTarget.src.endsWith(FALLBACK_COVER)) {
                          e.currentTarget.src = FALLBACK_COVER;
                        }
                      }}
                    />
                  ))}
                </div>

                <header className="foryou-card-head">
                  <h2 className="foryou-card-title">{playlist.title}</h2>
                  <div className="foryou-card-meta tabular-nums">
                    <span>
                      {playlist.trackCount}{' '}
                      {playlist.trackCount === 1 ? 'canción' : 'canciones'}
                    </span>
                    {!isOffline && offlineReadyCount > 0 && offlineReadyCount < playlist.trackCount && (
                      <span className="foryou-card-offline-count">
                        · {offlineReadyCount} en teléfono
                      </span>
                    )}
                  </div>
                </header>

                {isExpanded ? (
                  <div className="foryou-card-content">
                    <p className="foryou-reason">{playlist.reason}</p>
                    <ul className="foryou-track-preview">
                      {playlist.tracks.map((track, idx) => {
                        const active =
                          currentTrackId != null && String(currentTrackId) === String(track.id);
                        const available =
                          typeof isTrackAvailableOffline === 'function'
                            ? isTrackAvailableOffline(track)
                            : true;
                        return (
                          <li key={`${playlist.id}_${track.id}_${idx}`}>
                            <button
                              type="button"
                              className={`foryou-preview-row ${active ? 'active' : ''}`.trim()}
                              onClick={() => onSelectTrack?.(track, playlist.tracks, idx)}
                            >
                              <span className="foryou-preview-num tabular-nums">{idx + 1}</span>
                              <span className="foryou-preview-main">
                                <span className="foryou-preview-title">{track.title}</span>
                                <span className="foryou-preview-artist">{track.artist}</span>
                              </span>
                              <span className="foryou-preview-state">
                                {active && isPlaying ? (
                                  <Icon name="pause" size={13} />
                                ) : available ? (
                                  <Icon name="offline-pin" size={14} />
                                ) : (
                                  <Icon name="download" size={13} />
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : (
                  <p className="foryou-reason">{playlist.reason}</p>
                )}

                <footer className="foryou-actions">
                  <div className="foryou-primary-btns">
                    <button
                      type="button"
                      className="btn clay sm"
                      onClick={() => onPlayPlaylist(playlist, false)}
                    >
                      <Icon name="play" size={13} />
                      <span>Reproducir</span>
                    </button>

                    <button
                      type="button"
                      className="btn secondary sm"
                      onClick={() => onPlayPlaylist(playlist, true)}
                    >
                      <Icon name="shuffle" size={13} />
                      <span>Aleatorio</span>
                    </button>
                  </div>

                  <div className="foryou-secondary-btns">
                    <button
                      type="button"
                      className={`btn secondary sm foryou-save-btn ${
                        isSaved ? 'is-saved' : ''
                      }`.trim()}
                      onClick={() => onSaveAsPlaylist(playlist)}
                    >
                      <Icon name={isSaved ? 'check' : 'plus'} size={13} />
                      <span>{isSaved ? 'Guardada en Biblioteca' : 'Guardar como playlist'}</span>
                    </button>

                    <button
                      type="button"
                      className="foryou-toggle-tracks"
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpandedId(prev => (prev === playlist.id ? null : playlist.id))
                      }
                    >
                      {isExpanded ? 'Ocultar lista' : 'Ver canciones'}
                    </button>
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
