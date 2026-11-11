'use client';

import { Icon } from './Icons';
import { DEFAULT_TRACK_COVER, isPlaceholderCover } from '../hooks/trackUtils';
import { classifyDirectLinkSource } from '../../lib/download/youtube-status';

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

export default function AppDialogs({
  isOffline,
  menuDialogRef,
  saveDialogRef,
  spotifyDialogRef,
  downloadDialogRef,
  ytDialogRef,
  editDialogRef,
  ownUploadInputLibRef,
  ownUploadInputExpRef,
  menuTrack,
  setMenuTrack,
  closeTrackMenu,
  trackToSave,
  setTrackToSave,
  closeSaveModal,
  modalNewPlaylistName,
  setModalNewPlaylistName,
  pendingSpotifyImport,
  spotifyNewLibName,
  setSpotifyNewLibName,
  closeSpotifyImportModal,
  confirmSpotifyImport,
  downloadPrompt,
  setDownloadPrompt,
  closeDownloadPromptModal,
  ownUploadState,
  setOptimisticTrack,
  ytLinkUrl,
  setYtLinkUrl,
  ytLinkStage,
  setYtLinkStage,
  ytLinkLoading,
  ytLinkProgress,
  ytLinkNotice,
  setYtLinkNotice,
  ytLinkPreview,
  setYtLinkPreview,
  ytLinkError,
  setYtLinkError,
  setYtLinkReadyTrack,
  ytLinkTargetLib,
  setYtLinkTargetLib,
  setYtModalOpen,
  closeYtLinkModal,
  resolveYtLinkPreview,
  runDirectLinkDownload,
  handleYtLinkSubmit,
  editingTrack,
  setEditingTrack,
  editForm,
  setEditForm,
  closeEditTrackModal,
  handleEditTrackSubmit,
  customPlaylists,
  isLiked,
  toggleLike,
  openSaveModal,
  openEditTrackModal,
  isTrackAvailableOffline,
  exportTrackFile,
  deleteOfflineTrack,
  startDownload,
  cacheOwnTrackAndConfirmDelete,
  playFromList,
  removeTrackFromPlaylist,
  isTrackInPlaylist,
  toggleTrackInPlaylist,
  createCustomPlaylist,
  resolveOwnUploadId,
  deleteOwnUploadEverywhere
}) {
  const detectedLink = classifyDirectLinkSource(ytLinkUrl);

  return (
    <>
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

      {/* ==================== DIALOG 5: DIRECT LINK DOWNLOAD MODAL ==================== */}
      <dialog
        ref={ytDialogRef}
        closedby={ytLinkStage === 'converting' ? 'none' : 'any'}
        className="save-dialog"
        aria-labelledby="yt-dialog-title"
        onClose={() => setYtModalOpen(false)}
        onClick={e => {
          if (ytLinkStage === 'converting') return;
          handleDialogBackdropClick(e, closeYtLinkModal);
        }}
      >
        <div>
          <div className="dialog-head">
            <div style={{ minWidth: 0 }}>
              <h2
                id="yt-dialog-title"
                className="dialog-title"
                style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 7 }}
              >
                <Icon name="link" size={17} />
                <span>Descargar desde enlace</span>
              </h2>
              <div className="dialog-sub">
                Pega un enlace de YouTube o SoundCloud para ver la vista previa antes de bajar
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={closeYtLinkModal}
              aria-label="Cerrar ventana de enlace"
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <form onSubmit={handleYtLinkSubmit}>
            <label htmlFor="direct-link-input" className="visually-hidden">
              Enlace directo de YouTube o SoundCloud
            </label>
            <div className="search-bar" style={{ marginBottom: 10 }}>
              <Icon name="link" size={16} className="search-icon" />
              <input
                id="direct-link-input"
                name="directUrl"
                type="url"
                className="search-input"
                placeholder="Pega aquí el enlace (YouTube o SoundCloud)…"
                value={ytLinkUrl}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={ytLinkStage === 'converting'}
                onChange={e => {
                  const val = e.target.value;
                  setYtLinkUrl(val);
                  resolveYtLinkPreview(val);
                }}
                autoFocus
                required
              />
              {detectedLink.isUrl && (
                <span
                  className={`badge ${
                    detectedLink.source === 'other' ? 'coral' : 'lime'
                  }`}
                  style={{ flexShrink: 0 }}
                >
                  {detectedLink.label}
                </span>
              )}
              {ytLinkUrl && ytLinkStage !== 'converting' && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    setYtLinkUrl('');
                    setYtLinkPreview(null);
                    setYtLinkError('');
                    setYtLinkNotice('');
                    setYtLinkReadyTrack(null);
                    setYtLinkStage('idle');
                  }}
                  aria-label="Limpiar enlace"
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>

            {(ytLinkStage === 'analyzing' ||
              ytLinkStage === 'converting' ||
              ytLinkStage === 'ready') && (
              <div className="link-flow-status" role="status" aria-live="polite">
                <div className="link-flow-steps">
                  <span
                    className={`link-step-pill ${
                      ytLinkStage === 'analyzing' ? 'active' : 'done'
                    }`}
                  >
                    {ytLinkStage === 'analyzing' && (
                      <Icon name="loader" size={12} className="spin" />
                    )}
                    <span>Analizando</span>
                  </span>
                  <span
                    className={`link-step-pill ${
                      ytLinkStage === 'converting'
                        ? 'active'
                        : ytLinkStage === 'ready'
                        ? 'done'
                        : ''
                    }`.trim()}
                  >
                    {ytLinkStage === 'converting' && (
                      <Icon name="loader" size={12} className="spin" />
                    )}
                    <span>
                      {ytLinkStage === 'converting'
                        ? `Convirtiendo · ${Math.round(ytLinkProgress || 10)}%`
                        : 'Convirtiendo'}
                    </span>
                  </span>
                  <span
                    className={`link-step-pill ${ytLinkStage === 'ready' ? 'ready' : ''}`.trim()}
                  >
                    {ytLinkStage === 'ready' && <Icon name="check" size={12} />}
                    <span>Listo</span>
                  </span>
                </div>

                {ytLinkStage === 'converting' && (
                  <div className="link-flow-progress">
                    <div style={{ width: `${Math.max(8, Math.round(ytLinkProgress || 10))}%` }} />
                  </div>
                )}

                {ytLinkNotice && <div className="link-flow-notice">{ytLinkNotice}</div>}
              </div>
            )}

            {ytLinkPreview && (
              <div className="link-preview-card">
                <div className="track-cover" style={{ width: 52, height: 52, flexShrink: 0 }}>
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
                  <div className="track-title" style={{ fontSize: '0.88rem' }}>
                    {ytLinkPreview.title}
                  </div>
                  <div className="track-sub tabular-nums" style={{ fontSize: '0.76rem' }}>
                    <span>{ytLinkPreview.artist}</span>
                    <span>
                      {' · '}
                      {ytLinkPreview.duration && ytLinkPreview.duration !== '—'
                        ? ytLinkPreview.duration
                        : 'Duración automática'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {ytLinkError && (
              <div className="link-flow-error" role="alert">
                <div className="link-flow-error-text">{ytLinkError}</div>
                {detectedLink.supported && (
                  <button
                    type="button"
                    className="btn secondary sm"
                    disabled={isOffline || ytLinkStage === 'converting'}
                    onClick={() => runDirectLinkDownload(true)}
                  >
                    <Icon name="refresh" size={13} />
                    <span>Reintentar con otra fuente</span>
                  </button>
                )}
              </div>
            )}

            <div style={{ fontSize: '0.76rem', color: 'var(--muted)', marginBottom: 6 }}>
              Guardar en:
            </div>
            <div
              className="dialog-list"
              style={{ maxHeight: 150, overflowY: 'auto', marginBottom: 14 }}
            >
              <button
                type="button"
                className={`dialog-option ${ytLinkTargetLib === 'offline' ? 'selected' : ''}`}
                disabled={ytLinkStage === 'converting'}
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
                disabled={ytLinkStage === 'converting'}
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
                  disabled={ytLinkStage === 'converting'}
                  onClick={() => setYtLinkTargetLib(pl.id)}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <Icon name="folder" size={14} /> {pl.name}
                  </span>
                  {ytLinkTargetLib === pl.id && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>

            <button
              type="submit"
              className="btn"
              disabled={
                isOffline ||
                !ytLinkUrl.trim() ||
                ytLinkLoading ||
                ytLinkStage === 'converting' ||
                (detectedLink.isUrl && !detectedLink.supported)
              }
              style={{
                width: '100%',
                justifyContent: 'center',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7
              }}
            >
              <Icon
                name={
                  ytLinkStage === 'ready'
                    ? 'play'
                    : ytLinkStage === 'converting'
                    ? 'loader'
                    : 'download'
                }
                size={15}
                className={ytLinkStage === 'converting' ? 'spin' : ''}
              />
              <span>
                {ytLinkStage === 'analyzing'
                  ? 'Analizando…'
                  : ytLinkStage === 'converting'
                  ? 'Convirtiendo…'
                  : ytLinkStage === 'ready'
                  ? 'Listo · Escuchar ahora'
                  : 'Descargar'}
              </span>
            </button>
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
    </>
  );
}
