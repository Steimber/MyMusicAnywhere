import { NextResponse } from 'next/server';
import {
  loadStore,
  verifyPassword,
  createSessionToken,
  getSessionUser,
  createUserWithInvite
} from '../../../lib/store';

const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const AUTH_MAX_ATTEMPTS_USER = 5;
const AUTH_MAX_ATTEMPTS_IP = 20;
const AUTH_MAX_TRACKED_KEYS = 5000;

if (!global.__authRateLimiter) {
  global.__authRateLimiter = new Map();
}
const authRateLimiter = global.__authRateLimiter;

function getMaxAttemptsForKey(key) {
  return String(key).startsWith('ip:') ? AUTH_MAX_ATTEMPTS_IP : AUTH_MAX_ATTEMPTS_USER;
}

function getClientIp(request) {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

function getActiveAttemptRecord(key, now = Date.now()) {
  if (!key) return null;
  const rec = authRateLimiter.get(key);
  if (!rec) return null;
  if (now - rec.firstAttemptAt > AUTH_WINDOW_MS) {
    authRateLimiter.delete(key);
    return null;
  }
  return rec;
}

function checkRateLimit(keys) {
  const now = Date.now();
  let retryAfterSec = 0;
  for (const key of keys) {
    const rec = getActiveAttemptRecord(key, now);
    const maxAttempts = getMaxAttemptsForKey(key);
    if (rec && rec.count >= maxAttempts) {
      const remainingMs = Math.max(1000, AUTH_WINDOW_MS - (now - rec.firstAttemptAt));
      retryAfterSec = Math.max(retryAfterSec, Math.ceil(remainingMs / 1000));
    }
  }
  return { blocked: retryAfterSec > 0, retryAfterSec };
}

function recordFailedAttempt(keys) {
  const now = Date.now();
  for (const key of keys) {
    if (!key) continue;
    const existing = getActiveAttemptRecord(key, now);
    if (existing) {
      existing.count += 1;
      existing.lastAttemptAt = now;
    } else {
      if (authRateLimiter.size >= AUTH_MAX_TRACKED_KEYS) {
        const oldestKey = authRateLimiter.keys().next().value;
        if (oldestKey) authRateLimiter.delete(oldestKey);
      }
      authRateLimiter.set(key, { count: 1, firstAttemptAt: now, lastAttemptAt: now });
    }
  }
}

function clearFailedAttempts(keys) {
  for (const key of keys) {
    if (key) authRateLimiter.delete(key);
  }
}

function getSessionCookieOptions(maxAge) {
  return {
    httpOnly: true,
    path: '/',
    maxAge,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  };
}

export async function GET(request) {
  const user = getSessionUser(request);
  return NextResponse.json({ user });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { action, username, password, inviteCode } = body;

    if (action === 'logout') {
      const res = NextResponse.json({ ok: true });
      res.cookies.set('mymusic_session', '', getSessionCookieOptions(0));
      return res;
    }

    const cleanUser = (username || '').trim();
    const clientIp = getClientIp(request);
    const rateKeys = [
      `ip:${clientIp}`,
      cleanUser ? `user:${cleanUser.toLowerCase()}` : null
    ].filter(Boolean);

    const limitStatus = checkRateLimit(rateKeys);
    if (limitStatus.blocked) {
      return NextResponse.json(
        {
          error: 'Demasiados intentos fallidos. Espera 15 minutos antes de volver a intentar.'
        },
        {
          status: 429,
          headers: { 'Retry-After': String(limitStatus.retryAfterSec) }
        }
      );
    }

    if (action === 'register') {
      const result = createUserWithInvite(username, password, inviteCode);
      if (result.error) {
        recordFailedAttempt(rateKeys);
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      clearFailedAttempts(rateKeys);
      const token = createSessionToken(result.user);
      const res = NextResponse.json({
        user: {
          id: result.user.id,
          username: result.user.username,
          is_admin: Boolean(result.user.is_admin)
        }
      });
      res.cookies.set(
        'mymusic_session',
        token,
        getSessionCookieOptions(60 * 60 * 24 * 30)
      );
      return res;
    }

    // Default: login
    const store = loadStore();
    const user = store.users.find(
      u => u.username.toLowerCase() === cleanUser.toLowerCase()
    );

    if (!user || !verifyPassword(password || '', user.passwordHash)) {
      recordFailedAttempt(rateKeys);
      return NextResponse.json(
        { error: 'Usuario o contraseña incorrectos.' },
        { status: 401 }
      );
    }

    if (!user.active) {
      recordFailedAttempt(rateKeys);
      return NextResponse.json(
        { error: 'Esta cuenta ha sido desactivada por el administrador.' },
        { status: 403 }
      );
    }

    clearFailedAttempts(rateKeys);
    const token = createSessionToken(user);
    const res = NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        is_admin: Boolean(user.is_admin)
      }
    });
    res.cookies.set(
      'mymusic_session',
      token,
      getSessionCookieOptions(60 * 60 * 24 * 30)
    );
    return res;
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
