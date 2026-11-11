import { spawn } from 'child_process';
import crypto from 'crypto';
import { cleanYouTubeOembedMetadata } from '../../../lib/download/candidates.js';
import {
  classifyDirectLinkSource,
  buildYtDlpProxyArgs,
  isYouTubeBlocked,
  isYouTubeBotBlockError,
  markYouTubeBlocked
} from '../../../lib/download/youtube-status.js';
import {
  isAllowedMediaUrl,
  normalizeDirectMediaUrl,
  resolveYtDlpCommand
} from '../download/route.js';

function formatMillis(ms) {
  if (!ms || isNaN(ms)) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec <= 0) return '—';
  const m = Math.floor(totalSec / 60);
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function extractYouTubeVideoId(rawInput) {
  const str = String(rawInput || '').trim();
  if (!str) return null;
  try {
    const parsed = new URL(str);
    const host = parsed.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com'
    ) {
      const v = parsed.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const parts = parsed.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && parts[1]) {
        return /^[\w-]{11}$/.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {}
  const match = str.match(
    /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i
  );
  return match ? match[1] : null;
}

function probeDirectUrlWithYtDlp(canonicalUrl, isYouTube, timeoutMs = 4500) {
  if (isYouTube && isYouTubeBlocked()) {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    const ytdlpArgs = [
      '--no-playlist',
      '--skip-download',
      '--ignore-errors',
      '--no-warnings',
      '--socket-timeout',
      '4',
      '--js-runtimes',
      'node',
      ...buildYtDlpProxyArgs(isYouTube),
      '--print',
      '%(duration)s\t%(title)s\t%(uploader)s\t%(thumbnail)s',
      '--',
      canonicalUrl
    ];
    const { cmd, args } = resolveYtDlpCommand(ytdlpArgs);
    let stdoutText = '';
    let stderrText = '';
    let settled = false;
    let child;
    try {
      child = spawn(/*turbopackIgnore: true*/ cmd, args);
    } catch {
      return resolve(null);
    }
    const finish = val => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (isYouTube && isYouTubeBotBlockError(stderrText)) {
        markYouTubeBlocked(stderrText);
      }
      resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', d => {
      stdoutText += d.toString();
    });
    child.stderr.on('data', d => {
      stderrText += d.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const line = stdoutText
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(Boolean);
      if (!line) return finish(null);
      const [durStr, title, uploader, thumbnail] = line.split('\t');
      const durationSec = Math.round(Number(durStr) || 0);
      finish({
        durationSec: durationSec > 0 ? durationSec : 0,
        title: title && title !== 'NA' ? title.trim() : null,
        uploader: uploader && uploader !== 'NA' ? uploader.trim() : null,
        thumbnail: thumbnail && thumbnail !== 'NA' && /^https?:\/\//i.test(thumbnail) ? thumbnail.trim() : null
      });
    });
  });
}

async function lookupQuickCatalogDuration(title, artist) {
  const term = `${title || ''} ${artist && artist !== 'YouTube' && artist !== 'SoundCloud' ? artist : ''}`.trim();
  if (!term) return 0;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1800);
  try {
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=3`,
      { signal: ctrl.signal }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    const first = Array.isArray(data?.results) ? data.results[0] : null;
    return first?.trackTimeMillis ? Math.round(first.trackTimeMillis / 1000) : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveYouTubeLinkTrack(videoId) {
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const defaultArtwork = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  let rawTitle = `YouTube (${videoId})`;
  let authorName = 'YouTube';
  let artwork = defaultArtwork;

  const [oembedRes, probeRes] = await Promise.all([
    (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2800);
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
          canonicalUrl
        )}&format=json`;
        const res = await fetch(oembedUrl, { signal: ctrl.signal });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })(),
    probeDirectUrlWithYtDlp(canonicalUrl, true, 4200)
  ]);

  if (oembedRes) {
    if (oembedRes.title) rawTitle = String(oembedRes.title).trim();
    if (oembedRes.author_name) authorName = String(oembedRes.author_name).trim();
    if (oembedRes.thumbnail_url) artwork = oembedRes.thumbnail_url;
  }
  if (probeRes) {
    if (rawTitle.startsWith('YouTube (') && probeRes.title) rawTitle = probeRes.title;
    if (authorName === 'YouTube' && probeRes.uploader) authorName = probeRes.uploader;
    if (probeRes.thumbnail && artwork === defaultArtwork) artwork = probeRes.thumbnail;
  }

  const cleanedMeta = cleanYouTubeOembedMetadata(rawTitle, authorName);
  const finalTitle = cleanedMeta.title || rawTitle;
  const finalArtist = cleanedMeta.artist || 'YouTube';

  let durationSec = probeRes?.durationSec || 0;
  if (!durationSec && finalTitle && !finalTitle.startsWith('YouTube (')) {
    durationSec = await lookupQuickCatalogDuration(finalTitle, finalArtist);
  }

  return {
    id: `yt_${videoId}`,
    title: finalTitle,
    artist: finalArtist,
    album: 'YouTube',
    genre: 'YouTube',
    artwork,
    previewUrl: null,
    duration: durationSec > 0 ? formatMillis(durationSec * 1000) : '—',
    durationSec,
    source: 'youtube',
    sourceLabel: 'YouTube',
    sourceUrl: canonicalUrl
  };
}

async function resolveSoundCloudLinkTrack(rawUrl) {
  const canonicalUrl = normalizeDirectMediaUrl(rawUrl);
  if (!isAllowedMediaUrl(canonicalUrl)) {
    return null;
  }
  const hashId = crypto.createHash('sha1').update(canonicalUrl).digest('hex').slice(0, 12);
  let rawTitle = 'Pista de SoundCloud';
  let authorName = 'SoundCloud';
  let artwork = '/icon.svg?v=3';

  const [oembedRes, probeRes] = await Promise.all([
    (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2800);
      try {
        const oembedUrl = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(
          canonicalUrl
        )}`;
        const res = await fetch(oembedUrl, { signal: ctrl.signal });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })(),
    probeDirectUrlWithYtDlp(canonicalUrl, false, 4800)
  ]);

  if (oembedRes) {
    if (oembedRes.title) rawTitle = String(oembedRes.title).trim();
    if (oembedRes.author_name) authorName = String(oembedRes.author_name).trim();
    if (oembedRes.thumbnail_url) artwork = oembedRes.thumbnail_url;
  }
  if (probeRes) {
    if (probeRes.title) rawTitle = probeRes.title;
    if (probeRes.uploader && authorName === 'SoundCloud') authorName = probeRes.uploader;
    if (probeRes.thumbnail && artwork.startsWith('/icon')) artwork = probeRes.thumbnail;
  }

  // SoundCloud oEmbed often formats title as "Track by Artist"
  if (authorName !== 'SoundCloud') {
    const suffix = ` by ${authorName}`;
    if (rawTitle.toLowerCase().endsWith(suffix.toLowerCase())) {
      rawTitle = rawTitle.slice(0, rawTitle.length - suffix.length).trim() || rawTitle;
    }
  }

  const cleanedMeta = cleanYouTubeOembedMetadata(rawTitle, authorName);
  const finalTitle = cleanedMeta.title || rawTitle;
  const finalArtist = cleanedMeta.artist || authorName || 'SoundCloud';

  let durationSec = probeRes?.durationSec || 0;
  if (!durationSec && finalTitle && finalTitle !== 'Pista de SoundCloud') {
    durationSec = await lookupQuickCatalogDuration(finalTitle, finalArtist);
  }

  return {
    id: `sc_${hashId}`,
    title: finalTitle,
    artist: finalArtist,
    album: 'SoundCloud',
    genre: 'SoundCloud',
    artwork,
    previewUrl: null,
    duration: durationSec > 0 ? formatMillis(durationSec * 1000) : '—',
    durationSec,
    source: 'soundcloud',
    sourceLabel: 'SoundCloud',
    sourceUrl: canonicalUrl
  };
}

async function searchDeezerFallback(q) {
  try {
    const deezerUrl = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=15`;
    const res = await fetch(deezerUrl, { next: { revalidate: 3600 } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(item => {
      const sec = Number(item.duration) || 0;
      return {
        id: `dz_${item.id}`,
        title: item.title || 'Canción',
        artist: item.artist?.name || 'Artista',
        album: item.album?.title || 'Single',
        genre: 'Música',
        artwork:
          item.album?.cover_medium ||
          item.album?.cover_big ||
          item.album?.cover_small ||
          '/icon.svg',
        previewUrl: item.preview || null,
        duration: formatMillis(sec * 1000),
        durationSec: sec
      };
    });
  } catch {
    return [];
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q');

  if (!q) {
    return Response.json({ error: 'Falta término de búsqueda' }, { status: 400 });
  }

  const linkInfo = classifyDirectLinkSource(q);
  if (linkInfo.isUrl) {
    if (!linkInfo.supported) {
      return Response.json(
        {
          error: 'Fuente no soportada. Pega un enlace directo de YouTube o SoundCloud.',
          source: 'other',
          sourceLabel: 'Otra fuente',
          results: [],
          tracks: []
        },
        { status: 400 }
      );
    }

    if (linkInfo.source === 'youtube') {
      const ytVideoId = extractYouTubeVideoId(q);
      if (!ytVideoId) {
        return Response.json(
          {
            error: 'No se pudo identificar el video en ese enlace de YouTube.',
            source: 'youtube',
            sourceLabel: 'YouTube',
            results: [],
            tracks: []
          },
          { status: 400 }
        );
      }
      const ytTrack = await resolveYouTubeLinkTrack(ytVideoId);
      return Response.json({
        source: 'youtube',
        sourceLabel: 'YouTube',
        results: [ytTrack],
        tracks: [ytTrack]
      });
    }

    if (linkInfo.source === 'soundcloud') {
      const scTrack = await resolveSoundCloudLinkTrack(q);
      if (!scTrack) {
        return Response.json(
          {
            error: 'Enlace de SoundCloud inválido o no permitido.',
            source: 'soundcloud',
            sourceLabel: 'SoundCloud',
            results: [],
            tracks: []
          },
          { status: 400 }
        );
      }
      return Response.json({
        source: 'soundcloud',
        sourceLabel: 'SoundCloud',
        results: [scTrack],
        tracks: [scTrack]
      });
    }
  }

  const ytVideoId = extractYouTubeVideoId(q);
  if (ytVideoId) {
    const ytTrack = await resolveYouTubeLinkTrack(ytVideoId);
    return Response.json({
      source: 'youtube',
      sourceLabel: 'YouTube',
      results: [ytTrack],
      tracks: [ytTrack]
    });
  }

  let results = [];
  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=25`;
    const response = await fetch(itunesUrl, { next: { revalidate: 3600 } });
    if (response.ok) {
      const data = await response.json();
      results = (data.results || []).map(r => ({
        id: r.trackId,
        title: r.trackName,
        artist: r.artistName,
        album: r.collectionName,
        genre: r.primaryGenreName || 'Música',
        artwork: (r.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
        previewUrl: r.previewUrl,
        duration: formatMillis(r.trackTimeMillis),
        durationSec: Math.round((r.trackTimeMillis || 0) / 1000)
      }));
    }
  } catch {}

  if (results.length === 0) {
    results = await searchDeezerFallback(q);
  }

  return Response.json({ results, tracks: results });
}
