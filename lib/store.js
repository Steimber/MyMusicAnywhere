import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function getDataDir() {
  const dir = process.env.DATA_DIR
    ? path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR)
    : path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getStoreFile() {
  return path.join(getDataDir(), 'store.json');
}

export function getDownloadsDir() {
  const dir = process.env.DOWNLOADS_DIR
    ? path.resolve(/*turbopackIgnore: true*/ process.env.DOWNLOADS_DIR)
    : path.join(process.cwd(), 'downloads');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getMaxStorageMB() {
  const parsed = Number(process.env.MAX_STORAGE_MB);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 256;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
}

export function loadStore() {
  const dataDir = getDataDir();
  const storeFile = getStoreFile();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  let store = {
    secret: crypto.randomBytes(32).toString('hex'),
    users: [],
    invites: [],
    uploads: []
  };

  if (fs.existsSync(storeFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      store = {
        secret: raw.secret || store.secret,
        users: Array.isArray(raw.users) ? raw.users : [],
        invites: Array.isArray(raw.invites) ? raw.invites : [],
        uploads: Array.isArray(raw.uploads) ? raw.uploads : []
      };
    } catch {
      // Keep default structure if corrupted
    }
  }

  const adminUsername = (process.env.ADMIN_USERNAME || 'steimber').trim();
  const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');

  const existingAdmin = store.users.find(
    u => u.username.toLowerCase() === adminUsername.toLowerCase()
  );

  if (!existingAdmin) {
    store.users.unshift({
      id: 'usr_admin',
      username: adminUsername,
      passwordHash: hashPassword(adminPassword),
      is_admin: true,
      active: true,
      created_at: new Date().toISOString()
    });
    saveStore(store);
  } else if (process.env.ADMIN_PASSWORD && !verifyPassword(adminPassword, existingAdmin.passwordHash)) {
    existingAdmin.passwordHash = hashPassword(adminPassword);
    existingAdmin.is_admin = true;
    existingAdmin.active = true;
    saveStore(store);
  }

  return store;
}

export function saveStore(store) {
  const dataDir = getDataDir();
  const storeFile = getStoreFile();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), 'utf8');
}

function getSigningSecret(store) {
  return process.env.SESSION_SECRET || store.secret;
}

export function createSessionToken(user) {
  const store = loadStore();
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.id,
      username: user.username,
      is_admin: Boolean(user.is_admin),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 30 // 30 days
    })
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', getSigningSecret(store))
    .update(payload)
    .digest('base64url');

  return `${payload}.${sig}`;
}

export function getSessionUser(request) {
  try {
    let cookie = request.cookies?.get('mymusic_session')?.value;
    if (!cookie && typeof request.headers?.get === 'function') {
      const rawCookieHeader = request.headers.get('cookie') || '';
      const match = rawCookieHeader.match(/(?:^|;\s*)mymusic_session=([^;]+)/);
      if (match) {
        cookie = decodeURIComponent(match[1].trim());
      }
    }
    if (!cookie || !cookie.includes('.')) return null;

    const [payload, sig] = cookie.split('.');
    const store = loadStore();
    const expectedSig = crypto
      .createHmac('sha256', getSigningSecret(store))
      .update(payload)
      .digest('base64url');

    if (sig !== expectedSig) return null;

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || Date.now() > data.exp) return null;

    const dbUser = store.users.find(u => u.id === data.sub);
    if (!dbUser || !dbUser.active) return null;

    return {
      id: dbUser.id,
      username: dbUser.username,
      is_admin: Boolean(dbUser.is_admin),
      created_at: dbUser.created_at
    };
  } catch {
    return null;
  }
}

export function createUserWithInvite(username, password, inviteCode) {
  const cleanUser = (username || '').trim();
  const cleanCode = (inviteCode || '').trim().toUpperCase();

  if (cleanUser.length < 3 || cleanUser.length > 32) {
    return { error: 'El usuario debe tener entre 3 y 32 caracteres.' };
  }
  if (!password || password.length < 6) {
    return { error: 'La contraseña debe tener al menos 6 caracteres.' };
  }
  if (!cleanCode) {
    return { error: 'Se requiere un código de invitación válido.' };
  }

  const store = loadStore();
  const exists = store.users.some(u => u.username.toLowerCase() === cleanUser.toLowerCase());
  if (exists) {
    return { error: 'Ese nombre de usuario ya está registrado.' };
  }

  const invite = store.invites.find(i => i.code.toUpperCase() === cleanCode);
  if (!invite) {
    return { error: 'Código de invitación inválido o inexistente.' };
  }
  if (invite.revoked) {
    return { error: 'Este código de invitación fue revocado.' };
  }
  if (invite.used_count >= invite.max_uses) {
    return { error: 'Este código de invitación ya alcanzó su límite de usos.' };
  }

  const newUser = {
    id: 'usr_' + crypto.randomBytes(6).toString('hex'),
    username: cleanUser,
    passwordHash: hashPassword(password),
    is_admin: false,
    active: true,
    invited_by_code: invite.code,
    created_at: new Date().toISOString()
  };

  invite.used_count += 1;
  invite.used_by = invite.used_by || [];
  invite.used_by.push({ username: cleanUser, at: newUser.created_at });

  store.users.push(newUser);
  saveStore(store);

  return { user: newUser };
}

const EPHEMERAL_TTL_MS = 3 * 60 * 1000; // 3 minutes max lifetime on VPS for ephemeral search/YouTube streams
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours max lifetime on VPS for unconfirmed user uploads
const RAW_ORPHAN_TTL_MS = 10 * 60 * 1000; // 10 minutes safety margin for orphaned .raw.* files
const UPLOAD_STAGE_ORPHAN_TTL_MS = 15 * 60 * 1000; // 15 minutes safety margin for orphaned upload staging files

if (!global.__activeRawSlugs) {
  global.__activeRawSlugs = new Set();
}
const activeRawSlugs = global.__activeRawSlugs;

if (!global.__activeUploadIds) {
  global.__activeUploadIds = new Set();
}
const activeUploadIds = global.__activeUploadIds;

export function registerActiveRawJob(baseSlug) {
  if (baseSlug) activeRawSlugs.add(String(baseSlug));
}

export function unregisterActiveRawJob(baseSlug) {
  if (baseSlug) activeRawSlugs.delete(String(baseSlug));
}

export function registerActiveUpload(uploadId) {
  if (uploadId) activeUploadIds.add(String(uploadId));
}

export function unregisterActiveUpload(uploadId) {
  if (uploadId) activeUploadIds.delete(String(uploadId));
}

function isProtectedUploadArtifact(filename) {
  for (const id of activeUploadIds) {
    if (filename === id || filename.startsWith(`${id}.`) || filename.startsWith(`${id}__`)) {
      return true;
    }
  }
  return false;
}

export function addUserUploadRecord(record) {
  const store = loadStore();
  if (!Array.isArray(store.uploads)) store.uploads = [];
  const normalized = {
    id: String(record.id),
    userId: String(record.userId),
    title: String(record.title || 'Canción'),
    artist: String(record.artist || 'Archivo propio'),
    album: String(record.album || 'Mi música'),
    duration: String(record.duration || '—'),
    durationSec: Number.isFinite(record.durationSec) ? record.durationSec : null,
    filename: String(record.filename),
    streamUrl: String(record.streamUrl || `/api/stream?file=${encodeURIComponent(record.filename)}`),
    artwork: String(record.artwork || '/icon.svg?v=3'),
    source: 'own',
    fileDeleted: Boolean(record.fileDeleted),
    createdAt: Number(record.createdAt) || Date.now(),
    deletedAt: record.deletedAt || null
  };
  const existingIdx = store.uploads.findIndex(u => u && u.id === normalized.id);
  if (existingIdx >= 0) {
    store.uploads[existingIdx] = normalized;
  } else {
    store.uploads.unshift(normalized);
  }
  saveStore(store);
  return normalized;
}

export function getUserUploadRecords(userId) {
  if (!userId) return [];
  const store = loadStore();
  const list = Array.isArray(store.uploads) ? store.uploads : [];
  return list
    .filter(u => u && u.userId === userId)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

export function getUploadRecordById(id) {
  if (!id) return null;
  const store = loadStore();
  const list = Array.isArray(store.uploads) ? store.uploads : [];
  return list.find(u => u && u.id === id) || null;
}

export function getUploadRecordByFilename(filename) {
  if (!filename) return null;
  const clean = path.basename(String(filename));
  const store = loadStore();
  const list = Array.isArray(store.uploads) ? store.uploads : [];
  return list.find(u => u && u.filename === clean) || null;
}

export function markUploadFileDeleted(id, deletedAt = Date.now()) {
  if (!id) return null;
  const store = loadStore();
  if (!Array.isArray(store.uploads)) store.uploads = [];
  const rec = store.uploads.find(u => u && u.id === id);
  if (!rec) return null;
  if (!rec.fileDeleted) {
    rec.fileDeleted = true;
    rec.deletedAt = deletedAt;
    saveStore(store);
  }
  return rec;
}

export function purgeExpiredUploads(now = Date.now()) {
  const dir = getDownloadsDir();
  const store = loadStore();
  if (!Array.isArray(store.uploads)) store.uploads = [];
  let storeChanged = false;
  let purgedCount = 0;
  const purgedIds = [];

  for (const rec of store.uploads) {
    if (!rec || !rec.filename) continue;
    if (isProtectedUploadArtifact(rec.id)) continue;
    const ageMs = now - (Number(rec.createdAt) || 0);
    if (!rec.fileDeleted && ageMs >= UPLOAD_TTL_MS) {
      const safeName = path.basename(rec.filename);
      const targetPath = path.join(dir, safeName);
      try {
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
          purgedCount += 1;
        }
      } catch {}
      rec.fileDeleted = true;
      rec.deletedAt = now;
      storeChanged = true;
      purgedIds.push(rec.id);
    }
  }

  const byFilename = new Map();
  for (const rec of store.uploads) {
    if (rec && rec.filename) {
      byFilename.set(path.basename(rec.filename), rec);
    }
  }

  try {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (!name.startsWith('upl_')) continue;
      if (isProtectedUploadArtifact(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        const isUploadStaging =
          name.includes('.raw.') || /\.(part|temp|ytdl)$/i.test(name);
        if (isUploadStaging) {
          if (now - stat.mtimeMs > UPLOAD_STAGE_ORPHAN_TTL_MS) {
            fs.unlinkSync(full);
          }
          continue;
        }

        const rec = byFilename.get(name);
        const expiredOnDisk = now - stat.mtimeMs >= UPLOAD_TTL_MS;
        const expiredInRecord =
          rec && (rec.fileDeleted || now - (Number(rec.createdAt) || 0) >= UPLOAD_TTL_MS);

        if (expiredInRecord || (!rec && expiredOnDisk)) {
          fs.unlinkSync(full);
          purgedCount += 1;
          if (rec && !rec.fileDeleted) {
            rec.fileDeleted = true;
            rec.deletedAt = now;
            storeChanged = true;
            purgedIds.push(rec.id);
          }
        }
      } catch {}
    }
  } catch {}

  if (storeChanged) {
    saveStore(store);
  }

  return { purgedCount, purgedIds };
}

export function purgeTempAndExpiredFiles(now = Date.now()) {
  purgeExpiredUploads(now);
  const dir = getDownloadsDir();
  try {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (name.startsWith('upl_')) {
        // Handled above by purgeExpiredUploads with 24h TTL and active-upload protection
        continue;
      }
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (name.includes('.raw.')) {
          const isProtected = Array.from(activeRawSlugs).some(slug =>
            name.startsWith(`${slug}.raw.`)
          );
          if (!isProtected && now - stat.mtimeMs > RAW_ORPHAN_TTL_MS) {
            fs.unlinkSync(full);
          }
          continue;
        }

        const isTempResidue = /\.(part|ytdl|webp|jpg|jpeg|png|temp)$/i.test(name);
        const isWebmResidue = /\.webm$/i.test(name);
        const isExpiredAudio =
          /\.(mp3|m4a|opus|wav|flac)$/i.test(name) && now - stat.mtimeMs > EPHEMERAL_TTL_MS;

        if (
          (isTempResidue && now - stat.mtimeMs > 15000) ||
          (isWebmResidue && now - stat.mtimeMs > 60000) ||
          isExpiredAudio
        ) {
          fs.unlinkSync(full);
        }
      } catch {}
    }
  } catch {}
}

export function scheduleFileCleanup(filePath, delayMs = 90000) {
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }, delayMs);
}

export function getStorageStats() {
  purgeTempAndExpiredFiles();
  const dir = getDownloadsDir();
  const maxMB = getMaxStorageMB();
  const files = fs
    .readdirSync(dir)
    .filter(f => !f.includes('.raw.') && /\.(mp3|m4a|opus|wav|flac)$/i.test(f))
    .map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, full, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  return {
    usedMB: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    maxMB,
    fileCount: files.length,
    dir
  };
}

export function enforceStorageQuota() {
  purgeTempAndExpiredFiles();
  const dir = getDownloadsDir();
  const maxBytes = getMaxStorageMB() * 1024 * 1024;
  const files = fs
    .readdirSync(dir)
    .filter(
      f =>
        !f.includes('.raw.') &&
        !isProtectedUploadArtifact(f) &&
        /\.(mp3|m4a|opus|wav|flac)$/i.test(f)
    )
    .map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, full, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => {
      const aUpl = a.name.startsWith('upl_');
      const bUpl = b.name.startsWith('upl_');
      if (aUpl !== bUpl) return aUpl ? 1 : -1;
      return a.mtimeMs - b.mtimeMs;
    });

  let totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  while (totalBytes > maxBytes && files.length > 1) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(oldest.full);
      totalBytes -= oldest.size;
      if (oldest.name.startsWith('upl_')) {
        const rec = getUploadRecordByFilename(oldest.name);
        if (rec) markUploadFileDeleted(rec.id);
      }
    } catch {
      break;
    }
  }
}

function getYtCookiesDefaultPath() {
  return path.join(getDataDir(), 'cookies.txt');
}

export function getYtCookiesFilePath() {
  const dataDir = getDataDir();
  const envCookiePath = process.env.YTDLP_COOKIES?.trim()
    ? path.resolve(/*turbopackIgnore: true*/ process.env.YTDLP_COOKIES.trim())
    : null;
  const candidates = [
    envCookiePath,
    getYtCookiesDefaultPath(),
    path.join(dataDir, 'youtube_cookies.txt')
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
        const stat = fs.statSync(/*turbopackIgnore: true*/ p);
        if (stat.isFile() && stat.size > 30) {
          return p;
        }
      }
    } catch {}
  }
  return null;
}

export function getYtCookiesStatus() {
  const activePath = getYtCookiesFilePath();
  if (!activePath) {
    return { configured: false, lineCount: 0, cookieLines: 0, updatedAt: null };
  }
  try {
    const stat = fs.statSync(/*turbopackIgnore: true*/ activePath);
    const raw = fs.readFileSync(/*turbopackIgnore: true*/ activePath, 'utf8');
    const validLines = raw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#')).length;
    return {
      configured: validLines > 0,
      lineCount: validLines,
      cookieLines: validLines,
      updatedAt: new Date(stat.mtimeMs).toISOString()
    };
  } catch {
    return { configured: false, lineCount: 0, cookieLines: 0, updatedAt: null };
  }
}

function convertJsonCookiesToNetscape(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cookies)
    ? parsed.cookies
    : null;
  if (!list || list.length === 0) return null;

  const lines = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    '# This file was generated by libcurl! Edit at your own risk.',
    ''
  ];

  for (const c of list) {
    if (!c || !c.name || typeof c.value === 'undefined') continue;
    let domain = String(c.domain || '.youtube.com').trim();
    const includeSubdomains = domain.startsWith('.') || c.hostOnly === false;
    if (includeSubdomains && !domain.startsWith('.')) {
      domain = `.${domain}`;
    }
    const cookiePath = String(c.path || '/').trim() || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const rawExp = Number(c.expirationDate ?? c.expiry ?? c.expires ?? 0);
    const expiry = Number.isFinite(rawExp) && rawExp > 0 ? Math.floor(rawExp) : 0;
    const name = String(c.name).replace(/[\r\n\t]/g, '');
    const value = String(c.value ?? '').replace(/[\r\n\t]/g, '');
    lines.push(
      `${domain}\t${includeSubdomains ? 'TRUE' : 'FALSE'}\t${cookiePath}\t${secure}\t${expiry}\t${name}\t${value}`
    );
  }

  return `${lines.join('\n')}\n`;
}

export function saveYtCookiesFile(rawContent) {
  const text = String(rawContent || '').trim();
  if (!text) {
    throw new Error('El contenido de cookies está vacío.');
  }
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  let normalized = null;
  if (text.startsWith('[') || text.startsWith('{')) {
    normalized = convertJsonCookiesToNetscape(text);
    if (!normalized) {
      throw new Error('El JSON de cookies no tiene un formato válido.');
    }
  } else {
    const hasHeader = /^#\s*Netscape HTTP Cookie File/i.test(text);
    normalized = hasHeader
      ? `${text}\n`
      : `# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n\n${text}\n`;
  }

  fs.writeFileSync(getYtCookiesDefaultPath(), normalized, { encoding: 'utf8', mode: 0o600 });
  return getYtCookiesStatus();
}

export function clearYtCookiesFile() {
  try {
    const cookiesFile = getYtCookiesDefaultPath();
    if (fs.existsSync(cookiesFile)) {
      fs.unlinkSync(cookiesFile);
    }
  } catch {}
  return getYtCookiesStatus();
}
