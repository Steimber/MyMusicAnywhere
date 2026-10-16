'use client';

import { useState, useEffect, useRef } from 'react';
import { 
  Search, 
  Download, 
  Play, 
  Pause, 
  RefreshCw, 
  Music, 
  Check, 
  X, 
  Sparkles,
  Smartphone,
  Heart,
  Shuffle,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  Wifi,
  WifiOff,
  Trash2
} from 'lucide-react';

const SUGGESTIONS = [
  'Lo-Fi Chill Beats',
  'Synthwave Instrumental',
  'Classical Piano',
  'Ambient Focus',
  'Acoustic Guitar',
  'Jazz Lounge'
];

export default function HomePage() {
  // Tabs: 'search' | 'favorites' | 'downloads'
  const [activeTab, setActiveTab] = useState('search');
  
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchStatus, setSearchStatus] = useState('');

  // Favorites (persisted in localStorage)
  const [favorites, setFavorites] = useState([]);

  // Server Downloads & Offline cached audio
  const [libraryFiles, setLibraryFiles] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [offlineCachedUrls, setOfflineCachedUrls] = useState(new Set());
  const [isOnline, setIsOnline] = useState(true);

  // Download states: { [key]: { status, progress, filename, downloadUrl } }
  const [downloadStates, setDownloadStates] = useState({});

  // Audio Player & Queue
  const audioRef = useRef(null);
  const [playlist, setPlaylist] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Playback modes: isShuffle, repeatMode ('off' | 'all' | 'one')
  const [isShuffle, setIsShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState('off');

  // PWA Install prompt
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showInstallBtn, setShowInstallBtn] = useState(false);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    try {
      const saved = localStorage.getItem('mymusic_favorites');
      if (saved) setFavorites(JSON.parse(saved));
    } catch {}

    checkCachedAudio();
    fetchLibrary();

    const handleBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBtn(true);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    };
  }, []);

  const checkCachedAudio = async () => {
    if ('caches' in window) {
      try {
        const cache = await caches.open('mymusic-offline-audio');
        const keys = await cache.keys();
        setOfflineCachedUrls(new Set(keys.map(k => k.url)));
      } catch {}
    }
  };

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setShowInstallBtn(false);
    setDeferredPrompt(null);
  };

  const toggleFavorite = (track) => {
    const key = track.id || `${track.title}-${track.artist}`;
    setFavorites(prev => {
      const exists = prev.some(t => (t.id || `${t.title}-${t.artist}`) === key);
      let updated;
      if (exists) {
        updated = prev.filter(t => (t.id || `${t.title}-${t.artist}`) !== key);
      } else {
        updated = [track, ...prev];
      }
      try {
        localStorage.setItem('mymusic_favorites', JSON.stringify(updated));
      } catch {}
      return updated;
    });
  };

  const isFavorite = (track) => {
    const key = track.id || `${track.title}-${track.artist}`;
    return favorites.some(t => (t.id || `${t.title}-${t.artist}`) === key);
  };

  const fetchLibrary = async () => {
    setLibraryLoading(true);
    try {
      const res = await fetch('/api/library');
      const data = await res.json();
      setLibraryFiles(data.files || []);
      checkCachedAudio();
    } catch (e) {
      console.error(e);
    } finally {
      setLibraryLoading(false);
    }
  };

  const handleSearch = async (term) => {
    const q = (term !== undefined ? term : query).trim();
    if (!q) return;

    setSearchLoading(true);
    setSearchStatus(`Buscando canciones para "${q}"...`);
    setResults([]);

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.results || data.results.length === 0) {
        setSearchStatus('No se encontraron canciones. Probá con otro nombre.');
      } else {
        setSearchStatus(`Se encontraron ${data.results.length} canciones:`);
        setResults(data.results);
      }
    } catch {
      setSearchStatus('Error al consultar el catálogo.');
    } finally {
      setSearchLoading(false);
    }
  };

  // Download & AUTOMATIC DIRECT SAVE to user's device (phone/PC)
  const handleStartDownload = async (track) => {
    const trackKey = track.id || `${track.title}-${track.artist}`;
    setDownloadStates(prev => ({
      ...prev,
      [trackKey]: { status: 'downloading', progress: 0 }
    }));

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: track.title,
          artist: track.artist,
          artwork: track.artwork
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      // Poll download progress
      const pollInterval = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/download?id=${data.downloadId}`);
          const pollData = await pollRes.json();

          if (pollData.status === 'downloading') {
            setDownloadStates(prev => ({
              ...prev,
              [trackKey]: { status: 'downloading', progress: Math.round(pollData.progress || 0) }
            }));
          } else if (pollData.status === 'ready') {
            clearInterval(pollInterval);
            const streamUrl = `/api/stream?file=${encodeURIComponent(pollData.filename)}`;
            const downloadUrl = `${streamUrl}&download=1`;

            // 1. AUTOMATICALLY TRIGGER DIRECT DOWNLOAD TO DEVICE STORAGE (Mobile/PC)
            try {
              const a = document.createElement('a');
              a.href = downloadUrl;
              a.download = pollData.filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            } catch (err) {
              console.warn('Auto-download trigger notice:', err);
            }

            // 2. Cache in Cache Storage for offline playback inside the PWA
            if ('caches' in window) {
              caches.open('mymusic-offline-audio').then(cache => {
                fetch(streamUrl).then(response => {
                  if (response.ok) {
                    cache.put(streamUrl, response);
                    checkCachedAudio();
                  }
                }).catch(() => {});
              });
            }

            setDownloadStates(prev => ({
              ...prev,
              [trackKey]: {
                status: 'ready',
                progress: 100,
                filename: pollData.filename,
                downloadUrl
              }
            }));
            fetchLibrary();
          } else if (pollData.status === 'error') {
            clearInterval(pollInterval);
            setDownloadStates(prev => ({
              ...prev,
              [trackKey]: { status: 'error' }
            }));
          }
        } catch {
          clearInterval(pollInterval);
        }
      }, 1000);
    } catch {
      setDownloadStates(prev => ({
        ...prev,
        [trackKey]: { status: 'error' }
      }));
    }
  };

  const playTrackInQueue = (trackObj, queueList = [], index = 0) => {
    if (currentTrack?.url === trackObj.url && isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }

    if (queueList.length > 0) {
      setPlaylist(queueList);
      setCurrentIndex(index);
    }

    setCurrentTrack(trackObj);
    setIsPlaying(true);
    if (audioRef.current) {
      audioRef.current.src = trackObj.url;
      audioRef.current.play().catch(console.warn);
    }
  };

  const togglePlayPause = () => {
    if (!audioRef.current || !currentTrack) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(console.warn);
      setIsPlaying(true);
    }
  };

  const handleNext = () => {
    if (playlist.length === 0) return;

    if (repeatMode === 'one') {
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play();
      }
      return;
    }

    let nextIdx;
    if (isShuffle && playlist.length > 1) {
      do {
        nextIdx = Math.floor(Math.random() * playlist.length);
      } while (nextIdx === currentIndex);
    } else {
      nextIdx = currentIndex + 1;
      if (nextIdx >= playlist.length) {
        if (repeatMode === 'all') nextIdx = 0;
        else return;
      }
    }

    const nextTrack = playlist[nextIdx];
    if (nextTrack) {
      setCurrentIndex(nextIdx);
      setCurrentTrack(nextTrack);
      setIsPlaying(true);
      if (audioRef.current) {
        audioRef.current.src = nextTrack.url;
        audioRef.current.play().catch(console.warn);
      }
    }
  };

  const handlePrev = () => {
    if (!audioRef.current) return;
    if (currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }

    if (playlist.length === 0) return;
    let prevIdx = currentIndex - 1;
    if (prevIdx < 0) prevIdx = playlist.length - 1;

    const prevTrack = playlist[prevIdx];
    if (prevTrack) {
      setCurrentIndex(prevIdx);
      setCurrentTrack(prevTrack);
      setIsPlaying(true);
      audioRef.current.src = prevTrack.url;
      audioRef.current.play().catch(console.warn);
    }
  };

  const cycleRepeatMode = () => {
    setRepeatMode(prev => {
      if (prev === 'off') return 'all';
      if (prev === 'all') return 'one';
      return 'off';
    });
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
      setDuration(audioRef.current.duration || 0);
    }
  };

  const handleSeek = (e) => {
    const val = parseFloat(e.target.value);
    if (audioRef.current && duration > 0) {
      audioRef.current.currentTime = (val / 100) * duration;
    }
  };

  const formatTime = (sec) => {
    if (isNaN(sec) || sec <= 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="app-container">
      {/* Mineral Brand Header */}
      <header className="site-header">
        <div className="brand">
          <div className="brand-icon-box">
            <Music size={18} strokeWidth={2.5} />
          </div>
          <div>
            <div className="brand-word">myMusic<span>Anywhere</span></div>
            <span className="brand-sub">Personal Audio • PWA</span>
          </div>
        </div>

        <div className="header-actions">
          {!isOnline ? (
            <span className="badge-status offline"><WifiOff size={12} /> Offline</span>
          ) : (
            <span className="badge-status"><Wifi size={12} /> Online</span>
          )}

          {showInstallBtn && (
            <button className="btn-install" onClick={handleInstallClick}>
              <Smartphone size={14} /> Instalar
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="app-content">
        {/* --- TAB 1: SEARCH / EXPLORAR --- */}
        {activeTab === 'search' && (
          <section>
            <div className="search-box">
              <div className="search-input-wrapper">
                <Search size={18} className="search-icon" />
                <input
                  type="text"
                  placeholder="Buscar género, pista, artista o álbum..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                {query && (
                  <button className="btn-clear" onClick={() => { setQuery(''); setResults([]); setSearchStatus(''); }}>
                    <X size={16} />
                  </button>
                )}
              </div>
              <button 
                className="btn-primary" 
                onClick={() => handleSearch()}
                disabled={searchLoading}
              >
                {searchLoading ? <RefreshCw size={15} className="spin" /> : <Search size={15} />}
                Buscar
              </button>
            </div>

            {/* Chips */}
            <div className="chips-row">
              <span className="chip-label"><Sparkles size={12} style={{ display: 'inline' }} /> Sugeridos:</span>
              {SUGGESTIONS.map((item, idx) => (
                <button 
                  key={idx} 
                  className="chip" 
                  onClick={() => { setQuery(item); handleSearch(item); }}
                >
                  {item}
                </button>
              ))}
            </div>

            {searchStatus && <div className="status-message">{searchStatus}</div>}

            {/* Results Grid */}
            <div className="cards-grid">
              {results.map((track) => {
                const trackKey = track.id || `${track.title}-${track.artist}`;
                const dlState = downloadStates[trackKey];
                const fav = isFavorite(track);
                const isThisPreviewPlaying = isPlaying && currentTrack?.url === track.previewUrl;

                return (
                  <div key={trackKey} className="track-card">
                    {/* Heart button */}
                    <button 
                      className={`btn-fav ${fav ? 'active' : ''}`}
                      title={fav ? 'Quitar de Me gusta' : 'Agregar a Me gusta'}
                      onClick={() => toggleFavorite(track)}
                    >
                      <Heart size={18} fill={fav ? '#b0603c' : 'none'} color={fav ? '#b0603c' : 'currentColor'} strokeWidth={2} />
                    </button>

                    <div className="card-cover">
                      <img src={track.artwork || '/icon.svg'} alt={track.title} loading="lazy" />
                      {track.previewUrl && (
                        <button 
                          className="btn-preview" 
                          title="Escuchar previa"
                          onClick={() => playTrackInQueue({
                            url: track.previewUrl,
                            title: `${track.title} (Previa)`,
                            artist: track.artist,
                            artwork: track.artwork,
                            isPreview: true
                          })}
                        >
                          {isThisPreviewPlaying ? <Pause size={18} /> : <Play size={18} />}
                        </button>
                      )}
                    </div>

                    <div className="card-info">
                      <div className="card-title" title={track.title}>{track.title}</div>
                      <div className="card-artist" title={track.artist}>{track.artist}</div>
                      <div className="card-album" title={track.album}>
                        {track.album} {track.duration ? `• ${formatTime(track.duration)}` : ''}
                      </div>
                    </div>

                    {/* Download Button */}
                    {!dlState ? (
                      <button 
                        className="btn-download-action" 
                        onClick={() => handleStartDownload(track)}
                      >
                        <Download size={14} /> Descargar a móvil
                      </button>
                    ) : dlState.status === 'downloading' ? (
                      <button className="btn-download-action loading" disabled>
                        <RefreshCw size={14} className="spin" /> Guardando ({dlState.progress}%)...
                      </button>
                    ) : dlState.status === 'ready' ? (
                      <a 
                        className="btn-download-action ready" 
                        href={dlState.downloadUrl}
                        download={dlState.filename}
                      >
                        <Check size={14} /> ¡Guardado en móvil!
                      </a>
                    ) : (
                      <button 
                        className="btn-download-action" 
                        onClick={() => handleStartDownload(track)}
                      >
                        ❌ Reintentar
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* --- TAB 2: FAVORITOS (ME GUSTA) --- */}
        {activeTab === 'favorites' && (
          <section>
            <div className="library-head">
              <h2>Canciones que te gustan ({favorites.length})</h2>
              {favorites.length > 0 && (
                <button 
                  className="btn-secondary"
                  onClick={() => {
                    const queue = favorites.map(f => ({
                      url: f.previewUrl,
                      title: f.title,
                      artist: f.artist,
                      artwork: f.artwork,
                      isPreview: true
                    }));
                    if (queue.length > 0) playTrackInQueue(queue[0], queue, 0);
                  }}
                >
                  <Play size={14} /> Reproducir todas
                </button>
              )}
            </div>

            {favorites.length === 0 ? (
              <p className="status-message">
                Aún no diste corazón a ninguna canción. Dale ❤️ a las canciones que busques para guardarlas en tu lista.
              </p>
            ) : (
              <div className="library-list">
                {favorites.map((favTrack, idx) => {
                  const trackKey = favTrack.id || `${favTrack.title}-${favTrack.artist}`;
                  const dlState = downloadStates[trackKey];
                  const isCurrent = currentTrack?.title === favTrack.title && isPlaying;

                  return (
                    <div key={trackKey} className="library-item">
                      <div className="library-item-info">
                        <img src={favTrack.artwork || '/icon.svg'} alt={favTrack.title} className="item-thumb" />
                        <div>
                          <div className="library-item-name">{favTrack.title}</div>
                          <div className="library-item-meta">{favTrack.artist} {favTrack.album ? `• ${favTrack.album}` : ''}</div>
                        </div>
                      </div>

                      <div className="library-item-actions">
                        {/* Play preview */}
                        {favTrack.previewUrl && (
                          <button 
                            className="btn-item btn-item-play"
                            onClick={() => {
                              const queue = favorites.map(f => ({
                                url: f.previewUrl,
                                title: f.title,
                                artist: f.artist,
                                artwork: f.artwork,
                                isPreview: true
                              }));
                              playTrackInQueue(queue[idx], queue, idx);
                            }}
                          >
                            {isCurrent ? <Pause size={13} /> : <Play size={13} />}
                            {isCurrent ? 'Pausar' : 'Previa'}
                          </button>
                        )}

                        {/* Download button directly in favorites */}
                        {!dlState ? (
                          <button 
                            className="btn-item btn-item-save"
                            onClick={() => handleStartDownload(favTrack)}
                            title="Descargar y guardar en dispositivo"
                          >
                            <Download size={13} /> Bajar
                          </button>
                        ) : dlState.status === 'downloading' ? (
                          <button className="btn-item btn-item-save" disabled>
                            <RefreshCw size={13} className="spin" /> {dlState.progress}%
                          </button>
                        ) : dlState.status === 'ready' ? (
                          <a 
                            className="btn-item btn-item-save" 
                            href={dlState.downloadUrl}
                            download={dlState.filename}
                            style={{ background: 'var(--lime)', color: '#000' }}
                          >
                            <Check size={13} /> Guardado
                          </a>
                        ) : (
                          <button className="btn-item btn-item-save" onClick={() => handleStartDownload(favTrack)}>
                            ❌
                          </button>
                        )}

                        {/* Remove favorite */}
                        <button 
                          className="btn-item-fav-remove" 
                          title="Quitar" 
                          onClick={() => toggleFavorite(favTrack)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* --- TAB 3: DESCARGAS & OFFLINE --- */}
        {activeTab === 'downloads' && (
          <section>
            <div className="library-head">
              <h2>Música en dispositivo ({libraryFiles.length})</h2>
              <button className="btn-secondary" onClick={fetchLibrary} disabled={libraryLoading}>
                <RefreshCw size={13} className={libraryLoading ? 'spin' : ''} /> Actualizar
              </button>
            </div>

            {libraryFiles.length === 0 ? (
              <p className="status-message">
                Todavía no descargaste canciones completas. ¡Buscá en Explorar y presiona «Descargar a móvil»!
              </p>
            ) : (
              <div className="library-list">
                {libraryFiles.map((file, idx) => {
                  const cleanName = file.filename.replace(/\.mp3$/i, '');
                  const isCurrent = currentTrack?.filename === file.filename && isPlaying;
                  const isCachedOffline = offlineCachedUrls.has(window.location.origin + file.url);

                  return (
                    <div key={file.filename} className="library-item">
                      <div className="library-item-info">
                        <div className="brand-icon-box" style={{ width: '38px', height: '38px' }}>
                          <Music size={18} strokeWidth={2.5} />
                        </div>
                        <div>
                          <div className="library-item-name" title={cleanName}>
                            {cleanName}
                            {isCachedOffline && <span className="badge-offline">⚡ Offline</span>}
                          </div>
                          <div className="library-item-meta">{file.sizeMB} MB • MP3 Audio</div>
                        </div>
                      </div>

                      <div className="library-item-actions">
                        <button 
                          className="btn-item btn-item-play"
                          onClick={() => {
                            const queue = libraryFiles.map(f => ({
                              url: f.url,
                              title: f.filename.replace(/\.mp3$/i, ''),
                              artist: 'Descarga local',
                              artwork: '/icon.svg',
                              filename: f.filename,
                              downloadUrl: `${f.url}&download=1`
                            }));
                            playTrackInQueue(queue[idx], queue, idx);
                          }}
                        >
                          {isCurrent ? <Pause size={13} /> : <Play size={13} />}
                          {isCurrent ? 'Pausar' : 'Escuchar'}
                        </button>
                        <a 
                          className="btn-item btn-item-save" 
                          href={`${file.url}&download=1`}
                          download={file.filename}
                          title="Descargar archivo a tu móvil o PC"
                        >
                          <Download size={13} /> Guardar
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </main>

      {/* Floating Audio Player (docks above bottom navigation bar) */}
      {currentTrack && (
        <footer className="global-player">
          <div className="player-info">
            <img src={currentTrack.artwork || '/icon.svg'} alt="Cover" className="player-thumb" />
            <div className="player-meta">
              <span className="player-title">{currentTrack.title}</span>
              <span className="player-artist">{currentTrack.artist}</span>
            </div>
          </div>

          <div className="player-controls">
            <div className="player-buttons">
              {/* Shuffle button */}
              <button 
                className={`btn-ctrl ${isShuffle ? 'active' : ''}`}
                title={isShuffle ? 'Aleatorio activado' : 'Activar aleatorio'}
                onClick={() => setIsShuffle(prev => !prev)}
              >
                <Shuffle size={17} />
              </button>

              {/* Prev */}
              <button className="btn-ctrl" onClick={handlePrev} title="Anterior">
                <SkipBack size={19} />
              </button>

              {/* Main Play/Pause */}
              <button className="btn-ctrl btn-play-main" onClick={togglePlayPause}>
                {isPlaying ? <Pause size={19} /> : <Play size={19} />}
              </button>

              {/* Next */}
              <button className="btn-ctrl" onClick={handleNext} title="Siguiente">
                <SkipForward size={19} />
              </button>

              {/* Repeat button */}
              <button 
                className={`btn-ctrl ${repeatMode !== 'off' ? 'active' : ''}`}
                title={`Repetir: ${repeatMode}`}
                onClick={cycleRepeatMode}
              >
                {repeatMode === 'one' ? <Repeat1 size={17} /> : <Repeat size={17} />}
              </button>
            </div>

            <div className="player-progress-row">
              <span className="time-label">{formatTime(currentTime)}</span>
              <input 
                type="range" 
                min="0" 
                max="100" 
                value={duration ? (currentTime / duration) * 100 : 0} 
                onChange={handleSeek}
                className="player-slider"
              />
              <span className="time-label">{formatTime(duration)}</span>
            </div>
          </div>

          <div className="player-actions">
            {currentTrack.downloadUrl && (
              <a 
                href={currentTrack.downloadUrl} 
                download={currentTrack.filename} 
                className="btn-icon" 
                title="Guardar archivo en dispositivo"
              >
                <Download size={18} />
              </a>
            )}
            <button className="btn-icon" onClick={() => { audioRef.current?.pause(); setCurrentTrack(null); setIsPlaying(false); }}>
              <X size={18} />
            </button>
          </div>
        </footer>
      )}

      {/* PWA Mobile Bottom Navigation Bar (Fijo abajo de todo con estilo Mineral) */}
      <nav className="pwa-bottom-bar">
        <button 
          className={`pwa-bar-item ${activeTab === 'search' ? 'active' : ''}`}
          onClick={() => setActiveTab('search')}
        >
          <Search size={20} strokeWidth={2.2} />
          <span>Buscar</span>
        </button>

        <button 
          className={`pwa-bar-item ${activeTab === 'favorites' ? 'active' : ''}`}
          onClick={() => setActiveTab('favorites')}
        >
          <Heart size={20} strokeWidth={2.2} fill={activeTab === 'favorites' ? 'var(--clay)' : 'none'} color={activeTab === 'favorites' ? 'var(--clay)' : 'currentColor'} />
          <span>Me gusta</span>
          {favorites.length > 0 && <span className="pwa-bar-badge">{favorites.length}</span>}
        </button>

        <button 
          className={`pwa-bar-item ${activeTab === 'downloads' ? 'active' : ''}`}
          onClick={() => { setActiveTab('downloads'); fetchLibrary(); }}
        >
          <Download size={20} strokeWidth={2.2} />
          <span>Offline</span>
          {libraryFiles.length > 0 && <span className="pwa-bar-badge">{libraryFiles.length}</span>}
        </button>
      </nav>

      {/* Hidden Audio Element */}
      <audio 
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleNext}
      />
    </div>
  );
}
