'use client';

import { useState, useEffect, useRef } from 'react';

const AUDIO_CACHE_NAME = 'my-music-offline-audio-v1';

const DISCOVERY_SEEDS = [
  { term: 'Pop Latino Hits', label: 'Pop Latino' },
  { term: 'Rock Clásico Español', label: 'Rock en Español' },
  { term: 'Daft Punk Electronic Synth', label: 'Electrónica & Synth' },
  { term: 'Indie Alternative Hits', label: 'Indie & Alternativo' },
  { term: 'Reggaeton Urbano Latino', label: 'Urbano & Reggaetón' },
  { term: 'The Weeknd R&B Soul', label: 'R&B & Soul' },
  { term: 'Lo-Fi Chill Jazz Beats', label: 'Lo-Fi & Jazz' },
  { term: 'Hip-Hop Rap Classics', label: 'Hip-Hop & Rap' }
];

export default function HomePage() {
  // Auth state
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // Navigation
  const [activeTab, setActiveTab] = useState('explore'); // 'explore' | 'library' | 'files' | 'admin'

  // Explore, Recommendations & Search
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [feedInfo, setFeedInfo] = useState({ mode: 'random', label: 'Descubrimiento aleatorio' });

  // Library & Offline Cache
  const [likedTracks, setLikedTracks] = useState([]);
  const [downloads, setDownloads] = useState({});
  const [libraryFiles, setLibraryFiles] = useState([]);
  const [offlineUrls, setOfflineUrls] = useState({});
  const [syncingAll, setSyncingAll] = useState(false);

  // Admin Panel state
  const [adminData, setAdminData] = useState({ users: [], invites: [], storage: null });
  const [inviteLabel, setInviteLabel] = useState('');
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [adminMsg, setAdminMsg] = useState('');
  const [copiedCode, setCopiedCode] = useState('');

  // PWA Install Prompt
  const [deferredPrompt, setDeferredPrompt] = useState(null);

  // Audio Player State
  const [queue, setQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState('off'); // 'off' | 'all' | 'one'
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef(null);
  const savedDeviceIdsRef = useRef(new Set());
  const accountRef = useRef(null);

  const currentTrack = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

  // Check session on mount
  useEffect(() => {
    fetch('/api/auth')
      .then(r => r.json())
      .then(data => {
        if (data.user) {
          setUser(data.user);
        }
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));

    try {
      const savedLikes = localStorage.getItem('mma_liked_tracks_v1');
      if (savedLikes) setLikedTracks(JSON.parse(savedLikes));
    } catch {}

    refreshOfflineCacheList();

    const handleBeforeInstall = e => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  // Load initial catalog (recommended by liked genres, or random if none) & server files once logged in
  useEffect(() => {
    if (!user) return;
    fetchLibraryFiles();
    let initialLikes = likedTracks;
    try {
      const raw = localStorage.getItem('mma_liked_tracks_v1');
      if (raw) initialLikes = JSON.parse(raw);
    } catch {}
    loadRecommendedOrRandomFeed(initialLikes, false);
    if (user.is_admin) {
      fetchAdminData();
    }
  }, [user]);

  // Close account dropdown on outside click
  useEffect(() => {
    function onDocClick(e) {
      if (accountRef.current && !accountRef.current.contains(e.target)) {
        setAccountOpen(false);
      }
    }
    if (accountOpen) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [accountOpen]);

  // Poll active downloads
  useEffect(() => {
    const activeIds = Object.values(downloads)
      .filter(d => d.status === 'downloading')
      .map(d => d.downloadId);

    if (activeIds.length === 0) return;

    const timer = setInterval(async () => {
      for (const id of activeIds) {
        try {
          const res = await fetch(`/api/download?id=${id}`);
          if (!res.ok) continue;
          const data = await res.json();

          setDownloads(prev => {
            const key = Object.keys(prev).find(k => prev[k].downloadId === id);
            if (!key) return prev;
            return { ...prev, [key]: { ...prev[key], ...data } };
          });

          if (data.status === 'ready' && data.filename) {
            const streamUrl = `/api/stream?file=${encodeURIComponent(data.filename)}`;
            const downloadUrl = `/api/stream?file=${encodeURIComponent(data.filename)}&download=1`;

            const trackKey = Object.keys(downloads).find(k => downloads[k].downloadId === id);
            const likedMatch = likedTracks.find(t => String(t.id) === String(trackKey));

            await saveUrlToOfflineCache(streamUrl, likedMatch ? likedMatch.id : data.filename);

            if (!savedDeviceIdsRef.current.has(id)) {
              savedDeviceIdsRef.current.add(id);
              triggerBrowserFileDownload(downloadUrl, data.filename);
            }

            if (likedMatch) {
              updateLikedTrackFile(likedMatch.id, data.filename, streamUrl);
            }
            fetchLibraryFiles();
            if (user?.is_admin) fetchAdminData();
          }
        } catch {}
      }
    }, 1400);

    return () => clearInterval(timer);
  }, [downloads, likedTracks, user]);

  // Manage audio playback when currentTrack changes
  useEffect(() => {
    if (!currentTrack || !audioRef.current) return;
    const playTrack = async () => {
      const src = await resolvePlayableSource(currentTrack);
      if (!src) return;
      audioRef.current.src = src;
      try {
        await audioRef.current.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
    };
    playTrack();
  }, [currentIndex, queue]);

  // Auth handlers
  async function handleAuthSubmit(e) {
    e.preventDefault();
    setAuthError('');
    setAuthBusy(true);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: authMode,
          username,
          password,
          inviteCode: authMode === 'register' ? inviteCode : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Error de autenticación');
      } else {
        setUser(data.user);
        setPassword('');
        setInviteCode('');
      }
    } catch {
      setAuthError('Error de red al conectar con el servidor.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' })
    });
    if (audioRef.current) audioRef.current.pause();
    setUser(null);
    setAccountOpen(false);
    setActiveTab('explore');
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

  // Offline & File helpers
  function triggerBrowserFileDownload(url, filename) {
    if (typeof document === 'undefined') return;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'track.mp3';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 1000);
  }

  function persistLikes(nextLikes) {
    setLikedTracks(nextLikes);
    try {
      localStorage.setItem('mma_liked_tracks_v1', JSON.stringify(nextLikes));
    } catch {}
  }

  function isLiked(trackId) {
    return likedTracks.some(t => String(t.id) === String(trackId));
  }

  function toggleLike(track) {
    if (isLiked(track.id)) {
      persistLikes(likedTracks.filter(t => String(t.id) !== String(track.id)));
    } else {
      const existingDl = downloads[track.id];
      const entry = {
        ...track,
        addedAt: Date.now(),
        filename: existingDl?.filename || track.filename || null,
        streamUrl: existingDl?.filename
          ? `/api/stream?file=${encodeURIComponent(existingDl.filename)}`
          : track.streamUrl || null
      };
      persistLikes([entry, ...likedTracks]);
    }
  }

  function updateLikedTrackFile(trackId, filename, streamUrl) {
    setLikedTracks(prev => {
      const updated = prev.map(t =>
        String(t.id) === String(trackId) ? { ...t, filename, streamUrl } : t
      );
      try {
        localStorage.setItem('mma_liked_tracks_v1', JSON.stringify(updated));
      } catch {}
      return updated;
    });
  }

  async function refreshOfflineCacheList() {
    if (typeof window === 'undefined' || !('caches' in window)) return;
    try {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      const keys = await cache.keys();
      const map = {};
      for (const req of keys) {
        const url = new URL(req.url);
        map[url.pathname + url.search] = true;
      }
      setOfflineUrls(map);
    } catch {}
  }

  async function saveUrlToOfflineCache(url) {
    if (typeof window === 'undefined' || !('caches' in window)) return false;
    try {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      const response = await fetch(url);
      if (response.ok) {
        await cache.put(url, response.clone());
        await refreshOfflineCacheList();
        return true;
      }
    } catch {}
    return false;
  }

  async function resolvePlayableSource(track) {
    const streamUrl =
      track.streamUrl ||
      (track.filename ? `/api/stream?file=${encodeURIComponent(track.filename)}` : null);

    if (streamUrl && 'caches' in window) {
      try {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        const cachedResp = await cache.match(streamUrl);
        if (cachedResp) {
          const blob = await cachedResp.blob();
          return URL.createObjectURL(blob);
        }
      } catch {}
    }

    if (streamUrl) return streamUrl;
    return track.previewUrl || null;
  }

  function getLikedCategories(tracksList = likedTracks) {
    const counts = {};
    for (const t of tracksList) {
      const cat = t.genre && t.genre !== 'Música' ? t.genre : t.artist;
      if (cat) {
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }

  function loadRecommendedOrRandomFeed(tracksList = likedTracks, forceRandom = false) {
    const categories = getLikedCategories(tracksList);
    if (!forceRandom && categories.length > 0) {
      const topPool = categories.slice(0, 4);
      const chosenCategory = topPool[Math.floor(Math.random() * topPool.length)];
      searchTracks(chosenCategory, {
        mode: 'recommended',
        label: chosenCategory
      });
    } else {
      const randomSeed = DISCOVERY_SEEDS[Math.floor(Math.random() * DISCOVERY_SEEDS.length)];
      searchTracks(randomSeed.term, {
        mode: 'random',
        label: randomSeed.label
      });
    }
  }

  async function searchTracks(searchTerm, meta = null) {
    if (!searchTerm.trim()) return;
    setLoading(true);
    if (meta) {
      setFeedInfo(meta);
    } else {
      setFeedInfo({ mode: 'search', label: searchTerm.trim() });
    }
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchTerm)}`);
      const data = await res.json();
      setResults(data.results || data.tracks || []);
    } catch {}
    setLoading(false);
  }

  async function fetchLibraryFiles() {
    try {
      const res = await fetch('/api/library');
      if (!res.ok) return;
      const data = await res.json();
      setLibraryFiles(data.files || []);
    } catch {}
  }

  async function startDownload(track) {
    const key = track.id || track.title;
    if (downloads[key]?.status === 'downloading') return;

    setDownloads(prev => ({
      ...prev,
      [key]: { status: 'downloading', progress: 0 }
    }));

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: track.title,
          artist: track.artist,
          artwork: track.artwork,
          query: `${track.title} ${track.artist || ''}`.trim()
        })
      });
      const data = await res.json();
      if (data.downloadId) {
        setDownloads(prev => ({
          ...prev,
          [key]: { status: 'downloading', progress: 5, downloadId: data.downloadId }
        }));
      } else {
        setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
      }
    } catch {
      setDownloads(prev => ({ ...prev, [key]: { status: 'error' } }));
    }
  }

  async function downloadAllLikedForOffline() {
    if (syncingAll || likedTracks.length === 0) return;
    setSyncingAll(true);
    for (const track of likedTracks) {
      const streamUrl =
        track.streamUrl ||
        (track.filename ? `/api/stream?file=${encodeURIComponent(track.filename)}` : null);
      if (streamUrl && offlineUrls[streamUrl]) continue;
      if (streamUrl) {
        await saveUrlToOfflineCache(streamUrl, track.id);
      } else {
        await startDownload(track);
      }
    }
    setSyncingAll(false);
  }

  // Player controls
  function playFromList(list, index) {
    setQueue(list);
    setCurrentIndex(index);
  }

  function togglePlayPause() {
    if (!audioRef.current || !currentTrack) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  }

  function playNext() {
    if (queue.length === 0) return;
    if (shuffle && queue.length > 1) {
      let nextIdx = currentIndex;
      while (nextIdx === currentIndex) {
        nextIdx = Math.floor(Math.random() * queue.length);
      }
      setCurrentIndex(nextIdx);
      return;
    }
    if (currentIndex < queue.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else if (repeatMode === 'all') {
      setCurrentIndex(0);
    } else {
      setIsPlaying(false);
    }
  }

  function playPrev() {
    if (queue.length === 0) return;
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    } else if (repeatMode === 'all') {
      setCurrentIndex(queue.length - 1);
    }
  }

  function handleTrackEnded() {
    if (repeatMode === 'one' && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      return;
    }
    playNext();
  }

  function cycleRepeatMode() {
    setRepeatMode(prev => (prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off'));
  }

  function formatSec(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function handleInstallPwa() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  }

  if (!authChecked) {
    return (
      <main className="shell">
        <div className="empty" style={{ marginTop: 48 }}>
          <div className="empty-title">Cargando estudio musical…</div>
          <div>Verificando sesión activa</div>
        </div>
      </main>
    );
  }

  // ==================== UNAUTHENTICATED VIEW (LOGIN + INVITE REGISTER) ====================
  if (!user) {
    return (
      <>
        <header className="site-header">
          <div className="brand">
            <img src="/icon.svg" alt="MyMusicAnywhere" className="brand-logo" />
            <div className="brand-text">
              <span className="brand-name">MyMusicAnywhere</span>
              <span className="brand-sub">Estudio privado &amp; PWA offline</span>
            </div>
          </div>
          <span className="badge cobalt">Solo con invitación</span>
        </header>

        <main className="shell">
          <div className="auth-wrap">
            <div className="page-head">
              <div>
                <h1 className="page-title">
                  {authMode === 'login' ? 'Entrar al estudio' : 'Activar invitación'}
                </h1>
                <p className="page-sub">
                  {authMode === 'login'
                    ? 'Accede a tu catálogo, descargas MP3 y fonoteca offline.'
                    : 'Regístrate usando un código de invitación generado por el administrador.'}
                </p>
              </div>
            </div>

            <div className="card">
              <div className="auth-tabs" role="tablist">
                <button
                  type="button"
                  className={authMode === 'login' ? 'active' : ''}
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError('');
                  }}
                >
                  Iniciar sesión
                </button>
                <button
                  type="button"
                  className={authMode === 'register' ? 'active' : ''}
                  onClick={() => {
                    setAuthMode('register');
                    setAuthError('');
                  }}
                >
                  Tengo código de invitación
                </button>
              </div>

              {authError && <div className="alert err">{authError}</div>}

              {authMode === 'login' ? (
                <form className="form" onSubmit={handleAuthSubmit}>
                  <div className="field">
                    <label htmlFor="signin-username">Usuario</label>
                    <input
                      id="signin-username"
                      name="username"
                      type="text"
                      autoComplete="username"
                      enterKeyHint="next"
                      required
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      placeholder="tu_usuario"
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="current-password">Contraseña</label>
                    <div className="input-row">
                      <input
                        id="current-password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        enterKeyHint="done"
                        required
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        className="btn secondary sm"
                        onClick={() => setShowPassword(v => !v)}
                      >
                        {showPassword ? 'Ocultar' : 'Mostrar'}
                      </button>
                    </div>
                  </div>

                  <button type="submit" className="btn" disabled={authBusy}>
                    {authBusy ? 'Verificando…' : 'Entrar a MyMusicAnywhere'}
                  </button>
                </form>
              ) : (
                <form className="form" onSubmit={handleAuthSubmit}>
                  <div className="field">
                    <label htmlFor="invite-code">Código de invitación</label>
                    <input
                      id="invite-code"
                      name="inviteCode"
                      type="text"
                      autoCapitalize="characters"
                      enterKeyHint="next"
                      required
                      value={inviteCode}
                      onChange={e => setInviteCode(e.target.value.toUpperCase())}
                      placeholder="MMA-XXXX-XXXX"
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="signup-username">Elige tu usuario</label>
                    <input
                      id="signup-username"
                      name="username"
                      type="text"
                      autoComplete="username"
                      enterKeyHint="next"
                      minLength={3}
                      maxLength={32}
                      required
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      placeholder="nuevo_usuario"
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="new-password">Crea una contraseña (mín. 6 caracteres)</label>
                    <div className="input-row">
                      <input
                        id="new-password"
                        name="new-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        enterKeyHint="done"
                        minLength={6}
                        required
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        className="btn secondary sm"
                        onClick={() => setShowPassword(v => !v)}
                      >
                        {showPassword ? 'Ocultar' : 'Mostrar'}
                      </button>
                    </div>
                  </div>

                  <button type="submit" className="btn" disabled={authBusy}>
                    {authBusy ? 'Activando cuenta…' : 'Crear cuenta e ingresar'}
                  </button>
                </form>
              )}
            </div>
          </div>
        </main>
      </>
    );
  }

  // ==================== AUTHENTICATED APP SHELL ====================
  const initial = (user.username || 'U').trim().charAt(0).toUpperCase();

  return (
    <>
      <header className="site-header">
        <button type="button" className="brand" onClick={() => setActiveTab('explore')}>
          <img src="/icon.svg" alt="MyMusicAnywhere" className="brand-logo" />
          <div className="brand-text">
            <span className="brand-name">MyMusicAnywhere</span>
            <span className="brand-sub">Studio &amp; Offline Player</span>
          </div>
        </button>

        <nav className="site-nav" aria-label="Principal">
          <button
            type="button"
            className={activeTab === 'explore' ? 'active' : ''}
            onClick={() => setActiveTab('explore')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
            </svg>
            <span>Explorar</span>
          </button>

          <button
            type="button"
            className={activeTab === 'library' ? 'active' : ''}
            onClick={() => setActiveTab('library')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z" />
            </svg>
            <span>Librería</span>
            {likedTracks.length > 0 && <span className="nav-count">{likedTracks.length}</span>}
          </button>

          <button
            type="button"
            className={activeTab === 'files' ? 'active' : ''}
            onClick={() => setActiveTab('files')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
            <span>Servidor</span>
            {libraryFiles.length > 0 && <span className="nav-count">{libraryFiles.length}</span>}
          </button>

          {user.is_admin && (
            <button
              type="button"
              className={activeTab === 'admin' ? 'active' : ''}
              onClick={() => {
                setActiveTab('admin');
                fetchAdminData();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4z" />
              </svg>
              <span>Admin</span>
            </button>
          )}
        </nav>

        <div className="account" ref={accountRef}>
          <button
            type="button"
            className="account-btn"
            onClick={() => setAccountOpen(o => !o)}
            aria-expanded={accountOpen}
          >
            <span className="account-avatar">{initial}</span>
            <span className="account-name">{user.username}</span>
          </button>

          {accountOpen && (
            <div className="account-menu" role="menu">
              <div className="account-meta">
                <span className="account-user">@{user.username}</span>
                <span className={`badge ${user.is_admin ? 'cobalt' : 'mint'}`}>
                  {user.is_admin ? 'Admin' : 'Miembro'}
                </span>
              </div>

              {user.is_admin && (
                <button
                  type="button"
                  className="account-item"
                  onClick={() => {
                    setActiveTab('admin');
                    setAccountOpen(false);
                    fetchAdminData();
                  }}
                >
                  Panel de invitaciones
                </button>
              )}

              {deferredPrompt && (
                <button type="button" className="account-item" onClick={handleInstallPwa}>
                  Instalar app en dispositivo
                </button>
              )}

              <button type="button" className="account-item danger" onClick={handleLogout}>
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="shell">
        {/* ==================== TAB 1: EXPLORAR ==================== */}
        {activeTab === 'explore' && (
          <section>
            <div className="page-head">
              <div>
                <h1 className="page-title">Catálogo musical</h1>
                <p className="page-sub">
                  Busca por canción, álbum o artista, escucha el adelanto o descarga el MP3 directo a tu dispositivo.
                </p>
              </div>
              {deferredPrompt && (
                <button type="button" className="btn secondary sm" onClick={handleInstallPwa}>
                  + Instalar PWA
                </button>
              )}
            </div>

            <form
              className="search-bar"
              onSubmit={e => {
                e.preventDefault();
                searchTracks(query);
              }}
            >
              <input
                type="search"
                className="search-input"
                enterKeyHint="search"
                placeholder="Buscar canción, artista o álbum…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <button type="submit" className="btn" disabled={loading}>
                {loading ? 'Buscando…' : 'Buscar'}
              </button>
            </form>

            <div className="toolbar">
              <div className="toolbar-group">
                {feedInfo.mode === 'recommended' ? (
                  <span className="badge coral">
                    ♥ Recomendado por tu gusto: {feedInfo.label}
                  </span>
                ) : feedInfo.mode === 'random' ? (
                  <span className="badge cobalt">
                    🎲 Selección aleatoria: {feedInfo.label}
                  </span>
                ) : (
                  <span className="badge neutral">
                    🔎 Búsqueda: {feedInfo.label}
                  </span>
                )}

                {getLikedCategories().slice(0, 3).map(cat => (
                  <button
                    key={cat}
                    type="button"
                    className="btn secondary sm"
                    onClick={() => searchTracks(cat, { mode: 'recommended', label: cat })}
                  >
                    ♥ {cat}
                  </button>
                ))}
              </div>

              <div className="toolbar-group">
                {likedTracks.length > 0 && (
                  <button
                    type="button"
                    className="btn secondary sm"
                    onClick={() => loadRecommendedOrRandomFeed(likedTracks, false)}
                  >
                    ✨ Para mí
                  </button>
                )}
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={() => loadRecommendedOrRandomFeed(likedTracks, true)}
                >
                  🎲 Música aleatoria
                </button>
              </div>
            </div>

            <div className="grid">
              {results.map((track, idx) => {
                const dl = downloads[track.id];
                const liked = isLiked(track.id);
                const isCurrent = currentTrack?.id === track.id;

                return (
                  <article key={track.id} className={`card item ${isCurrent ? 'playing' : ''}`}>
                    <div className="item-head">
                      <div className="item-media">
                        <div
                          className="artwork-wrap"
                          onClick={() => playFromList(results, idx)}
                          title="Reproducir pista"
                        >
                          <img src={track.artwork} alt={track.title} loading="lazy" />
                          <div className="artwork-play-overlay">
                            {isCurrent && isPlaying ? '⏸' : '▶'}
                          </div>
                        </div>
                        <div className="item-info">
                          <div className="item-title">{track.title}</div>
                          <div className="item-sub">
                            {track.artist} {track.album ? `· ${track.album}` : ''}
                          </div>
                        </div>
                      </div>

                      <div className="item-actions">
                        <button
                          type="button"
                          className={`btn heart ${liked ? 'liked' : ''}`}
                          onClick={() => toggleLike(track)}
                          title={liked ? 'Quitar de Librería' : 'Guardar en Librería'}
                        >
                          {liked ? '♥ Guardada' : '♡ Favorito'}
                        </button>

                        {dl?.status === 'downloading' ? (
                          <span className="badge amber">
                            Extrayendo {Math.round(dl.progress || 0)}%
                          </span>
                        ) : dl?.status === 'ready' ? (
                          <a
                            href={`/api/stream?file=${encodeURIComponent(dl.filename)}&download=1`}
                            download={dl.filename}
                            className="btn secondary sm"
                          >
                            ⬇ Guardar MP3
                          </a>
                        ) : (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => startDownload(track)}
                          >
                            ⬇ MP3
                          </button>
                        )}
                      </div>
                    </div>

                    {dl?.status === 'downloading' && (
                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{ width: `${dl.progress || 8}%` }}
                        />
                      </div>
                    )}

                    <dl className="meta">
                      <div>
                        <dt>Duración</dt>
                        <dd>{track.duration || '—'}</dd>
                      </div>
                      <div>
                        <dt>Género</dt>
                        <dd>{track.genre || 'Música'}</dd>
                      </div>
                      <div>
                        <dt>Estado</dt>
                        <dd>
                          {dl?.status === 'ready'
                            ? 'MP3 listo'
                            : liked
                            ? 'En tu librería'
                            : 'Streaming 30s'}
                        </dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* ==================== TAB 2: LIBRERÍA (FAVORITOS & OFFLINE) ==================== */}
        {activeTab === 'library' && (
          <section>
            <div className="page-head">
              <div>
                <h1 className="page-title">Mi librería</h1>
                <p className="page-sub">
                  Tus pistas con corazón, sincronizadas en caché offline del navegador y listas para bucle o aleatorio.
                </p>
              </div>
            </div>

            <div className="toolbar">
              <div className="toolbar-group">
                <button
                  type="button"
                  className="btn sm"
                  disabled={likedTracks.length === 0}
                  onClick={() => playFromList(likedTracks, 0)}
                >
                  ▶ Reproducir todo
                </button>
                <button
                  type="button"
                  className={`btn secondary sm ${shuffle ? 'cobalt' : ''}`}
                  onClick={() => setShuffle(s => !s)}
                >
                  🔀 Aleatorio: {shuffle ? 'ON' : 'OFF'}
                </button>
                <button type="button" className="btn secondary sm" onClick={cycleRepeatMode}>
                  🔁 Bucle:{' '}
                  {repeatMode === 'off' ? 'No' : repeatMode === 'all' ? 'Todo' : '1 pista'}
                </button>
              </div>

              <button
                type="button"
                className="btn secondary sm"
                disabled={likedTracks.length === 0 || syncingAll}
                onClick={downloadAllLikedForOffline}
              >
                {syncingAll ? 'Sincronizando…' : '⬇ Descargar todo (Offline + MP3)'}
              </button>
            </div>

            {likedTracks.length === 0 ? (
              <div className="empty">
                <div className="empty-title">Tu librería está vacía</div>
                <p>
                  Pulsa <strong>♡ Favorito</strong> en cualquier canción del buscador para guardarla aquí.
                </p>
              </div>
            ) : (
              <div className="grid">
                {likedTracks.map((track, idx) => {
                  const dl = downloads[track.id];
                  const streamUrl =
                    track.streamUrl ||
                    (track.filename
                      ? `/api/stream?file=${encodeURIComponent(track.filename)}`
                      : null) ||
                    (dl?.filename ? `/api/stream?file=${encodeURIComponent(dl.filename)}` : null);
                  const filename = track.filename || dl?.filename;
                  const isOfflineReady = streamUrl && offlineUrls[streamUrl];
                  const isCurrent = currentTrack?.id === track.id;

                  return (
                    <article key={track.id} className={`card item ${isCurrent ? 'playing' : ''}`}>
                      <div className="item-head">
                        <div className="item-media">
                          <div
                            className="artwork-wrap"
                            onClick={() => playFromList(likedTracks, idx)}
                          >
                            <img src={track.artwork} alt={track.title} loading="lazy" />
                            <div className="artwork-play-overlay">
                              {isCurrent && isPlaying ? '⏸' : '▶'}
                            </div>
                          </div>
                          <div className="item-info">
                            <div className="item-title">{track.title}</div>
                            <div className="item-sub">{track.artist}</div>
                          </div>
                        </div>

                        <div className="item-actions">
                          {isOfflineReady ? (
                            <span className="badge mint">✓ Offline</span>
                          ) : dl?.status === 'downloading' ? (
                            <span className="badge amber">
                              {Math.round(dl.progress || 0)}%
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => startDownload(track)}
                            >
                              ⬇ Obtener MP3
                            </button>
                          )}

                          {filename && (
                            <a
                              href={`/api/stream?file=${encodeURIComponent(filename)}&download=1`}
                              download={filename}
                              className="btn secondary sm"
                            >
                              💾 Archivo
                            </a>
                          )}

                          <button
                            type="button"
                            className="btn heart liked"
                            onClick={() => toggleLike(track)}
                            title="Quitar de Librería"
                          >
                            ♥
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* ==================== TAB 3: ARCHIVOS EN SERVIDOR ==================== */}
        {activeTab === 'files' && (
          <section>
            <div className="page-head">
              <div>
                <h1 className="page-title">Archivos MP3 en servidor</h1>
                <p className="page-sub">
                  Pistas extraídas en el servidor listas para reproducir o bajar a tu teléfono o PC.
                </p>
              </div>
              <button type="button" className="btn secondary sm" onClick={fetchLibraryFiles}>
                Actualizar lista
              </button>
            </div>

            {libraryFiles.length === 0 ? (
              <div className="empty">
                <div className="empty-title">Sin archivos MP3 todavía</div>
                <p>Descarga cualquier canción desde Explorar o Librería.</p>
              </div>
            ) : (
              <div className="grid">
                {libraryFiles.map((file, idx) => {
                  const isOffline = offlineUrls[file.url];
                  const formattedList = libraryFiles.map(f => ({
                    id: f.filename,
                    title: f.filename.replace(/\.mp3$/i, ''),
                    artist: `${f.sizeMB} MB · Servidor`,
                    artwork: '/icon.svg',
                    filename: f.filename,
                    streamUrl: f.url
                  }));

                  return (
                    <article key={file.filename} className="card item">
                      <div className="item-head">
                        <div className="item-media">
                          <div
                            className="artwork-wrap"
                            onClick={() => playFromList(formattedList, idx)}
                          >
                            <img src="/icon.svg" alt="MP3" />
                            <div className="artwork-play-overlay">▶</div>
                          </div>
                          <div className="item-info">
                            <div className="item-title">{file.filename.replace(/\.mp3$/i, '')}</div>
                            <div className="item-sub">{file.sizeMB} MB · Audio MP3</div>
                          </div>
                        </div>

                        <div className="item-actions">
                          <button
                            type="button"
                            className="btn secondary sm"
                            onClick={() => saveUrlToOfflineCache(file.url, file.filename)}
                          >
                            {isOffline ? '✓ En caché' : '⚡ Cachear'}
                          </button>
                          <a
                            href={`${file.url}&download=1`}
                            download={file.filename}
                            className="btn sm"
                          >
                            ⬇ Descargar
                          </a>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* ==================== TAB 4: ADMIN PANEL (SOLO ADMIN) ==================== */}
        {activeTab === 'admin' && user.is_admin && (
          <section>
            <div className="page-head">
              <div>
                <h1 className="page-title">Administración e invitaciones</h1>
                <p className="page-sub">
                  Genera códigos de invitación para nuevos usuarios y supervisa el espacio en disco del VPS.
                </p>
              </div>
            </div>

            <div className="grid three" style={{ marginBottom: 20 }}>
              <div className="stat">
                <div className="stat-label">Usuarios registrados</div>
                <div className="stat-value">{adminData.users.length}</div>
                <div className="stat-hint">
                  {adminData.users.filter(u => u.active).length} cuentas activas
                </div>
              </div>

              <div className="stat">
                <div className="stat-label">Códigos de invitación</div>
                <div className="stat-value">
                  {adminData.invites.filter(i => !i.revoked && i.used_count < i.max_uses).length}
                </div>
                <div className="stat-hint">Disponibles para usar</div>
              </div>

              <div className="stat">
                <div className="stat-label">Almacenamiento MP3</div>
                <div className="stat-value">
                  {adminData.storage
                    ? `${adminData.storage.usedMB} / ${adminData.storage.maxMB} MB`
                    : '—'}
                </div>
                <div className="stat-hint">
                  {adminData.storage
                    ? `${adminData.storage.fileCount} archivos (limpieza FIFO automática)`
                    : 'Calculando…'}
                </div>
              </div>
            </div>

            <div className="card">
              <h2 className="section-title" style={{ marginTop: 0 }}>
                <span>Generar nuevo código de invitación</span>
              </h2>
              {adminMsg && <div className="alert ok">{adminMsg}</div>}
              <form className="form" onSubmit={handleCreateInvite}>
                <div className="grid two">
                  <div className="field">
                    <label htmlFor="invite-label">Etiqueta / Para quién es</label>
                    <input
                      id="invite-label"
                      type="text"
                      placeholder="Ej. Amigos uni, Dispositivo móvil…"
                      value={inviteLabel}
                      onChange={e => setInviteLabel(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="invite-uses">Límite de registros permitidos</label>
                    <input
                      id="invite-uses"
                      type="number"
                      min={1}
                      max={100}
                      value={inviteMaxUses}
                      onChange={e => setInviteMaxUses(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <button type="submit" className="btn">
                    + Generar código de invitación
                  </button>
                </div>
              </form>
            </div>

            <h2 className="section-title">
              <span>Códigos de invitación</span>
              <span className="count">{adminData.invites.length}</span>
            </h2>

            {adminData.invites.length === 0 ? (
              <div className="empty">
                <div className="empty-title">No hay códigos creados todavía</div>
                <p>Usa el formulario superior para crear tu primer código de invitación.</p>
              </div>
            ) : (
              <div className="grid">
                {adminData.invites.map(inv => {
                  const exhausted = inv.used_count >= inv.max_uses;
                  return (
                    <article key={inv.code} className="card item">
                      <div className="item-head">
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span className="code-pill">{inv.code}</span>
                            <span
                              className={`badge ${
                                inv.revoked ? 'coral' : exhausted ? 'amber' : 'mint'
                              }`}
                            >
                              {inv.revoked
                                ? 'Revocado'
                                : exhausted
                                ? 'Agotado'
                                : 'Disponible'}
                            </span>
                          </div>
                          <div className="item-sub" style={{ marginTop: 6 }}>
                            Etiqueta: <strong>{inv.label}</strong>
                          </div>
                        </div>

                        <div className="item-actions">
                          <button
                            type="button"
                            className="btn secondary sm"
                            onClick={() => copyInviteCode(inv.code)}
                          >
                            {copiedCode === inv.code ? '✓ Copiado' : 'Copiar código'}
                          </button>
                          <button
                            type="button"
                            className="btn secondary sm"
                            onClick={() =>
                              handleAdminAction({ action: 'revoke_invite', code: inv.code })
                            }
                          >
                            {inv.revoked ? 'Reactivar' : 'Revocar'}
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() =>
                              handleAdminAction({ action: 'delete_invite', code: inv.code })
                            }
                          >
                            Eliminar
                          </button>
                        </div>
                      </div>

                      <dl className="meta">
                        <div>
                          <dt>Usos</dt>
                          <dd>
                            {inv.used_count} / {inv.max_uses}
                          </dd>
                        </div>
                        <div>
                          <dt>Usado por</dt>
                          <dd>
                            {inv.used_by?.length
                              ? inv.used_by.map(u => `@${u.username}`).join(', ')
                              : 'Nadie aún'}
                          </dd>
                        </div>
                        <div>
                          <dt>Creado</dt>
                          <dd>{new Date(inv.created_at).toLocaleDateString('es')}</dd>
                        </div>
                      </dl>
                    </article>
                  );
                })}
              </div>
            )}

            <h2 className="section-title">
              <span>Usuarios registrados</span>
              <span className="count">{adminData.users.length}</span>
            </h2>

            <div className="grid">
              {adminData.users.map(u => (
                <article key={u.id} className="card item">
                  <div className="item-head">
                    <div>
                      <div className="item-title">@{u.username}</div>
                      <div className="item-sub">
                        {u.is_admin
                          ? 'Administrador principal'
                          : `Invitado con código: ${u.invited_by_code || '—'}`}
                      </div>
                    </div>
                    <div className="item-actions">
                      <span className={`badge ${u.is_admin ? 'cobalt' : u.active ? 'mint' : 'coral'}`}>
                        {u.is_admin ? 'Admin' : u.active ? 'Activo' : 'Suspendido'}
                      </span>
                      {!u.is_admin && (
                        <button
                          type="button"
                          className="btn secondary sm"
                          onClick={() =>
                            handleAdminAction({ action: 'toggle_user', userId: u.id })
                          }
                        >
                          {u.active ? 'Suspender' : 'Activar'}
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* ==================== EDITORIAL FLOATING PLAYER DOCK ==================== */}
      {currentTrack && (
        <div className="player-dock">
          <div className="player-main">
            <div className="player-track">
              <img src={currentTrack.artwork || '/icon.svg'} alt={currentTrack.title} />
              <div style={{ minWidth: 0 }}>
                <div className="player-track-title">{currentTrack.title}</div>
                <div className="player-track-sub">{currentTrack.artist}</div>
              </div>
            </div>

            <div className="player-controls">
              <button
                type="button"
                className={`ctrl-btn ${shuffle ? 'active' : ''}`}
                onClick={() => setShuffle(s => !s)}
                title="Aleatorio"
              >
                🔀
              </button>
              <button type="button" className="ctrl-btn" onClick={playPrev} title="Anterior">
                ⏮
              </button>
              <button
                type="button"
                className="ctrl-btn play-main"
                onClick={togglePlayPause}
                title={isPlaying ? 'Pausar' : 'Reproducir'}
              >
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button type="button" className="ctrl-btn" onClick={playNext} title="Siguiente">
                ⏭
              </button>
              <button
                type="button"
                className={`ctrl-btn ${repeatMode !== 'off' ? 'active' : ''}`}
                onClick={cycleRepeatMode}
                title="Modo bucle"
              >
                {repeatMode === 'one' ? '🔂' : '🔁'}
              </button>
            </div>
          </div>

          <div className="player-seek">
            <span>{formatSec(progress)}</span>
            <input
              type="range"
              min="0"
              max={duration || 100}
              value={progress}
              onChange={e => {
                const val = Number(e.target.value);
                setProgress(val);
                if (audioRef.current) audioRef.current.currentTime = val;
              }}
            />
            <span>{formatSec(duration)}</span>
          </div>

          <audio
            ref={audioRef}
            onTimeUpdate={e => setProgress(e.currentTarget.currentTime)}
            onLoadedMetadata={e => setDuration(e.currentTarget.duration)}
            onEnded={handleTrackEnded}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />
        </div>
      )}
    </>
  );
}
