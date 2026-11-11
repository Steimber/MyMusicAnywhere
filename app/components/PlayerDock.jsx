'use client';

import PlayerScrubber from './PlayerScrubber';
import { BrandMark, Icon } from './Icons';
import { DEFAULT_TRACK_COVER, isPlaceholderCover } from '../hooks/trackUtils';

export function AppTopbar({
  user,
  isOffline,
  activeTab,
  setActiveTab,
  likedCount,
  offlineCount,
  accountRef,
  accountOpen,
  setAccountOpen,
  fetchAdminData,
  deferredPrompt,
  handleInstallPwa,
  handleLogout
}) {
  const initial = (user.username || 'U').trim().charAt(0).toUpperCase();

  return (
    <header className="topbar">
      <button
        type="button"
        className="brand"
        onClick={() => setActiveTab(isOffline ? 'library' : 'explore')}
        aria-label="mineral music, inicio"
      >
        <BrandMark />
        <span className="brand-word" aria-hidden="true">
          mineral
          <small className="brand-sub">music</small>
        </span>
      </button>

      <nav className="topbar-nav" aria-label="Principal">
        <button
          type="button"
          className={`nav-link ${activeTab === 'explore' ? 'active' : ''} ${
            isOffline ? 'offline-nav-item' : ''
          }`.trim()}
          aria-current={activeTab === 'explore' ? 'page' : undefined}
          onClick={() => setActiveTab('explore')}
        >
          <Icon name="search" size={16} />
          <span>Explorar</span>
        </button>

        <button
          type="button"
          className={`nav-link ${activeTab === 'foryou' ? 'active' : ''}`.trim()}
          aria-current={activeTab === 'foryou' ? 'page' : undefined}
          onClick={() => setActiveTab('foryou')}
        >
          <Icon name="sparkles" size={16} />
          <span>Para ti</span>
        </button>

        <button
          type="button"
          className={`nav-link ${activeTab === 'library' ? 'active' : ''}`}
          aria-current={activeTab === 'library' ? 'page' : undefined}
          onClick={() => setActiveTab('library')}
        >
          <Icon name="heart" size={16} />
          <span>Biblioteca</span>
          {likedCount + offlineCount > 0 && (
            <span className="nav-badge">{likedCount || offlineCount}</span>
          )}
        </button>
      </nav>

      <div className="topbar-right">
        <div className="account" ref={accountRef}>
          <button
            type="button"
            className="account-btn"
            onClick={() => setAccountOpen(o => !o)}
            aria-expanded={accountOpen}
            aria-label="Cuenta y ajustes"
            title={user.username}
          >
            <span className="account-avatar">{initial}</span>
          </button>

          {accountOpen && (
            <div className="account-menu" role="menu">
              <div className="account-meta">
                <span className="account-user">@{user.username}</span>
                <span className={`badge ${user.is_admin ? 'lavender' : 'lime'}`}>
                  {user.is_admin ? 'Admin' : 'Miembro'}
                </span>
              </div>

              <button
                type="button"
                className={`account-item ${activeTab === 'settings' ? 'active' : ''}`.trim()}
                onClick={() => {
                  setActiveTab('settings');
                  setAccountOpen(false);
                }}
              >
                <Icon name="settings" size={16} />
                <span>Ajustes</span>
              </button>

              {user.is_admin && (
                <button
                  type="button"
                  className={`account-item ${activeTab === 'admin' ? 'active' : ''} ${
                    isOffline ? 'offline-section-disabled' : ''
                  }`.trim()}
                  onClick={() => {
                    setActiveTab('admin');
                    setAccountOpen(false);
                    if (!isOffline) fetchAdminData();
                  }}
                >
                  <Icon name="shield" size={16} />
                  <span>Admin</span>
                </button>
              )}

              {deferredPrompt && (
                <button type="button" className="account-item" onClick={handleInstallPwa}>
                  <Icon name="smartphone" size={16} />
                  <span>Instalar app</span>
                </button>
              )}

              <div className="account-menu-last">
                <button type="button" className="account-item danger" onClick={handleLogout}>
                  <span>Cerrar sesión</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export default function PlayerDock({
  currentTrack,
  audioRef,
  isLiked,
  toggleLike,
  shuffle,
  toggleShuffle,
  playPrev,
  isPlaying,
  setIsPlaying,
  togglePlayPause,
  playNext,
  repeatMode,
  cycleRepeatMode,
  handlePlaybackTimeTick,
  currentIndexRef,
  queueRef,
  lastWarmedKeyRef,
  preloadUpcomingQueueBlobs,
  isPlayingRef,
  playInFlightRef,
  consecutivePlayFailuresRef,
  handleTrackEnded,
  activeTab,
  setActiveTab,
  isOffline
}) {
  return (
    <>
      {/* ==================== COMPACT FLOATING MINI-PLAYER DOCK ==================== */}
      {currentTrack && (
        <div className="player-dock">
          <PlayerScrubber audioRef={audioRef} trackKey={currentTrack.id} />

          <div className="player-main">
            <div className="player-track">
              <img
                src={
                  isPlaceholderCover(currentTrack.artwork)
                    ? DEFAULT_TRACK_COVER
                    : currentTrack.artwork
                }
                alt=""
                onError={e => {
                  e.currentTarget.src = DEFAULT_TRACK_COVER;
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div className="player-track-title">{currentTrack.title}</div>
                <div className="player-track-sub">{currentTrack.artist}</div>
              </div>
            </div>

            <div className="player-controls">
              <button
                type="button"
                className={`ctrl-btn ${isLiked(currentTrack.id) ? 'active' : ''}`}
                onClick={() => toggleLike(currentTrack)}
                title="Favorito"
              >
                <Icon name={isLiked(currentTrack.id) ? 'heart-fill' : 'heart'} size={15} />
              </button>
              <button
                type="button"
                className={`ctrl-btn ${shuffle ? 'active' : ''}`}
                onClick={toggleShuffle}
                title="Aleatorio inteligente"
              >
                <Icon name="shuffle" size={15} />
              </button>
              <button type="button" className="ctrl-btn" onClick={playPrev} title="Anterior">
                <Icon name="skip-back" size={15} />
              </button>
              <button
                type="button"
                className="ctrl-btn play-main"
                onClick={togglePlayPause}
                title={isPlaying ? 'Pausar' : 'Reproducir'}
              >
                <Icon name={isPlaying ? 'pause' : 'play'} size={15} />
              </button>
              <button type="button" className="ctrl-btn" onClick={playNext} title="Siguiente">
                <Icon name="skip-forward" size={15} />
              </button>
              <button
                type="button"
                className={`ctrl-btn ${repeatMode !== 'off' ? 'active' : ''}`}
                onClick={cycleRepeatMode}
                title="Repetir"
              >
                <Icon name={repeatMode === 'one' ? 'repeat-1' : 'repeat'} size={15} />
              </button>
            </div>
          </div>
        </div>
      )}

      <audio
        ref={audioRef}
        preload="auto"
        playsInline
        onTimeUpdate={e => {
          const cur = e.currentTarget.currentTime;
          handlePlaybackTimeTick(cur, e.currentTarget.duration);
          const warmKey = `${currentIndexRef.current}_${queueRef.current.length}`;
          if (cur > 0.5 && lastWarmedKeyRef.current !== warmKey) {
            lastWarmedKeyRef.current = warmKey;
            preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
          }
        }}
        onLoadedMetadata={e => {
          const audioEl = e.currentTarget;
          const dur = audioEl.duration;
          if (isPlayingRef.current && audioEl.paused && !playInFlightRef.current) {
            playInFlightRef.current = true;
            audioEl
              .play()
              .then(() => {
                playInFlightRef.current = false;
                consecutivePlayFailuresRef.current = 0;
                isPlayingRef.current = true;
                setIsPlaying(true);
                preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
              })
              .catch(() => {
                playInFlightRef.current = false;
                const stillPlaying = !audioEl.paused;
                isPlayingRef.current = stillPlaying;
                setIsPlaying(stillPlaying);
              });
          }
          if (
            typeof navigator !== 'undefined' &&
            'mediaSession' in navigator &&
            typeof navigator.mediaSession.setPositionState === 'function' &&
            dur > 0 &&
            Number.isFinite(dur)
          ) {
            try {
              navigator.mediaSession.setPositionState({
                duration: dur,
                playbackRate: audioEl.paused ? 0 : audioEl.playbackRate || 1,
                position: Math.min(dur, audioEl.currentTime || 0)
              });
            } catch {}
          }
        }}
        onEnded={handleTrackEnded}
        onError={() => {
          playInFlightRef.current = false;
          if (
            queueRef.current.length > 1 &&
            consecutivePlayFailuresRef.current < Math.min(queueRef.current.length, 8)
          ) {
            consecutivePlayFailuresRef.current += 1;
            playNext();
          } else {
            isPlayingRef.current = false;
            setIsPlaying(false);
          }
        }}
        onPlay={e => {
          const audioEl = e.currentTarget;
          playInFlightRef.current = false;
          consecutivePlayFailuresRef.current = 0;
          isPlayingRef.current = true;
          setIsPlaying(true);
          preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
          if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
            try {
              navigator.mediaSession.playbackState = 'playing';
              const dur = audioEl.duration;
              if (
                typeof navigator.mediaSession.setPositionState === 'function' &&
                dur > 0 &&
                Number.isFinite(dur)
              ) {
                navigator.mediaSession.setPositionState({
                  duration: dur,
                  playbackRate: audioEl.playbackRate || 1,
                  position: Math.min(dur, audioEl.currentTime || 0)
                });
              }
            } catch {}
          }
        }}
        onPause={e => {
          const audioEl = e.currentTarget;
          if (audioEl.ended || playInFlightRef.current) return;
          isPlayingRef.current = false;
          setIsPlaying(false);
          if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
            try {
              navigator.mediaSession.playbackState = 'paused';
              const dur = audioEl.duration;
              if (
                typeof navigator.mediaSession.setPositionState === 'function' &&
                dur > 0 &&
                Number.isFinite(dur)
              ) {
                navigator.mediaSession.setPositionState({
                  duration: dur,
                  playbackRate: 0,
                  position: Math.min(dur, audioEl.currentTime || 0)
                });
              }
            } catch {}
          }
        }}
      />

      {/* ==================== MOBILE BOTTOM NAV (MINERAL TAREAS STYLE) ==================== */}
      <nav className="bottom-nav" aria-label="Principal">
        <button
          type="button"
          className={`${activeTab === 'explore' ? 'active' : ''} ${
            isOffline ? 'offline-nav-item' : ''
          }`.trim()}
          aria-current={activeTab === 'explore' ? 'page' : undefined}
          onClick={() => setActiveTab('explore')}
        >
          <Icon name="search" size={18} />
          <span>Explorar</span>
        </button>

        <button
          type="button"
          className={activeTab === 'foryou' ? 'active' : ''}
          aria-current={activeTab === 'foryou' ? 'page' : undefined}
          onClick={() => setActiveTab('foryou')}
        >
          <Icon name="sparkles" size={18} />
          <span>Para ti</span>
        </button>

        <button
          type="button"
          className={activeTab === 'library' ? 'active' : ''}
          aria-current={activeTab === 'library' ? 'page' : undefined}
          onClick={() => setActiveTab('library')}
        >
          <Icon name="heart" size={18} />
          <span>Biblioteca</span>
        </button>
      </nav>
    </>
  );
}
