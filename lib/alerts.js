export const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per alert type
export const CONSECUTIVE_FAILURE_THRESHOLD = 5;
export const DISK_USAGE_ALERT_THRESHOLD = 0.9; // Strictly > 90%
const NTFY_REQUEST_TIMEOUT_MS = 5000;

export const ALERT_TYPES = Object.freeze({
  YOUTUBE_BLOCKED: 'youtube_blocked',
  CONSECUTIVE_DOWNLOAD_FAILURES: 'consecutive_download_failures',
  DOWNLOADS_DISK_HIGH: 'downloads_disk_high'
});

// Static operational messages only: never interpolate user data, URLs, IPs, or song titles.
const ALERT_MESSAGES = Object.freeze({
  [ALERT_TYPES.YOUTUBE_BLOCKED]: Object.freeze({
    title: 'MyMusicAnywhere - YouTube bloqueado',
    priority: 'high',
    body: 'YouTube pasó a estado bloqueado en el servidor. Se activó el respaldo automático de SoundCloud.'
  }),
  [ALERT_TYPES.CONSECUTIVE_DOWNLOAD_FAILURES]: Object.freeze({
    title: 'MyMusicAnywhere - Fallos de descarga',
    priority: 'high',
    body: 'Fallaron 5 descargas seguidas en el servidor.'
  }),
  [ALERT_TYPES.DOWNLOADS_DISK_HIGH]: Object.freeze({
    title: 'MyMusicAnywhere - Disco de descargas > 90%',
    priority: 'urgent',
    body: 'El uso del disco de descargas superó el 90 % en el servidor.'
  })
});

export function createAlertsState() {
  return {
    consecutiveFailures: 0,
    lastSentAtByType: new Map()
  };
}

if (!globalThis.__mmaAlertsState) {
  globalThis.__mmaAlertsState = createAlertsState();
}

export function getDefaultAlertsState() {
  return globalThis.__mmaAlertsState;
}

export function getNtfyUrl(env = typeof process !== 'undefined' ? process.env : {}) {
  const raw = String(env?.NTFY_URL ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function sendAlert(
  type,
  {
    now = Date.now(),
    env = typeof process !== 'undefined' ? process.env : {},
    state = getDefaultAlertsState(),
    fetchFn = globalThis.fetch
  } = {}
) {
  const message = ALERT_MESSAGES[type];
  if (!message) {
    return { sent: false, reason: 'unknown_type' };
  }

  const ntfyUrl = getNtfyUrl(env);
  if (!ntfyUrl) {
    return { sent: false, reason: 'disabled' };
  }

  if (typeof fetchFn !== 'function') {
    return { sent: false, reason: 'no_fetch' };
  }

  const lastSentAt = state?.lastSentAtByType?.get(type);
  if (typeof lastSentAt === 'number' && now - lastSentAt < ALERT_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }

  // Reserve cooldown slot synchronously so concurrent events cannot send duplicate bursts.
  state?.lastSentAtByType?.set(type, now);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NTFY_REQUEST_TIMEOUT_MS);
  if (typeof timer?.unref === 'function') timer.unref();

  try {
    const res = await fetchFn(ntfyUrl, {
      method: 'POST',
      headers: {
        Title: message.title,
        Priority: message.priority,
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: message.body,
      signal: controller.signal
    });
    if (!res || !res.ok) {
      return { sent: false, reason: 'http_error', status: res?.status ?? 0 };
    }
    return { sent: true, reason: 'sent', status: res.status };
  } catch {
    // Never log NTFY_URL or throw into download/storage callers.
    return { sent: false, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function notifyYouTubeBlocked(options = {}) {
  return sendAlert(ALERT_TYPES.YOUTUBE_BLOCKED, options);
}

export async function recordDownloadOutcome(succeeded, options = {}) {
  const state = options.state || getDefaultAlertsState();
  if (succeeded) {
    state.consecutiveFailures = 0;
    return { sent: false, reason: 'reset', consecutiveFailures: 0 };
  }

  state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
  const count = state.consecutiveFailures;
  if (count < CONSECUTIVE_FAILURE_THRESHOLD) {
    return { sent: false, reason: 'below_threshold', consecutiveFailures: count };
  }

  const alertRes = await sendAlert(ALERT_TYPES.CONSECUTIVE_DOWNLOAD_FAILURES, {
    ...options,
    state
  });
  return {
    ...alertRes,
    consecutiveFailures: count
  };
}

export function evaluateDownloadsDiskUsage({
  usedBytes = 0,
  maxStorageMB = 0,
  statfs = null
} = {}) {
  const safeUsedBytes = Number.isFinite(usedBytes) && usedBytes > 0 ? usedBytes : 0;
  const maxBytes =
    Number.isFinite(maxStorageMB) && maxStorageMB > 0 ? maxStorageMB * 1024 * 1024 : 0;
  const quotaRatio = maxBytes > 0 ? safeUsedBytes / maxBytes : 0;

  let fsRatio = 0;
  if (statfs) {
    const blocks = Number(statfs.blocks);
    const bavail = Number(statfs.bavail ?? statfs.bfree);
    if (Number.isFinite(blocks) && blocks > 0 && Number.isFinite(bavail) && bavail >= 0) {
      fsRatio = Math.max(0, Math.min(1, (blocks - bavail) / blocks));
    }
  }

  const usageRatio = Math.max(quotaRatio, fsRatio);
  return {
    usedBytes: safeUsedBytes,
    maxBytes,
    quotaRatio,
    fsRatio,
    usageRatio
  };
}

export async function checkDownloadsDiskAlert(metrics = {}, options = {}) {
  const usage = evaluateDownloadsDiskUsage(metrics);
  if (usage.usageRatio <= DISK_USAGE_ALERT_THRESHOLD) {
    return { sent: false, reason: 'below_threshold', usage };
  }

  const alertRes = await sendAlert(ALERT_TYPES.DOWNLOADS_DISK_HIGH, options);
  return {
    ...alertRes,
    usage
  };
}
