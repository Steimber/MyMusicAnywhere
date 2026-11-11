import { notifyYouTubeBlocked } from '../alerts.js';

export const YOUTUBE_BLOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes

export const YOUTUBE_FALLBACK_NOTICE =
  'YouTube no está disponible ahora, buscando en SoundCloud';
export const NO_SOURCE_FOUND_ERROR = 'No se encontró en ninguna fuente';

export function createYouTubeStatusState() {
  return {
    blockedSince: null,
    blockedUntil: 0,
    lastReason: null,
    onBlockedCallbacks: new Set()
  };
}

if (!global.__mmaYoutubeStatus) {
  global.__mmaYoutubeStatus = createYouTubeStatusState();
}

export function getDefaultYouTubeStatusState() {
  return global.__mmaYoutubeStatus;
}

export function getYtDlpProxy(env = process.env) {
  const val = String(env?.YTDLP_PROXY ?? '').trim();
  return val || null;
}

export function isYouTubeTargetUrl(target) {
  const str = String(target || '').trim();
  if (!str) return false;
  if (/^ytsearch\d*:/i.test(str)) return true;
  return /(?:^|\/\/|\.)(?:youtube\.com|youtu\.be)(?:[/:?#]|$)/i.test(str);
}

export function buildYtDlpProxyArgs(isYouTubeTarget, proxyValue = getYtDlpProxy()) {
  if (!isYouTubeTarget || !proxyValue) return [];
  return ['--proxy', proxyValue];
}

export function redactProxySecrets(rawText, proxyValue = getYtDlpProxy()) {
  let out = String(rawText ?? '');
  if (!out) return out;

  if (proxyValue) {
    out = out.split(proxyValue).join('[PROXY_REDACTED]');
    try {
      const encoded = encodeURIComponent(proxyValue);
      if (encoded && encoded !== proxyValue) {
        out = out.split(encoded).join('[PROXY_REDACTED]');
      }
    } catch {}

    try {
      const parsed = new URL(proxyValue);
      if (parsed.password) {
        out = out.split(parsed.password).join('[REDACTED]');
        try {
          const decPass = decodeURIComponent(parsed.password);
          if (decPass) out = out.split(decPass).join('[REDACTED]');
        } catch {}
      }
      if (parsed.username && parsed.password) {
        const userPass = `${parsed.username}:${parsed.password}`;
        out = out.split(userPass).join('[REDACTED]');
      }
      if (parsed.host) {
        out = out.split(parsed.host).join('[PROXY_HOST]');
      }
    } catch {
      const atIdx = proxyValue.lastIndexOf('@');
      if (atIdx > 0) {
        const creds = proxyValue.slice(0, atIdx).replace(/^[a-z0-9+.-]+:\/\//i, '');
        const hostPart = proxyValue.slice(atIdx + 1);
        if (creds) out = out.split(creds).join('[REDACTED]');
        if (hostPart) out = out.split(hostPart).join('[PROXY_HOST]');
      }
    }
  }

  // Also scrub any generic URL carrying user:pass@host credentials
  out = out.replace(
    /\b(?:https?|socks4a?|socks5h?):\/\/[^\s/"'@]+:[^\s/"'@]+@[^\s"'<>]+/gi,
    '[PROXY_REDACTED]'
  );

  return out;
}

export function isYouTubeBotBlockError(rawError) {
  const text = String(rawError || '');
  if (!text) return false;
  return (
    /sign in to confirm/i.test(text) ||
    /confirm you['’`]?re not a bot/i.test(text) ||
    /not a bot/i.test(text) ||
    /this helps protect our community/i.test(text) ||
    /unusual traffic from your computer network/i.test(text) ||
    /automated queries/i.test(text) ||
    /(?:youtube|googlevideo).*http error 429/i.test(text) ||
    /http error 429.*(?:youtube|too many requests)/i.test(text)
  );
}

export function isYouTubeBlocked(now = Date.now(), state = getDefaultYouTubeStatusState()) {
  if (!state || !state.blockedUntil) return false;
  if (now >= state.blockedUntil) {
    state.blockedSince = null;
    state.blockedUntil = 0;
    state.lastReason = null;
    return false;
  }
  return true;
}

export function onYouTubeBlockedTransition(listener, state = getDefaultYouTubeStatusState()) {
  if (typeof listener !== 'function' || !state) return () => {};
  state.onBlockedCallbacks.add(listener);
  return () => state.onBlockedCallbacks.delete(listener);
}

export function markYouTubeBlocked(
  reason = 'bot_check',
  now = Date.now(),
  state = getDefaultYouTubeStatusState(),
  alertOptions = null
) {
  const wasBlocked = isYouTubeBlocked(now, state);
  if (!wasBlocked || !state.blockedSince) {
    state.blockedSince = now;
  }
  state.blockedUntil = now + YOUTUBE_BLOCK_TTL_MS;
  state.lastReason = redactProxySecrets(String(reason || 'bot_check')).slice(0, 180);

  const becameBlocked = !wasBlocked;
  if (becameBlocked) {
    if (state === getDefaultYouTubeStatusState() || alertOptions) {
      notifyYouTubeBlocked({ now, ...(alertOptions || {}) }).catch(() => {});
    }
    if (state.onBlockedCallbacks?.size > 0) {
      for (const fn of state.onBlockedCallbacks) {
        try {
          fn({
            blockedSince: state.blockedSince,
            blockedUntil: state.blockedUntil,
            now
          });
        } catch {}
      }
    }
  }

  return {
    blocked: true,
    becameBlocked,
    blockedSince: state.blockedSince,
    blockedUntil: state.blockedUntil
  };
}

export function clearYouTubeBlocked(state = getDefaultYouTubeStatusState()) {
  if (!state) return;
  state.blockedSince = null;
  state.blockedUntil = 0;
  state.lastReason = null;
}

export function getYouTubeAdminStatus(
  now = Date.now(),
  state = getDefaultYouTubeStatusState(),
  proxyValue = getYtDlpProxy()
) {
  const blocked = isYouTubeBlocked(now, state);
  return {
    status: blocked ? 'blocked' : 'ok',
    blocked,
    blockedSince: blocked && state.blockedSince ? new Date(state.blockedSince).toISOString() : null,
    blockedUntil: blocked && state.blockedUntil ? new Date(state.blockedUntil).toISOString() : null,
    proxyConfigured: Boolean(proxyValue)
  };
}

export function classifyDirectLinkSource(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { isUrl: false, source: null, label: null, supported: false };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { isUrl: false, source: null, label: null, supported: false };
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtu.be'
    ) {
      return { isUrl: true, source: 'youtube', label: 'YouTube', supported: true };
    }
    if (
      host === 'soundcloud.com' ||
      host === 'www.soundcloud.com' ||
      host === 'm.soundcloud.com' ||
      host === 'on.soundcloud.com'
    ) {
      return { isUrl: true, source: 'soundcloud', label: 'SoundCloud', supported: true };
    }
    return { isUrl: true, source: 'other', label: 'Otra fuente', supported: false };
  } catch {
    return { isUrl: false, source: null, label: null, supported: false };
  }
}
