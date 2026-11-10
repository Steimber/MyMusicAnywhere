'use client';

import { useState, useEffect } from 'react';

function formatPlaybackSeconds(sec) {
  if (!sec || Number.isNaN(sec) || !Number.isFinite(sec)) return '0:00';
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export default function PlayerScrubber({ audioRef, trackKey }) {
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audioEl = audioRef?.current;
    if (!audioEl) return undefined;

    const syncFromAudio = () => {
      const cur = Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : 0;
      const dur = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
      setProgress(cur);
      setDuration(dur);
    };

    syncFromAudio();

    const onTime = () => {
      const cur = Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : 0;
      setProgress(cur);
    };
    const onDuration = () => {
      const dur = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
      setDuration(dur);
    };
    const onReset = () => {
      setProgress(0);
      setDuration(0);
    };

    audioEl.addEventListener('timeupdate', onTime);
    audioEl.addEventListener('loadedmetadata', onDuration);
    audioEl.addEventListener('durationchange', onDuration);
    audioEl.addEventListener('emptied', onReset);

    return () => {
      audioEl.removeEventListener('timeupdate', onTime);
      audioEl.removeEventListener('loadedmetadata', onDuration);
      audioEl.removeEventListener('durationchange', onDuration);
      audioEl.removeEventListener('emptied', onReset);
    };
  }, [audioRef, trackKey]);

  const safeMax = duration > 0 ? duration : 100;
  const clampedValue = duration > 0 ? Math.min(progress, duration) : 0;

  return (
    <div className="player-scrubber">
      <span className="tabular-nums">{formatPlaybackSeconds(clampedValue)}</span>
      <input
        type="range"
        min="0"
        max={safeMax}
        step="0.25"
        value={clampedValue}
        aria-label="Posición de reproducción"
        onChange={e => {
          const val = Number(e.target.value);
          setProgress(val);
          if (audioRef?.current) {
            audioRef.current.currentTime = val;
          }
        }}
      />
      <span className="tabular-nums">{formatPlaybackSeconds(duration)}</span>
    </div>
  );
}
