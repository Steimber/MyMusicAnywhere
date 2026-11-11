import { useEffect } from 'react';
import { buildSmartShuffleOrder, getShuffleTrackKey } from '../../lib/shuffle';
import { getHourBucketName } from '../../lib/listening-shared';
import { DEFAULT_TRACK_COVER, isPlaceholderCover } from './trackUtils';

export function useAudioPlayer({
  apiRef,
  isOffline,
  offlineCatalog,
  queue,
  setQueue,
  currentIndex,
  setCurrentIndex,
  currentTrack,
  isPlaying,
  setIsPlaying,
  setOptimisticTrack,
  shuffle,
  setShuffle,
  repeatMode,
  setRepeatMode,
  audioRef,
  shuffleStateRef,
  recentPlayedKeysRef,
  queueRef,
  currentIndexRef,
  isPlayingRef,
  shuffleRef,
  repeatModeRef,
  playbackSessionRef,
  inflightBlobPromisesRef,
  warmingInProgressRef,
  playInFlightRef,
  consecutivePlayFailuresRef,
  lastDirectPlayRef,
  recordListeningDeltaSync,
  getTrackStreamUrl,
  getCachedBlobUrlForTrack,
  getSyncPlayableSource,
  resolvePlayableSource,
  isTrackAvailableOffline
}) {
  function parseTrackDurationHintSec(track) {
    if (!track) return 0;
    const direct = Number(track.durationSec);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const str = String(track.duration || '').trim();
    const match = str.match(/^(\d+):(\d{2})$/);
    if (match) {
      return Number(match[1]) * 60 + Number(match[2]);
    }
    return 0;
  }

  function finalizeActivePlaybackSession(didComplete = false) {
    const sess = playbackSessionRef.current;
    if (!sess || !sess.trackId) return;
    const tid = sess.trackId;
    const now = Date.now();

    if (didComplete) {
      const needPlay = !sess.playCounted;
      const needComplete = !sess.completeCounted;
      sess.playCounted = true;
      sess.completeCounted = true;
      if (needPlay || needComplete) {
        recordListeningDeltaSync(tid, {
          plays: needPlay ? 1 : 0,
          completes: needComplete ? 1 : 0,
          lastPlayedAt: now,
          ...(needPlay ? { hourBucket: sess.hourBucket } : {})
        });
      }
      return;
    }

    // Track switched before ending: count as skip if playback actually started (>0.25s) and stayed <25%
    if (!sess.playCounted && !sess.completeCounted && !sess.skipCounted) {
      const playedAny = sess.listenedSec > 0.25 || sess.lastTimeSec > 0.25;
      if (playedAny) {
        const dur = sess.durationSec;
        const skippedEarly = dur > 0 ? sess.listenedSec / dur < 0.25 : sess.listenedSec < 15;
        if (skippedEarly) {
          sess.skipCounted = true;
          recordListeningDeltaSync(tid, { skips: 1 });
        }
      }
    }
  }

  function beginPlaybackSessionForTrack(track) {
    if (!track || track.id == null) {
      playbackSessionRef.current = {
        trackId: '',
        lastTimeSec: 0,
        listenedSec: 0,
        durationSec: 0,
        playCounted: false,
        completeCounted: false,
        skipCounted: false,
        hourBucket: getHourBucketName(new Date())
      };
      return;
    }
    playbackSessionRef.current = {
      trackId: String(track.id),
      lastTimeSec: 0,
      listenedSec: 0,
      durationSec: parseTrackDurationHintSec(track),
      playCounted: false,
      completeCounted: false,
      skipCounted: false,
      hourBucket: getHourBucketName(new Date())
    };
  }

  function handlePlaybackTimeTick(curSec, rawDurationSec) {
    const sess = playbackSessionRef.current;
    if (!sess || !sess.trackId) return;
    if (Number.isFinite(rawDurationSec) && rawDurationSec > 0) {
      sess.durationSec = rawDurationSec;
    }
    const dt = curSec - sess.lastTimeSec;
    if (dt > 0 && dt < 2.5) {
      sess.listenedSec += dt;
    }
    sess.lastTimeSec = curSec;

    if (!sess.playCounted) {
      const reached30s = sess.listenedSec >= 30;
      const reachedHalf = sess.durationSec > 0 && sess.listenedSec / sess.durationSec >= 0.5;
      if (reached30s || reachedHalf) {
        sess.playCounted = true;
        recordListeningDeltaSync(sess.trackId, {
          plays: 1,
          lastPlayedAt: Date.now(),
          hourBucket: sess.hourBucket
        });
      }
    }
  }

  function preloadUpcomingQueueBlobs(list = queueRef.current, fromIdx = currentIndexRef.current) {
    if (!Array.isArray(list) || list.length === 0) return;
    if (warmingInProgressRef.current) return;

    const buildUncachedOrderedList = () => {
      const activeList = queueRef.current.length > 0 ? queueRef.current : list;
      const activeFrom = currentIndexRef.current >= 0 ? currentIndexRef.current : fromIdx;
      const orderedIndices = [];
      const seen = new Set();
      const pushIdx = idx => {
        if (idx >= 0 && idx < activeList.length && !seen.has(idx)) {
          seen.add(idx);
          orderedIndices.push(idx);
        }
      };

      const { order, pos } = shuffleStateRef.current;
      if (Array.isArray(order) && order.length > 0) {
        const startPos = Math.max(0, pos);
        for (let offset = 0; offset < order.length; offset++) {
          pushIdx(order[(startPos + offset) % order.length]);
        }
      }

      if (activeFrom >= 0 && activeFrom < activeList.length) {
        pushIdx(activeFrom);
        pushIdx(activeFrom + 1);
        pushIdx(activeFrom + 2);
        pushIdx(activeFrom - 1);
      }

      for (let offset = 0; offset < activeList.length; offset++) {
        const base = activeFrom >= 0 ? activeFrom : 0;
        pushIdx((base + offset) % activeList.length);
      }

      const uncached = [];
      for (const idx of orderedIndices) {
        const t = activeList[idx];
        if (!t || getCachedBlobUrlForTrack(t)) continue;
        const streamUrl = getTrackStreamUrl(t);
        if (streamUrl && !inflightBlobPromisesRef.current.has(streamUrl)) {
          uncached.push(t);
        }
      }
      return uncached;
    };

    const initialCheck = buildUncachedOrderedList();
    if (initialCheck.length === 0) return;

    warmingInProgressRef.current = true;
    (async () => {
      try {
        while (true) {
          // Always re-evaluate priority order so newly selected tracks/queues are warmed first
          const pending = buildUncachedOrderedList();
          if (pending.length === 0) break;
          const batch = pending.slice(0, 6);
          await Promise.all(batch.map(t => resolvePlayableSource(t).catch(() => {})));
        }
      } finally {
        warmingInProgressRef.current = false;
      }
    })();
  }

  function handleTrackPlaybackFailure(failedIdx, activeQueue) {
    if (currentIndexRef.current !== failedIdx) return;
    const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (
      isHidden &&
      Array.isArray(activeQueue) &&
      activeQueue.length > 1 &&
      consecutivePlayFailuresRef.current < Math.min(activeQueue.length, 8)
    ) {
      consecutivePlayFailuresRef.current += 1;
      playNext();
      return;
    }
    isPlayingRef.current = false;
    setIsPlaying(false);
  }

  function startTrackAtIndexImmediate(nextIdx, listOverride = null) {
    const activeQueue = listOverride || queueRef.current;
    if (!Array.isArray(activeQueue) || nextIdx < 0 || nextIdx >= activeQueue.length) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }
    const nextTrack = activeQueue[nextIdx];
    if (!nextTrack) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      return;
    }

    finalizeActivePlaybackSession(false);
    beginPlaybackSessionForTrack(nextTrack);

    const trackHistoryKey = getShuffleTrackKey(nextTrack);
    if (trackHistoryKey) {
      const filteredHistory = recentPlayedKeysRef.current.filter(k => k !== trackHistoryKey);
      filteredHistory.push(trackHistoryKey);
      if (filteredHistory.length > 15) {
        filteredHistory.splice(0, filteredHistory.length - 15);
      }
      recentPlayedKeysRef.current = filteredHistory;
    }

    currentIndexRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    isPlayingRef.current = true;
    setIsPlaying(true);

    const cachedBlobUrl = getCachedBlobUrlForTrack(nextTrack);
    const directOnlinePreview = !isTrackAvailableOffline(nextTrack) ? nextTrack.previewUrl : null;
    const isHiddenScreen =
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    // 1. Fast synchronous path: when the track's Blob URL is already in RAM (or screen is locked on iOS),
    // assign audio.src and call audio.play() synchronously in the same turn.
    const syncSrc =
      cachedBlobUrl ||
      directOnlinePreview ||
      (isHiddenScreen ? getSyncPlayableSource(nextTrack) : null);

    if (syncSrc && audioRef.current) {
      lastDirectPlayRef.current = {
        index: nextIdx,
        id: String(nextTrack.id),
        src: syncSrc
      };
      if (audioRef.current.src !== syncSrc) {
        audioRef.current.src = syncSrc;
      }
      playInFlightRef.current = true;
      const playPromise = audioRef.current.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            playInFlightRef.current = false;
            consecutivePlayFailuresRef.current = 0;
            isPlayingRef.current = true;
            setIsPlaying(true);
            preloadUpcomingQueueBlobs(activeQueue, nextIdx);
          })
          .catch(() => {
            resolvePlayableSource(nextTrack).then(resolvedSrc => {
              if (
                resolvedSrc &&
                audioRef.current &&
                currentIndexRef.current === nextIdx
              ) {
                if (audioRef.current.src !== resolvedSrc) {
                  audioRef.current.src = resolvedSrc;
                }
                lastDirectPlayRef.current = {
                  index: nextIdx,
                  id: String(nextTrack.id),
                  src: resolvedSrc
                };
                audioRef.current
                  .play()
                  .then(() => {
                    playInFlightRef.current = false;
                    consecutivePlayFailuresRef.current = 0;
                    isPlayingRef.current = true;
                    setIsPlaying(true);
                    preloadUpcomingQueueBlobs(activeQueue, nextIdx);
                  })
                  .catch(() => {
                    playInFlightRef.current = false;
                    handleTrackPlaybackFailure(nextIdx, activeQueue);
                  });
              } else {
                playInFlightRef.current = false;
                handleTrackPlaybackFailure(nextIdx, activeQueue);
              }
            });
          });
      } else {
        playInFlightRef.current = false;
        consecutivePlayFailuresRef.current = 0;
        isPlayingRef.current = true;
        setIsPlaying(true);
        preloadUpcomingQueueBlobs(activeQueue, nextIdx);
      }
      return;
    }

    // 2. Priority Blob resolution path (when user clicks a track or Play button before its Blob URL is in RAM):
    // Resolve the clicked track's Blob URL from CacheStorage FIRST (~5ms, without assigning a deleted /api/stream URL)
    // and then call audio.play() once inside the active user gesture window.
    lastDirectPlayRef.current = {
      index: nextIdx,
      id: String(nextTrack.id),
      src: 'pending'
    };
    playInFlightRef.current = true;
    resolvePlayableSource(nextTrack)
      .then(resolvedSrc => {
        if (!resolvedSrc || !audioRef.current || currentIndexRef.current !== nextIdx) {
          playInFlightRef.current = false;
          return;
        }
        if (audioRef.current.src !== resolvedSrc) {
          audioRef.current.src = resolvedSrc;
        }
        lastDirectPlayRef.current = {
          index: nextIdx,
          id: String(nextTrack.id),
          src: resolvedSrc
        };
        return audioRef.current
          .play()
          .then(() => {
            playInFlightRef.current = false;
            consecutivePlayFailuresRef.current = 0;
            isPlayingRef.current = true;
            setIsPlaying(true);
            preloadUpcomingQueueBlobs(activeQueue, nextIdx);
          })
          .catch(() => {
            playInFlightRef.current = false;
            handleTrackPlaybackFailure(nextIdx, activeQueue);
          });
      })
      .catch(() => {
        playInFlightRef.current = false;
        handleTrackPlaybackFailure(nextIdx, activeQueue);
      });
  }

  function toggleShuffle() {
    setShuffle(prev => {
      const next = !prev;
      shuffleRef.current = next;
      const activeQueue = queueRef.current;
      const curIdx = currentIndexRef.current;
      if (next && Array.isArray(activeQueue) && activeQueue.length > 0) {
        const order = buildSmartShuffleOrder(activeQueue, {
          startIdx: curIdx >= 0 ? curIdx : -1,
          recentKeys: recentPlayedKeysRef.current
        });
        shuffleStateRef.current = { order, pos: 0, queueLen: activeQueue.length };
        preloadUpcomingQueueBlobs(activeQueue, curIdx);
      } else {
        shuffleStateRef.current = {
          order: [],
          pos: -1,
          queueLen: Array.isArray(activeQueue) ? activeQueue.length : 0
        };
      }
      return next;
    });
  }

  function playFromList(list, index, startRandom = false, options = {}) {
    if (!Array.isArray(list) || list.length === 0) return;
    const {
      forceIncludeTrack = null,
      allowSinglePreview = false,
      preserveOrder = false
    } = options || {};
    const clickedTrack = index >= 0 && index < list.length ? list[index] : null;

    if (allowSinglePreview && clickedTrack && !isTrackAvailableOffline(clickedTrack)) {
      if (isOffline) return;
      const singleQueue = [clickedTrack];
      queueRef.current = singleQueue;
      setQueue(singleQueue);
      shuffleStateRef.current = { order: [0], pos: 0, queueLen: 1 };
      startTrackAtIndexImmediate(0, singleQueue);
      return;
    }

    // Normal and shuffle playback ONLY ever queue downloaded tracks
    const playableList = list.filter(
      t =>
        isTrackAvailableOffline(t) ||
        (forceIncludeTrack && String(t.id) === String(forceIncludeTrack.id))
    );
    if (playableList.length === 0) return;

    const targetId = forceIncludeTrack?.id ?? clickedTrack?.id;
    const foundIdx = targetId
      ? playableList.findIndex(t => String(t.id) === String(targetId))
      : 0;
    const mappedIdx = foundIdx >= 0 ? foundIdx : 0;

    queueRef.current = playableList;
    setQueue(playableList);

    if (preserveOrder && !startRandom) {
      shuffleRef.current = false;
      setShuffle(false);
      shuffleStateRef.current = { order: [], pos: -1, queueLen: playableList.length };
      startTrackAtIndexImmediate(mappedIdx, playableList);
      return;
    }

    if (!shuffleRef.current) {
      shuffleRef.current = true;
      setShuffle(true);
    }
    const order = buildSmartShuffleOrder(playableList, {
      startIdx: startRandom ? -1 : mappedIdx,
      recentKeys: recentPlayedKeysRef.current
    });

    // When starting random playback (top orange-black Play button), if order[0]'s Blob URL is not yet in RAM
    // but another candidate in the shuffle order already has its Blob URL ready in RAM, promote it to order[0]
    // so playback begins in 0ms synchronously on the very first tap.
    if (startRandom && order.length > 1 && !getCachedBlobUrlForTrack(playableList[order[0]])) {
      const readyPos = order.findIndex(idx => Boolean(getCachedBlobUrlForTrack(playableList[idx])));
      if (readyPos > 0) {
        [order[0], order[readyPos]] = [order[readyPos], order[0]];
      }
    }

    shuffleStateRef.current = { order, pos: 0, queueLen: playableList.length };
    const firstIdx = order[0] ?? mappedIdx;
    startTrackAtIndexImmediate(firstIdx, playableList);
  }

  function togglePlayPause() {
    if (!audioRef.current || !currentTrack) return;
    const audioEl = audioRef.current;
    const actuallyPlaying = !audioEl.paused && !audioEl.ended && audioEl.readyState > 0;
    if (actuallyPlaying) {
      audioEl.pause();
      isPlayingRef.current = false;
      setIsPlaying(false);
    } else {
      if (!audioEl.src) {
        startTrackAtIndexImmediate(currentIndexRef.current, queueRef.current);
        return;
      }
      playInFlightRef.current = true;
      audioEl
        .play()
        .then(() => {
          playInFlightRef.current = false;
          isPlayingRef.current = true;
          setIsPlaying(true);
          preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
        })
        .catch(() => {
          playInFlightRef.current = false;
          startTrackAtIndexImmediate(currentIndexRef.current, queueRef.current);
        });
    }
  }

  function playNext() {
    const activeQueue = queueRef.current;
    const curIdx = currentIndexRef.current;
    const isShuffle = shuffleRef.current;
    const curRepeat = repeatModeRef.current;

    if (!Array.isArray(activeQueue) || activeQueue.length === 0) return;
    const validIndices = activeQueue
      .map((t, i) => (isTrackAvailableOffline(t) ? i : -1))
      .filter(i => i !== -1);
    if (validIndices.length === 0) {
      setIsPlaying(false);
      return;
    }

    if (isShuffle && validIndices.length > 1) {
      let { order, pos, queueLen } = shuffleStateRef.current;
      const filteredOrder = Array.isArray(order)
        ? order.filter(
            idx =>
              idx >= 0 && idx < activeQueue.length && isTrackAvailableOffline(activeQueue[idx])
          )
        : [];
      if (filteredOrder.length !== validIndices.length || queueLen !== activeQueue.length) {
        order = buildSmartShuffleOrder(activeQueue, {
          startIdx: curIdx,
          recentKeys: recentPlayedKeysRef.current
        }).filter(idx => isTrackAvailableOffline(activeQueue[idx]));
        pos = Math.max(0, order.indexOf(curIdx));
      } else {
        order = filteredOrder;
        const currentPosInOrder = order.indexOf(curIdx);
        if (currentPosInOrder !== -1) pos = currentPosInOrder;
      }
      const nextPos = pos + 1;
      if (nextPos < order.length) {
        shuffleStateRef.current = { order, pos: nextPos, queueLen: activeQueue.length };
        startTrackAtIndexImmediate(order[nextPos], activeQueue);
      } else {
        const freshOrder = buildSmartShuffleOrder(activeQueue, {
          startIdx: -1,
          recentKeys: recentPlayedKeysRef.current
        }).filter(idx => isTrackAvailableOffline(activeQueue[idx]));
        if (freshOrder.length > 1 && freshOrder[0] === curIdx) {
          [freshOrder[0], freshOrder[1]] = [freshOrder[1], freshOrder[0]];
        }
        shuffleStateRef.current = { order: freshOrder, pos: 0, queueLen: activeQueue.length };
        startTrackAtIndexImmediate(freshOrder[0] ?? validIndices[0], activeQueue);
      }
      return;
    }

    const nextValid = validIndices.find(i => i > curIdx);
    if (nextValid !== undefined) {
      startTrackAtIndexImmediate(nextValid, activeQueue);
    } else if (curRepeat === 'all' || isShuffle) {
      startTrackAtIndexImmediate(validIndices[0], activeQueue);
    } else {
      setIsPlaying(false);
    }
  }

  function playPrev() {
    const activeQueue = queueRef.current;
    const curIdx = currentIndexRef.current;
    const isShuffle = shuffleRef.current;
    const curRepeat = repeatModeRef.current;

    if (!Array.isArray(activeQueue) || activeQueue.length === 0) return;
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    const validIndices = activeQueue
      .map((t, i) => (isTrackAvailableOffline(t) ? i : -1))
      .filter(i => i !== -1);
    if (validIndices.length === 0) return;

    if (isShuffle && validIndices.length > 1) {
      const { order, pos, queueLen } = shuffleStateRef.current;
      if (Array.isArray(order) && queueLen === activeQueue.length && pos > 0) {
        for (let p = pos - 1; p >= 0; p--) {
          if (isTrackAvailableOffline(activeQueue[order[p]])) {
            shuffleStateRef.current = { order, pos: p, queueLen: activeQueue.length };
            startTrackAtIndexImmediate(order[p], activeQueue);
            return;
          }
        }
      }
    }

    const prevValid = [...validIndices].reverse().find(i => i < curIdx);
    if (prevValid !== undefined) {
      startTrackAtIndexImmediate(prevValid, activeQueue);
    } else if (curRepeat === 'all' || isShuffle) {
      startTrackAtIndexImmediate(validIndices[validIndices.length - 1], activeQueue);
    }
  }

  function handleTrackEnded() {
    finalizeActivePlaybackSession(true);
    if (repeatModeRef.current === 'one' && audioRef.current) {
      beginPlaybackSessionForTrack(queueRef.current[currentIndexRef.current]);
      audioRef.current.currentTime = 0;
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
      return;
    }
    playNext();
  }

  function cycleRepeatMode() {
    setRepeatMode(prev => (prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off'));
  }

  // Manage audio playback when currentTrack changes + pre-warm upcoming queue Blob URLs for screen-off transitions
  useEffect(() => {
    if (!currentTrack || !audioRef.current) return;
    let cancelled = false;
    setOptimisticTrack(null);

    const alreadyHandledByDirectStart =
      lastDirectPlayRef.current.index === currentIndex &&
      String(lastDirectPlayRef.current.id) === String(currentTrack.id);

    if (!alreadyHandledByDirectStart) {
      if (String(playbackSessionRef.current.trackId) !== String(currentTrack.id)) {
        finalizeActivePlaybackSession(false);
        beginPlaybackSessionForTrack(currentTrack);
      }
      const playTrack = async () => {
        const src = await resolvePlayableSource(currentTrack);
        if (!src || cancelled || !audioRef.current) return;
        if (
          lastDirectPlayRef.current.index === currentIndex &&
          String(lastDirectPlayRef.current.id) === String(currentTrack.id) &&
          Boolean(audioRef.current.src) &&
          !audioRef.current.paused
        ) {
          return;
        }
        if (audioRef.current.src !== src) {
          audioRef.current.src = src;
        }
        lastDirectPlayRef.current = {
          index: currentIndex,
          id: String(currentTrack.id),
          src
        };
        playInFlightRef.current = true;
        try {
          await audioRef.current.play();
          playInFlightRef.current = false;
          consecutivePlayFailuresRef.current = 0;
          if (!cancelled) {
            isPlayingRef.current = true;
            setIsPlaying(true);
          }
          preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
        } catch {
          playInFlightRef.current = false;
          if (!cancelled) {
            const stillPlaying = Boolean(audioRef.current && !audioRef.current.paused);
            isPlayingRef.current = stillPlaying;
            setIsPlaying(stillPlaying);
          }
        }
      };
      playTrack();
    }

    return () => {
      cancelled = true;
    };
  }, [currentIndex, queue]);

  // Keep initial offline tracks pre-warmed calmly without flooding CacheStorage during active track startup
  useEffect(() => {
    if (playInFlightRef.current) return;
    const timer = setTimeout(() => {
      if (playInFlightRef.current) return;
      if (queueRef.current.length > 0 && currentIndexRef.current >= 0) {
        preloadUpcomingQueueBlobs(queueRef.current, currentIndexRef.current);
      } else if (offlineCatalog.length > 0) {
        preloadUpcomingQueueBlobs(offlineCatalog, 0);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [shuffle, offlineCatalog]);

  // Register lock-screen / background MediaSession metadata and hardware transport controls
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      if (currentTrack && typeof window !== 'undefined' && 'MediaMetadata' in window) {
        const artUrl = isPlaceholderCover(currentTrack.artwork)
          ? new URL(DEFAULT_TRACK_COVER, window.location.origin).href
          : currentTrack.artwork.startsWith('/')
          ? new URL(currentTrack.artwork, window.location.origin).href
          : currentTrack.artwork;
        const artMime = String(artUrl || '').startsWith('data:image/png')
          ? 'image/png'
          : 'image/jpeg';
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: currentTrack.title || 'MyMusicAnywhere',
          artist: currentTrack.artist || 'Artista',
          album: currentTrack.album || 'MyMusicAnywhere',
          artwork: artUrl ? [{ src: artUrl, sizes: '300x300', type: artMime }] : []
        });
      }
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch {}

    const handlers = [
      [
        'play',
        () => {
          if (audioRef.current && currentIndexRef.current >= 0) {
            audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
          }
        }
      ],
      [
        'pause',
        () => {
          if (audioRef.current) {
            audioRef.current.pause();
            setIsPlaying(false);
          }
        }
      ],
      ['nexttrack', () => playNext()],
      ['previoustrack', () => playPrev()],
      [
        'seekto',
        details => {
          if (audioRef.current && details && typeof details.seekTime === 'number') {
            audioRef.current.currentTime = details.seekTime;
          }
        }
      ]
    ];

    for (const [action, fn] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {}
    }
  }, [currentTrack, isPlaying, queue, currentIndex, shuffle, repeatMode]);

  const exposed = {
    handlePlaybackTimeTick,
    preloadUpcomingQueueBlobs,
    toggleShuffle,
    playFromList,
    togglePlayPause,
    playNext,
    playPrev,
    handleTrackEnded,
    cycleRepeatMode
  };

  if (apiRef) {
    Object.assign(apiRef.current, exposed);
  }

  return exposed;
}
