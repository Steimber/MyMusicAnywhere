'use client';

export default function SettingsPanel({
  user,
  isOffline,
  Icon,
  // Cross-device sync & JSON backup
  syncState,
  likedCount,
  playlistsCount,
  backupMsg,
  onExportBackupJson,
  onImportBackupJson,
  onForceCloudSync,
  // Spotify & CSV import
  spotifyUrl,
  setSpotifyUrl,
  spotifyBusy,
  spotifyMsg,
  pendingSpotifyImport,
  spotifyNewLibName,
  setSpotifyNewLibName,
  customPlaylists,
  onSpotifyUrlSubmit,
  onSpotifyCsvFile,
  onConfirmSpotifyImport,
  onCloseSpotifyImport,
  onGoToLibrary,
  // Offline storage & persistence
  deviceQuota,
  offlineCount,
  storagePersisted,
  storagePersistMsg,
  onRequestPersistentStorage,
  onClearOfflineCache,
  // Admin YouTube cookies
  adminYtCookies,
  ytCookiesText,
  setYtCookiesText,
  ytCookiesBusy,
  ytCookiesMsg,
  onSaveYtCookies,
  onClearYtCookies
}) {
  return (
    <section>
      <div className="section-bar">
        <div>
          <h1 className="section-bar-title">Ajustes y sincronización</h1>
          <p className="section-bar-sub">
            Sincroniza tus librerías entre dispositivos, importa listas y protege tu almacenamiento Offline.
          </p>
        </div>
      </div>

      {/* 1. Cross-device library sync & JSON backup */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="settings-card-head">
          <div className="settings-card-info">
            <div className="settings-card-title">Sincronización y respaldo de librerías</div>
            <div className="settings-card-sub">
              Tus listas (<span className="tabular-nums">{likedCount}</span> en Favoritos y{' '}
              <span className="tabular-nums">{playlistsCount}</span>{' '}
              {playlistsCount === 1 ? 'librería propia' : 'librerías propias'}) se sincronizan con tu
              cuenta. El audio permanece guardado en cada dispositivo.
            </div>
          </div>
          <span
            className={`badge ${
              syncState?.status === 'synced' ? 'lime' : syncState?.status === 'error' ? '' : 'lavender'
            }`.trim()}
          >
            {syncState?.status === 'syncing'
              ? 'Sincronizando…'
              : syncState?.status === 'synced'
              ? 'En la nube'
              : isOffline
              ? 'Modo local'
              : 'Pendiente'}
          </span>
        </div>

        {backupMsg?.text && (
          <div className={`alert ${backupMsg.type === 'err' ? 'err' : 'ok'}`}>
            {backupMsg.text}
          </div>
        )}

        <div className="settings-actions-row" style={{ marginTop: 4 }}>
          <div className="settings-actions-group">
            <button
              type="button"
              className="btn secondary sm"
              onClick={onExportBackupJson}
            >
              <Icon name="download" size={14} /> Exportar respaldo (.json)
            </button>

            <label
              htmlFor="import-library-backup-json"
              className="btn secondary sm upload-trigger-label"
              style={{ cursor: 'pointer' }}
            >
              <input
                id="import-library-backup-json"
                type="file"
                accept=".json,application/json"
                className="visually-hidden"
                onChange={async e => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) {
                    await onImportBackupJson(file);
                  }
                }}
              />
              <Icon name="upload" size={14} /> Importar respaldo (.json)
            </label>
          </div>

          {!user?.offline && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={isOffline || syncState?.status === 'syncing'}
              onClick={onForceCloudSync}
            >
              <Icon
                name="refresh"
                size={14}
                className={syncState?.status === 'syncing' ? 'spin' : ''}
              />{' '}
              Sincronizar ahora
            </button>
          )}
        </div>
      </div>

      {/* 2. Spotify / CSV Import */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="settings-card-head">
          <div className="settings-card-info">
            <div className="settings-card-title">Importar desde Spotify</div>
            <div className="settings-card-sub">
              Pega un enlace público de Spotify o sube tu archivo <code>.csv</code> de Exportify para elegir en qué librería guardarlo.
            </div>
          </div>
          <span className="badge lime">Sync</span>
        </div>

        {spotifyMsg.text && (
          <div className={`alert ${spotifyMsg.type === 'err' ? 'err' : 'ok'}`}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap'
              }}
            >
              <span>{spotifyMsg.text}</span>
              {spotifyMsg.type === 'ok' && !pendingSpotifyImport && (
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={onGoToLibrary}
                >
                  Ver en Biblioteca <Icon name="arrow-right" size={13} />
                </button>
              )}
            </div>
          </div>
        )}

        <form
          className={`search-bar ${isOffline ? 'offline-section-disabled' : ''}`.trim()}
          style={{ marginBottom: 12 }}
          onSubmit={onSpotifyUrlSubmit}
        >
          <input
            type="url"
            name="spotifyUrl"
            aria-label="Enlace de playlist de Spotify"
            className="search-input"
            placeholder="https://open.spotify.com/playlist/..."
            value={spotifyUrl}
            onChange={e => setSpotifyUrl(e.target.value)}
            disabled={isOffline}
            required
          />
          <button type="submit" className="btn sm" disabled={spotifyBusy || isOffline}>
            {spotifyBusy ? 'Leyendo…' : 'Importar link'}
          </button>
        </form>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
            fontSize: '0.8rem',
            color: 'var(--muted)'
          }}
        >
          <span>
            ¿Tienes un archivo <code>.csv</code> de{' '}
            <a
              href="https://exportify.net"
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: 'underline', fontWeight: 700 }}
            >
              exportify.net
            </a>
            ?
          </span>
          <label
            htmlFor="import-spotify-csv-input"
            className="btn secondary sm upload-trigger-label"
            style={{ cursor: 'pointer' }}
          >
            <input
              id="import-spotify-csv-input"
              type="file"
              accept=".csv,text/csv,text/plain,application/vnd.ms-excel"
              className="visually-hidden"
              onChange={async e => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) {
                  await onSpotifyCsvFile(file);
                }
              }}
            />
            <Icon name="folder" size={14} /> Subir CSV de Spotify
          </label>
        </div>

        {pendingSpotifyImport && (
          <div className="import-destination-box">
            <div className="dialog-head" style={{ marginBottom: 8 }}>
              <div>
                <div className="dialog-title">
                  ¿En qué librería deseas guardar estas {pendingSpotifyImport.tracks.length} canciones?
                </div>
                <div className="dialog-sub">
                  Origen: «{pendingSpotifyImport.sourceName}»
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={onCloseSpotifyImport}
                aria-label="Cancelar importación"
                title="Cancelar"
              >
                <Icon name="close" size={15} />
              </button>
            </div>

            <div className="dialog-list">
              <button
                type="button"
                className="dialog-option selected"
                onClick={() => onConfirmSpotifyImport('liked')}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Icon name="heart-fill" size={14} /> Guardar en Favoritos
                </span>
                <Icon name="arrow-right" size={14} />
              </button>

              {customPlaylists.map(pl => (
                <button
                  key={pl.id}
                  type="button"
                  className="dialog-option"
                  onClick={() => onConfirmSpotifyImport(pl.id)}
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
              style={{ marginTop: 8, marginBottom: 0 }}
              onSubmit={e => {
                e.preventDefault();
                onConfirmSpotifyImport('new_playlist', spotifyNewLibName);
              }}
            >
              <input
                type="text"
                name="newLibraryName"
                aria-label="Nombre de nueva librería"
                className="search-input"
                placeholder="O escribir nombre de nueva librería…"
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
      </div>

      {/* 3. Offline storage & persistent quota protection */}
      <div className="card">
        <div className="settings-card-head" style={{ marginBottom: storagePersistMsg ? 10 : 8 }}>
          <div className="settings-card-info">
            <div className="settings-card-title">Almacenamiento Offline</div>
            <div className="settings-card-sub tabular-nums">
              {deviceQuota
                ? `${deviceQuota.usedMB} MB usados de ~${deviceQuota.quotaGB} GB (${offlineCount} canciones en caché).`
                : `${offlineCount} canciones guardadas en este dispositivo.`}
            </div>
          </div>
          <span className={`badge ${storagePersisted === 'granted' ? 'lime' : ''}`.trim()}>
            {storagePersisted === 'granted' ? 'Protegido' : 'Estándar'}
          </span>
        </div>

        {storagePersistMsg && (
          <div className="settings-card-sub" style={{ marginBottom: 10 }}>
            {storagePersistMsg}
          </div>
        )}

        <div className="settings-actions-row">
          <div className="settings-actions-group">
            {storagePersisted !== 'granted' && storagePersisted !== 'unsupported' && (
              <button
                type="button"
                className="btn secondary sm"
                onClick={onRequestPersistentStorage}
              >
                <Icon name="shield" size={14} /> Proteger canciones Offline
              </button>
            )}
          </div>

          {offlineCount > 0 && (
            <button
              type="button"
              className="btn danger sm"
              onClick={onClearOfflineCache}
            >
              <Icon name="trash" size={14} /> Vaciar Offline
            </button>
          )}
        </div>
      </div>

      {/* 4. Admin-only YouTube Cookies */}
      {user?.is_admin && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="settings-card-head">
            <div className="settings-card-info">
              <div className="settings-card-title">Cookies de YouTube</div>
              <div className="settings-card-sub">
                Pega o sube tus cookies en <code>JSON</code> (Cookie-Editor) o <code>cookies.txt</code> (Netscape) para priorizar YouTube en el VPS.
              </div>
            </div>
            <span className={`badge ${adminYtCookies?.configured ? 'lime' : ''}`}>
              {adminYtCookies?.configured
                ? `Activas (${adminYtCookies.cookieLines})`
                : 'Sin configurar'}
            </span>
          </div>

          {ytCookiesMsg.text && (
            <div
              className={`alert ${ytCookiesMsg.type === 'error' ? 'err' : 'ok'}`}
              style={{ marginBottom: 10 }}
            >
              {ytCookiesMsg.text}
            </div>
          )}

          <textarea
            className="cookies-textarea"
            rows={4}
            aria-label="Contenido de cookies de YouTube"
            placeholder='Pega aquí el JSON exportado ([ { "domain": ".youtube.com", ... } ]) o el contenido de cookies.txt…'
            value={ytCookiesText}
            disabled={ytCookiesBusy || isOffline}
            onChange={e => setYtCookiesText(e.target.value)}
          />

          <div className="settings-actions-row">
            <div className="settings-actions-group">
              <button
                type="button"
                className="btn sm"
                disabled={ytCookiesBusy || isOffline || !ytCookiesText.trim()}
                onClick={() => onSaveYtCookies(ytCookiesText)}
              >
                <Icon name="check" size={14} /> {ytCookiesBusy ? 'Guardando…' : 'Guardar cookies'}
              </button>

              <label
                htmlFor="upload-yt-cookies-file"
                className={`btn secondary sm upload-trigger-label ${
                  ytCookiesBusy || isOffline ? 'is-disabled' : ''
                }`.trim()}
                style={{ cursor: ytCookiesBusy || isOffline ? 'not-allowed' : 'pointer' }}
              >
                <input
                  id="upload-yt-cookies-file"
                  type="file"
                  accept=".txt,.json,text/plain,application/json"
                  disabled={ytCookiesBusy || isOffline}
                  className="visually-hidden"
                  onChange={async e => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    const text = await file.text();
                    await onSaveYtCookies(text);
                  }}
                />
                <Icon name="folder" size={14} /> Subir .json / .txt
              </label>
            </div>

            {adminYtCookies?.configured && (
              <button
                type="button"
                className="btn danger sm"
                disabled={ytCookiesBusy || isOffline}
                onClick={onClearYtCookies}
              >
                <Icon name="trash" size={14} /> Quitar
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
