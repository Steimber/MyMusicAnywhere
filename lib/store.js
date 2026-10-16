import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');

const STORE_FILE = path.join(DATA_DIR, 'store.json');

export function getDownloadsDir() {
  const dir = process.env.DOWNLOADS_DIR
    ? path.resolve(process.env.DOWNLOADS_DIR)
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
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  let store = {
    secret: crypto.randomBytes(32).toString('hex'),
    users: [],
    invites: []
  };

  if (fs.existsSync(STORE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      store = {
        secret: raw.secret || store.secret,
        users: Array.isArray(raw.users) ? raw.users : [],
        invites: Array.isArray(raw.invites) ? raw.invites : []
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
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
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
    const cookie = request.cookies?.get('mymusic_session')?.value;
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

const EPHEMERAL_TTL_MS = 3 * 60 * 1000; // 3 minutes max lifetime on VPS

export function purgeTempAndExpiredFiles() {
  const dir = getDownloadsDir();
  const now = Date.now();
  try {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        const isTempResidue = /\.(part|ytdl|webp|jpg|jpeg|png|temp)$/i.test(name);
        const isExpiredAudio =
          /\.(mp3|m4a|opus|wav|flac)$/i.test(name) && now - stat.mtimeMs > EPHEMERAL_TTL_MS;

        if ((isTempResidue && now - stat.mtimeMs > 15000) || isExpiredAudio) {
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
    .filter(f => /\.(mp3|m4a|opus|wav|flac)$/i.test(f))
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
    .filter(f => /\.(mp3|m4a|opus|wav|flac)$/i.test(f))
    .map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, full, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  while (totalBytes > maxBytes && files.length > 1) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(oldest.full);
      totalBytes -= oldest.size;
    } catch {
      break;
    }
  }
}
