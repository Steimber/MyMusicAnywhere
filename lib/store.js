import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  mergeCollectionsSnapshots,
  normalizeTombstoneList
} from './collections-merge.js';

export const USER_ID_REGEX = /^usr_[a-zA-Z0-9_-]{2,48}$/;
export const COVER_ID_REGEX = /^upl_[a-f0-9]{32}$/;
export const MAX_USER_UPLOAD_QUOTA_BYTES = 300 * 1024 * 1024; // 300 MB per user on VPS

if (!global.__inMemoryDefaultStores) {
  global.__inMemoryDefaultStores = new Map();
}
const inMemoryDefaultStores = global.__inMemoryDefaultStores;

export function getDataDir() {
  return process.env.DATA_DIR
    ? path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR)
    : path.join(process.cwd(), 'data');
}

function getStoreFile() {
  return path.join(getDataDir(), 'store.json');
}

export function isValidUserId(userId) {
  if (typeof userId !== 'string') return false;
  const trimmed = userId.trim();
  if (!trimmed || !USER_ID_REGEX.test(trimmed)) return false;
  return path.basename(trimmed) === trimmed;
}

export function resolveSafeUserJsonPath(subDirName, userId) {
  if (!isValidUserId(userId)) return null;
  const cleanUserId = path.basename(userId.trim());
  if (!USER_ID_REGEX.test(cleanUserId)) return null;

  const baseDir = path.resolve(getDataDir(), subDirName);
  const targetPath = path.resolve(baseDir, `${cleanUserId}.json`);
  if (!targetPath.startsWith(baseDir + path.sep)) {
    return null;
  }
  return targetPath;
}

export function writeJsonFileAtomic(targetPath, data) {
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  const serialized = JSON.stringify(data, null, 2);
  const tmpFile = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpFile, serialized, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tmpFile, targetPath);
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
        fs.writeFileSync(targetPath, serialized, { encoding: 'utf8', mode: 0o600 });
      } else {
        throw err;
      }
    }
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {}
  } finally {
    try {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    } catch {}
  }
}

export function writeBinaryFileAtomic(targetPath, buffer) {
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  const tmpFile = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpFile, buffer, { mode: 0o600 });
    try {
      fs.renameSync(tmpFile, targetPath);
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
        fs.writeFileSync(targetPath, buffer, { mode: 0o600 });
      } else {
        throw err;
      }
    }
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {}
  } finally {
    try {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    } catch {}
  }
}

export function resolveSafeCoverPath(uploadId) {
  if (typeof uploadId !== 'string') return null;
  const trimmed = uploadId.trim();
  if (!trimmed || !COVER_ID_REGEX.test(trimmed)) return null;
  const cleanId = path.basename(trimmed);
  if (cleanId !== trimmed || !COVER_ID_REGEX.test(cleanId)) return null;

  const coversDir = path.resolve(getDataDir(), 'covers');
  const targetPath = path.resolve(coversDir, `${cleanId}.jpg`);
  if (!targetPath.startsWith(coversDir + path.sep)) {
    return null;
  }
  return targetPath;
}

export function saveUploadCoverBuffer(uploadId, jpegBuffer) {
  const targetPath = resolveSafeCoverPath(uploadId);
  if (!targetPath || !Buffer.isBuffer(jpegBuffer)) return null;
  if (jpegBuffer.length < 32 || jpegBuffer.length > 64 * 1024) return null;
  if (jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) return null;
  writeBinaryFileAtomic(targetPath, jpegBuffer);
  return `/api/cover/${uploadId.trim()}`;
}

export function saveUploadCoverFromDataUrl(uploadId, dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.trim().match(/^data:image\/(?:jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    const buf = Buffer.from(match[1], 'base64');
    return saveUploadCoverBuffer(uploadId, buf);
  } catch {
    return null;
  }
}

export function readUploadCoverBuffer(uploadId) {
  const targetPath = resolveSafeCoverPath(uploadId);
  if (!targetPath) {
    return { ok: false, status: 400, error: 'Identificador de portada inválido.' };
  }
  if (!fs.existsSync(targetPath)) {
    return { ok: false, status: 404, error: 'Portada no encontrada.' };
  }
  try {
    const buffer = fs.readFileSync(targetPath);
    return { ok: true, status: 200, buffer };
  } catch {
    return { ok: false, status: 500, error: 'No se pudo leer la portada.' };
  }
}

export function deleteUploadCoverFile(uploadId) {
  const targetPath = resolveSafeCoverPath(uploadId);
  if (!targetPath) return false;
  try {
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      return true;
    }
  } catch {}
  return false;
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

function getOrCreateInMemoryBootstrap(storeFile) {
  let entry = inMemoryDefaultStores.get(storeFile);
  if (!entry) {
    entry = {
      secret: crypto.randomBytes(32).toString('hex'),
      adminUsername: '',
      adminPasswordHash: '',
      adminCreatedAt: new Date().toISOString()
    };
    inMemoryDefaultStores.set(storeFile, entry);
  }
  const adminUsername = (process.env.ADMIN_USERNAME || 'steimber').trim();
  const configuredPassword = process.env.ADMIN_PASSWORD || '';
  if (!entry.adminPasswordHash || entry.adminUsername.toLowerCase() !== adminUsername.toLowerCase()) {
    entry.adminUsername = adminUsername;
    entry.adminPasswordHash = hashPassword(
      configuredPassword || crypto.randomBytes(12).toString('base64url')
    );
  } else if (configuredPassword && !verifyPassword(configuredPassword, entry.adminPasswordHash)) {
    entry.adminPasswordHash = hashPassword(configuredPassword);
  }
  return entry;
}

function applyAdminUserInMemory(store, fallbackBootstrap) {
  const adminUsername = (process.env.ADMIN_USERNAME || 'steimber').trim();
  const existingAdmin = store.users.find(
    u => u && typeof u.username === 'string' && u.username.toLowerCase() === adminUsername.toLowerCase()
  );

  if (!existingAdmin) {
    store.users.unshift({
      id: 'usr_admin',
      username: adminUsername,
      passwordHash: fallbackBootstrap.adminPasswordHash,
      is_admin: true,
      active: true,
      created_at: fallbackBootstrap.adminCreatedAt
    });
    return true;
  }

  if (process.env.ADMIN_PASSWORD && !verifyPassword(process.env.ADMIN_PASSWORD, existingAdmin.passwordHash)) {
    existingAdmin.passwordHash = hashPassword(process.env.ADMIN_PASSWORD);
    existingAdmin.is_admin = true;
    existingAdmin.active = true;
    return true;
  }

  return false;
}

export function loadStore() {
  const storeFile = getStoreFile();
  const bootstrap = getOrCreateInMemoryBootstrap(storeFile);

  let store = {
    secret: bootstrap.secret,
    users: [],
    invites: [],
    uploads: []
  };

  if (fs.existsSync(storeFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      store = {
        secret: raw.secret || bootstrap.secret,
        users: Array.isArray(raw.users) ? raw.users : [],
        invites: Array.isArray(raw.invites) ? raw.invites : [],
        uploads: Array.isArray(raw.uploads) ? raw.uploads : []
      };
    } catch {
      // Keep default structure in memory if corrupted
    }
  }

  applyAdminUserInMemory(store, bootstrap);
  return store;
}

export function saveStore(store, options = {}) {
  const storeFile = getStoreFile();
  const cleanStore = {
    secret: store.secret,
    users: Array.isArray(store.users) ? store.users : [],
    invites: Array.isArray(store.invites) ? store.invites : [],
    uploads: Array.isArray(store.uploads) ? store.uploads : []
  };

  if (!options.dropLegacyCollections && fs.existsSync(storeFile)) {
    try {
      const existingRaw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      if (
        existingRaw &&
        existingRaw.collections &&
        typeof existingRaw.collections === 'object' &&
        !Array.isArray(existingRaw.collections)
      ) {
        cleanStore.collections = existingRaw.collections;
      }
    } catch {}
  }

  writeJsonFileAtomic(storeFile, cleanStore);
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

function cleanScalarText(raw, maxLen = 120) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function sanitizeArtworkField(rawArtwork, uploadId = null) {
  if (typeof rawArtwork !== 'string') return '/icon.svg?v=3';
  const trimmed = rawArtwork.trim();
  if (!trimmed || trimmed === '/icon.svg' || trimmed === '/icon.svg?v=3') {
    return '/icon.svg?v=3';
  }
  if (/^data:image\//i.test(trimmed)) {
    if (uploadId && COVER_ID_REGEX.test(String(uploadId).trim())) {
      const savedCoverUrl = saveUploadCoverFromDataUrl(String(uploadId).trim(), trimmed);
      if (savedCoverUrl) return savedCoverUrl;
    }
    return '/icon.svg?v=3';
  }
  if (/^\/api\/cover\/upl_[a-f0-9]{32}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^https?:\/\/[^\s"'<>]{4,600}$/i.test(trimmed)) {
    return trimmed;
  }
  return '/icon.svg?v=3';
}

function sanitizeOptionalHttpUrl(rawUrl, maxLen = 600) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return /^https?:\/\/[^\s"'<>]+$/i.test(trimmed) ? trimmed : null;
}

function sanitizeCollectionTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanScalarText(raw.id, 120);
  const title = cleanScalarText(raw.title, 140);
  if (!id || !title || id.startsWith('offline_')) return null;

  const rawFilename = typeof raw.filename === 'string' && raw.filename.trim()
    ? path.basename(raw.filename.trim()).slice(0, 180)
    : null;
  const filename = rawFilename && rawFilename !== '.' && rawFilename !== '..' ? rawFilename : null;

  let streamUrl = null;
  if (typeof raw.streamUrl === 'string' && raw.streamUrl.trim().startsWith('/api/stream?')) {
    streamUrl = raw.streamUrl.trim().slice(0, 260);
  } else if (filename) {
    streamUrl = `/api/stream?file=${encodeURIComponent(filename)}`;
  }

  const uploadIdCandidate = cleanScalarText(raw.uploadId, 48);
  const uploadId = /^upl_[a-f0-9]{32}$/.test(uploadIdCandidate)
    ? uploadIdCandidate
    : /^upl_[a-f0-9]{32}$/.test(id)
    ? id
    : null;

  const durationSecNum = Number(raw.durationSec);
  const addedAtNum = Number(raw.addedAt);
  const updatedAtNum = Number(raw.updatedAt);
  const safeAddedAt =
    Number.isFinite(addedAtNum) && addedAtNum > 0 ? Math.round(addedAtNum) : Date.now();
  const safeUpdatedAt =
    Number.isFinite(updatedAtNum) && updatedAtNum > 0 ? Math.round(updatedAtNum) : safeAddedAt;

  return {
    id,
    title,
    artist: cleanScalarText(raw.artist, 120) || 'Artista',
    album: cleanScalarText(raw.album, 120) || 'Single',
    genre: cleanScalarText(raw.genre, 60) || 'Música',
    artwork: sanitizeArtworkField(raw.artwork, uploadId),
    previewUrl: sanitizeOptionalHttpUrl(raw.previewUrl),
    duration: cleanScalarText(raw.duration, 16) || '—',
    durationSec: Number.isFinite(durationSecNum) && durationSecNum >= 0 ? Math.round(durationSecNum) : null,
    source: raw.source === 'own' || uploadId ? 'own' : undefined,
    sourceUrl: sanitizeOptionalHttpUrl(raw.sourceUrl),
    uploadId,
    fileDeleted: Boolean(raw.fileDeleted),
    filename,
    streamUrl,
    addedAt: safeAddedAt,
    updatedAt: safeUpdatedAt
  };
}

function sanitizeCollectionPlaylists(rawPlaylists) {
  if (!Array.isArray(rawPlaylists)) return [];
  const result = [];
  const seenIds = new Set();
  for (const pl of rawPlaylists.slice(0, 100)) {
    if (!pl || typeof pl !== 'object') continue;
    const id = cleanScalarText(pl.id, 80);
    const name = cleanScalarText(pl.name, 80);
    if (!id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    const createdAtNum = Number(pl.createdAt);
    const updatedAtNum = Number(pl.updatedAt);
    const safeCreatedAt =
      Number.isFinite(createdAtNum) && createdAtNum > 0 ? Math.round(createdAtNum) : Date.now();
    const safeUpdatedAt =
      Number.isFinite(updatedAtNum) && updatedAtNum > 0 ? Math.round(updatedAtNum) : safeCreatedAt;
    const tracks = Array.isArray(pl.tracks)
      ? pl.tracks.slice(0, 1500).map(sanitizeCollectionTrack).filter(Boolean)
      : [];
    const deletedTracks = normalizeTombstoneList(pl.deletedTracks);
    result.push({
      id,
      name,
      createdAt: safeCreatedAt,
      updatedAt: safeUpdatedAt,
      tracks,
      deletedTracks
    });
  }
  return result;
}

function normalizeCollectionFilePayload(raw = {}) {
  const versionNum = Number(raw.version);
  const version = Number.isInteger(versionNum) && versionNum >= 1 ? versionNum : 1;
  const likedTracks = Array.isArray(raw.likedTracks)
    ? raw.likedTracks.slice(0, 2000).map(sanitizeCollectionTrack).filter(Boolean)
    : [];
  const deletedLikes = normalizeTombstoneList(raw.deletedLikes);
  const customPlaylists = sanitizeCollectionPlaylists(raw.customPlaylists);
  const deletedPlaylists = normalizeTombstoneList(raw.deletedPlaylists);
  const updatedAt = Number(raw.updatedAt) > 0 ? Math.round(Number(raw.updatedAt)) : Date.now();
  return {
    version,
    updatedAt,
    likedTracks,
    deletedLikes,
    customPlaylists,
    deletedPlaylists
  };
}

function migrateLegacyCollectionsMap(legacyMap, writeCollectionFile = writeJsonFileAtomic) {
  if (!legacyMap || typeof legacyMap !== 'object' || Array.isArray(legacyMap)) {
    return { allSucceeded: true, migratedCount: 0, failedUsers: [] };
  }
  const failedUsers = [];
  let migratedCount = 0;

  for (const [uid, colEntry] of Object.entries(legacyMap)) {
    if (!colEntry || typeof colEntry !== 'object' || Array.isArray(colEntry)) continue;
    const targetPath = resolveSafeUserJsonPath('collections', uid);
    if (!targetPath) {
      failedUsers.push(uid);
      continue;
    }

    try {
      const incoming = normalizeCollectionFilePayload(colEntry);
      let payloadToWrite = incoming;
      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
          throw new Error('Collection path collides with directory');
        }
        try {
          const existingRaw = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
          const existing = normalizeCollectionFilePayload(existingRaw);
          const merged = mergeCollectionsSnapshots(existing, incoming);
          payloadToWrite = {
            version: Math.max(existing.version, incoming.version),
            updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
            likedTracks: merged.likedTracks.map(sanitizeCollectionTrack).filter(Boolean),
            deletedLikes: merged.deletedLikes,
            customPlaylists: sanitizeCollectionPlaylists(merged.customPlaylists),
            deletedPlaylists: merged.deletedPlaylists
          };
        } catch {
          // Overwrite corrupted JSON file with valid legacy data
        }
      }
      writeCollectionFile(targetPath, payloadToWrite);
      migratedCount += 1;
    } catch {
      failedUsers.push(uid);
    }
  }

  return {
    allSucceeded: failedUsers.length === 0,
    migratedCount,
    failedUsers
  };
}

export function runStartupMigrations(options = {}) {
  const { writeCollectionFile = writeJsonFileAtomic } = options;
  const storeFile = getStoreFile();
  const bootstrap = getOrCreateInMemoryBootstrap(storeFile);
  const storeExistsOnDisk = fs.existsSync(storeFile);

  let raw = null;
  let store = {
    secret: bootstrap.secret,
    users: [],
    invites: [],
    uploads: []
  };

  if (storeExistsOnDisk) {
    try {
      raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      store = {
        secret: raw.secret || bootstrap.secret,
        users: Array.isArray(raw.users) ? raw.users : [],
        invites: Array.isArray(raw.invites) ? raw.invites : [],
        uploads: Array.isArray(raw.uploads) ? raw.uploads : []
      };
    } catch {
      // Keep default structure if unreadable
    }
  }

  let needsStoreSave = !storeExistsOnDisk;
  if (applyAdminUserInMemory(store, bootstrap)) {
    needsStoreSave = true;
  }

  if (Array.isArray(store.uploads)) {
    for (const u of store.uploads) {
      if (u && typeof u.artwork === 'string' && u.artwork.trim().startsWith('data:image/')) {
        u.artwork = sanitizeArtworkField(u.artwork, u.id);
        needsStoreSave = true;
      }
    }
  }

  const hasLegacyCollections =
    Boolean(raw) &&
    Boolean(raw.collections) &&
    typeof raw.collections === 'object' &&
    !Array.isArray(raw.collections);

  if (hasLegacyCollections) {
    const migRes = migrateLegacyCollectionsMap(raw.collections, writeCollectionFile);
    if (migRes.allSucceeded) {
      saveStore(store, { dropLegacyCollections: true });
      return {
        ok: true,
        migrated: true,
        partialFailure: false,
        failedUsers: []
      };
    }

    if (needsStoreSave) {
      saveStore(store, { dropLegacyCollections: false });
    }
    return {
      ok: false,
      migrated: false,
      partialFailure: true,
      failedUsers: migRes.failedUsers
    };
  }

  if (needsStoreSave) {
    saveStore(store, { dropLegacyCollections: false });
  }

  return {
    ok: true,
    migrated: false,
    partialFailure: false,
    failedUsers: []
  };
}

export function migrateLegacyCollectionsIfNeeded(options = {}) {
  return runStartupMigrations(options);
}

export function getUserCollections(userId) {
  const filePath = resolveSafeUserJsonPath('collections', userId);
  if (!filePath) {
    return {
      ok: false,
      status: 400,
      error: 'Identificador de usuario inválido.'
    };
  }

  if (!fs.existsSync(filePath)) {
    return {
      ok: true,
      hasSnapshot: false,
      version: 0,
      likedTracks: [],
      deletedLikes: [],
      customPlaylists: [],
      deletedPlaylists: [],
      updatedAt: null
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalized = normalizeCollectionFilePayload(raw);
    return {
      ok: true,
      hasSnapshot: true,
      ...normalized
    };
  } catch {
    return {
      ok: true,
      hasSnapshot: false,
      version: 0,
      likedTracks: [],
      deletedLikes: [],
      customPlaylists: [],
      deletedPlaylists: [],
      updatedAt: null
    };
  }
}

export function saveUserCollections(userId, payload = {}) {
  const filePath = resolveSafeUserJsonPath('collections', userId);
  if (!filePath) {
    return {
      ok: false,
      status: 400,
      error: 'Identificador de usuario inválido.'
    };
  }

  const current = getUserCollections(userId);
  if (!current.ok) return current;

  const hasBaseVersion = payload.baseVersion !== undefined && payload.baseVersion !== null;

  if (current.hasSnapshot) {
    if (!hasBaseVersion || !Number.isInteger(payload.baseVersion) || payload.baseVersion < 0) {
      return {
        ok: false,
        status: 400,
        error: 'Se requiere baseVersion entero para guardar las colecciones.'
      };
    }
    if (payload.baseVersion !== current.version) {
      return {
        ok: false,
        status: 409,
        conflict: true,
        snapshot: current
      };
    }
  } else if (hasBaseVersion) {
    if (!Number.isInteger(payload.baseVersion) || payload.baseVersion < 0) {
      return {
        ok: false,
        status: 400,
        error: 'El campo baseVersion debe ser un entero válido.'
      };
    }
    if (payload.baseVersion !== 0) {
      return {
        ok: false,
        status: 409,
        conflict: true,
        snapshot: current
      };
    }
  }

  const nextLikes = Array.isArray(payload.likedTracks)
    ? payload.likedTracks.slice(0, 2000).map(sanitizeCollectionTrack).filter(Boolean)
    : current.likedTracks;
  const nextDeletedLikes =
    payload.deletedLikes !== undefined
      ? normalizeTombstoneList(payload.deletedLikes)
      : current.deletedLikes;
  const nextPlaylists = Array.isArray(payload.customPlaylists)
    ? sanitizeCollectionPlaylists(payload.customPlaylists)
    : current.customPlaylists;
  const nextDeletedPlaylists =
    payload.deletedPlaylists !== undefined
      ? normalizeTombstoneList(payload.deletedPlaylists)
      : current.deletedPlaylists;

  const nextVersion = current.version + 1;
  const updatedAt = Date.now();
  const nextDoc = {
    version: nextVersion,
    updatedAt,
    likedTracks: nextLikes,
    deletedLikes: nextDeletedLikes,
    customPlaylists: nextPlaylists,
    deletedPlaylists: nextDeletedPlaylists
  };

  writeJsonFileAtomic(filePath, nextDoc);

  return {
    ok: true,
    status: 200,
    snapshot: {
      hasSnapshot: true,
      ...nextDoc
    }
  };
}

export function addUserUploadRecord(record) {
  const store = loadStore();
  if (!Array.isArray(store.uploads)) store.uploads = [];
  const normalized = {
    id: String(record.id),
    userId: String(record.userId),
    title: cleanScalarText(record.title, 120) || 'Canción',
    artist: cleanScalarText(record.artist, 100) || 'Archivo propio',
    album: cleanScalarText(record.album, 100) || 'Mi música',
    duration: cleanScalarText(record.duration, 16) || '—',
    durationSec: Number.isFinite(record.durationSec) ? record.durationSec : null,
    filename: String(record.filename),
    streamUrl: String(record.streamUrl || `/api/stream?file=${encodeURIComponent(record.filename)}`),
    artwork: sanitizeArtworkField(record.artwork, String(record.id)),
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

export function updateUserUploadMetadata(id, userId, patch = {}) {
  if (!id || !userId) {
    return { ok: false, status: 400, error: 'Datos inválidos.' };
  }
  const store = loadStore();
  if (!Array.isArray(store.uploads)) store.uploads = [];
  const rec = store.uploads.find(u => u && u.id === String(id));
  if (!rec) {
    return { ok: false, status: 404, error: 'Canción subida no encontrada.' };
  }
  if (rec.userId !== String(userId)) {
    return { ok: false, status: 403, error: 'No tienes permiso para modificar esta canción.' };
  }

  let changed = false;
  if (typeof patch.title === 'string') {
    const cleanTitle = cleanScalarText(patch.title, 120);
    if (cleanTitle && cleanTitle !== rec.title) {
      rec.title = cleanTitle;
      changed = true;
    }
  }
  if (typeof patch.artist === 'string') {
    const cleanArtist = cleanScalarText(patch.artist, 100);
    if (cleanArtist && cleanArtist !== rec.artist) {
      rec.artist = cleanArtist;
      changed = true;
    }
  }
  if (typeof patch.album === 'string') {
    const cleanAlbum = cleanScalarText(patch.album, 100);
    if (cleanAlbum && cleanAlbum !== rec.album) {
      rec.album = cleanAlbum;
      changed = true;
    }
  }
  if (typeof patch.artwork === 'string') {
    const cleanArt = sanitizeArtworkField(patch.artwork, String(id));
    if (cleanArt !== rec.artwork) {
      const prevArt = rec.artwork;
      rec.artwork = cleanArt;
      if (prevArt === `/api/cover/${id}` && cleanArt !== prevArt) {
        deleteUploadCoverFile(String(id));
      }
      changed = true;
    }
  }

  if (changed) {
    saveStore(store);

    // Propagate metadata update to the user's isolated collection file if present
    const colPath = resolveSafeUserJsonPath('collections', userId);
    if (colPath && fs.existsSync(colPath)) {
      const currentCol = getUserCollections(userId);
      if (currentCol.ok && currentCol.hasSnapshot) {
        const now = Date.now();
        let colTouched = false;
        const applyPatchToTrack = tr => {
          if (!tr || (String(tr.id) !== String(id) && String(tr.uploadId) !== String(id))) {
            return tr;
          }
          colTouched = true;
          return {
            ...tr,
            title: rec.title,
            artist: rec.artist,
            album: rec.album,
            artwork: rec.artwork,
            updatedAt: now
          };
        };
        const updatedLikes = currentCol.likedTracks.map(applyPatchToTrack);
        const updatedPlaylists = currentCol.customPlaylists.map(pl => ({
          ...pl,
          tracks: Array.isArray(pl.tracks) ? pl.tracks.map(applyPatchToTrack) : []
        }));
        if (colTouched) {
          writeJsonFileAtomic(colPath, {
            version: currentCol.version + 1,
            updatedAt: now,
            likedTracks: updatedLikes,
            deletedLikes: currentCol.deletedLikes,
            customPlaylists: updatedPlaylists,
            deletedPlaylists: currentCol.deletedPlaylists
          });
        }
      }
    }
  }

  return { ok: true, status: 200, record: rec };
}

export function getUserUploadRecords(userId) {
  if (!userId) return [];
  const store = loadStore();
  const list = Array.isArray(store.uploads) ? store.uploads : [];
  return list
    .filter(u => u && u.userId === userId)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

export function getUserActiveUploadBytes(userId) {
  if (!userId) return 0;
  purgeExpiredUploads();
  const store = loadStore();
  const downloadsDir = path.resolve(getDownloadsDir());
  const uploads = Array.isArray(store.uploads) ? store.uploads : [];
  let totalBytes = 0;

  for (const rec of uploads) {
    if (!rec || String(rec.userId) !== String(userId) || rec.fileDeleted || !rec.filename) {
      continue;
    }
    const cleanFilename = path.basename(String(rec.filename));
    const targetPath = path.resolve(downloadsDir, cleanFilename);
    if (!targetPath.startsWith(downloadsDir + path.sep)) continue;
    try {
      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        if (stat.isFile()) {
          totalBytes += stat.size;
        }
      }
    } catch {}
  }

  return totalBytes;
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

export function deleteUserUploadRecord(id, userId = null) {
  const cleanId = typeof id === 'string' ? id.trim() : '';
  if (!cleanId || !COVER_ID_REGEX.test(cleanId)) {
    return { ok: false, status: 400, error: 'Identificador de subida inválido.' };
  }

  const store = loadStore();
  if (!Array.isArray(store.uploads)) store.uploads = [];
  const idx = store.uploads.findIndex(u => u && u.id === cleanId);
  if (idx < 0) {
    return { ok: false, status: 404, error: 'Canción subida no encontrada.' };
  }

  const rec = store.uploads[idx];
  if (userId && rec.userId !== String(userId)) {
    return { ok: false, status: 403, error: 'No tienes permiso para eliminar esta canción.' };
  }

  store.uploads.splice(idx, 1);
  saveStore(store);

  let removedFromDisk = false;
  try {
    const downloadsDir = path.resolve(getDownloadsDir());
    const cleanFilename = path.basename(String(rec.filename || `${cleanId}.m4a`));
    const targetPath = path.resolve(downloadsDir, cleanFilename);
    if (targetPath.startsWith(downloadsDir + path.sep) && fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      removedFromDisk = true;
    }
  } catch {}

  const coverDeleted = deleteUploadCoverFile(cleanId);

  return {
    ok: true,
    status: 200,
    id: cleanId,
    removedFromDisk,
    coverDeleted,
    record: rec
  };
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
