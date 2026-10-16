import { NextResponse } from 'next/server';
import {
  loadStore,
  verifyPassword,
  createSessionToken,
  getSessionUser,
  createUserWithInvite
} from '../../../lib/store';

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
      res.cookies.set('mymusic_session', '', {
        httpOnly: true,
        path: '/',
        maxAge: 0,
        sameSite: 'lax'
      });
      return res;
    }

    if (action === 'register') {
      const result = createUserWithInvite(username, password, inviteCode);
      if (result.error) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      const token = createSessionToken(result.user);
      const res = NextResponse.json({
        user: {
          id: result.user.id,
          username: result.user.username,
          is_admin: Boolean(result.user.is_admin)
        }
      });
      res.cookies.set('mymusic_session', token, {
        httpOnly: true,
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
        sameSite: 'lax'
      });
      return res;
    }

    // Default: login
    const cleanUser = (username || '').trim();
    const store = loadStore();
    const user = store.users.find(
      u => u.username.toLowerCase() === cleanUser.toLowerCase()
    );

    if (!user || !verifyPassword(password || '', user.passwordHash)) {
      return NextResponse.json(
        { error: 'Usuario o contraseña incorrectos.' },
        { status: 401 }
      );
    }

    if (!user.active) {
      return NextResponse.json(
        { error: 'Esta cuenta ha sido desactivada por el administrador.' },
        { status: 403 }
      );
    }

    const token = createSessionToken(user);
    const res = NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        is_admin: Boolean(user.is_admin)
      }
    });
    res.cookies.set('mymusic_session', token, {
      httpOnly: true,
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
      sameSite: 'lax'
    });
    return res;
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
