# MyMusicAnywhere

A self-hosted Progressive Web App (PWA) for exploring music catalogs, extracting MP3 audio, caching tracks for offline playback, and managing multi-user access via invitation codes.

## Features

- **Invite-Only Authentication & Admin Panel**: Users sign in or register using single- or multi-use invitation codes (`MMA-XXXX-XXXX`) generated from the built-in admin panel.
- **Catalog Exploration**: Search tracks, artists, and albums with 30-second audio previews and cover art.
- **CoverLock™ DSP (Cover-Anchored Audio Engine)**: Proprietary verification pipeline that uses the album cover's catalog metadata (iTunes / Deezer canonical duration, artist, and track separation) as a cryptographic-like acoustic anchor (`±8s` studio duration window, zero-foreign-token artist guard, anti-cover/bootleg scoring, `ffmpeg` loop auto-trimming, and multi-source failover across SoundCloud, Bilibili Hi-Res, and YouTube).
- **Library & Offline Audio Caching**: Save favorite tracks, download MP3 files directly to your device, and cache audio streams in browser `IndexedDB` for full offline playback.
- **Automatic Storage Quota (FIFO)**: Caps server-side MP3 storage at `MAX_STORAGE_MB` (default `2048` MB), automatically pruning the oldest files so shared VPS disks never fill up.
- **Editorial Studio UI**: Tactile paper-and-ink design system with responsive desktop pill navigation, mobile bottom bar, and floating vinyl player deck.

## Environment Variables (`.env`)

Copy `.env.example` to `.env`:

- `PORT` — HTTP port (default: `3333`)
- `ADMIN_USERNAME` — Initial administrator username
- `ADMIN_PASSWORD` — Initial administrator password
- `SESSION_SECRET` — Secret key used to sign session cookies
- `DOWNLOADS_DIR` — Directory where extracted `.mp3` files are stored (default: `./downloads`)
- `MAX_STORAGE_MB` — Maximum disk space in MB for `DOWNLOADS_DIR` before oldest files are pruned (default: `2048`)
- `YTDLP_BIN` — Optional binary path or command for `yt-dlp` (defaults to `yt-dlp` in `PATH`)
- `FFMPEG_BIN` — Optional binary path or directory for `ffmpeg` (defaults to `ffmpeg` in `PATH`)

## Production Build (VPS / Self-Hosted)

```bash
cp .env.example .env
npm install
npm run build
pm2 start ecosystem.config.cjs
```
