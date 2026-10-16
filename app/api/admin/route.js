import { NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  loadStore,
  saveStore,
  getSessionUser,
  getStorageStats
} from '../../../lib/store';

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = len =>
    Array.from(crypto.randomBytes(len))
      .map(b => chars[b % chars.length])
      .join('');
  return `MMA-${seg(4)}-${seg(4)}`;
}

export async function GET(request) {
  const user = getSessionUser(request);
  if (!user || !user.is_admin) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 403 });
  }

  const store = loadStore();
  const safeUsers = store.users.map(u => ({
    id: u.id,
    username: u.username,
    is_admin: Boolean(u.is_admin),
    active: Boolean(u.active),
    invited_by_code: u.invited_by_code || null,
    created_at: u.created_at
  }));

  return NextResponse.json({
    users: safeUsers,
    invites: store.invites,
    storage: getStorageStats()
  });
}

export async function POST(request) {
  const user = getSessionUser(request);
  if (!user || !user.is_admin) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { action } = body;
    const store = loadStore();

    if (action === 'create_invite') {
      const maxUses = Math.max(1, Math.min(100, Number(body.max_uses) || 1));
      const label = (body.label || 'Invitado').trim().slice(0, 40);
      const invite = {
        code: generateInviteCode(),
        label,
        max_uses: maxUses,
        used_count: 0,
        used_by: [],
        revoked: false,
        created_by: user.username,
        created_at: new Date().toISOString()
      };
      store.invites.unshift(invite);
      saveStore(store);
      return NextResponse.json({ ok: true, invite });
    }

    if (action === 'revoke_invite') {
      const target = store.invites.find(i => i.code === body.code);
      if (target) {
        target.revoked = !target.revoked;
        saveStore(store);
      }
      return NextResponse.json({ ok: true });
    }

    if (action === 'delete_invite') {
      store.invites = store.invites.filter(i => i.code !== body.code);
      saveStore(store);
      return NextResponse.json({ ok: true });
    }

    if (action === 'toggle_user') {
      const target = store.users.find(u => u.id === body.userId);
      if (target && !target.is_admin) {
        target.active = !target.active;
        saveStore(store);
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
