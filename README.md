# myMusicAnywhere

A mobile-first Progressive Web App (PWA) for exploring audio catalogs, managing favorite tracks, and caching audio for offline playback.

## Features

- **Catalog Exploration**: Search tracks, artists, and albums with 30-second audio previews and high-resolution cover art.
- **Favorites Collection**: Save favorite tracks to `localStorage` and queue them in the built-in audio player.
- **Offline Audio Caching**: Uses a Service Worker (`public/sw.js`) and the browser Cache Storage API (`mymusic-offline-audio`) for offline playback.
- **Full Audio Player**: Supports shuffle, repeat (all/one), track scrubbing, and background queue navigation.
- **Installable PWA**: Includes a Web App Manifest and mobile bottom navigation bar designed for iOS, Android, and desktop.

## Getting Started

### Prerequisites

- **Node.js** 18+
- **Python 3** & **FFmpeg** (for local audio transcoding and media processing)

### Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3333` in your browser.

### Production Build (VPS / Self-Hosted)

```bash
npm install
npm run build
pm2 start ecosystem.config.cjs
```

See `deploy/setup-vps.sh` and `deploy/nginx-site.conf` for automated deployment and reverse proxy configuration.
