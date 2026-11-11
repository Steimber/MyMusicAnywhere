import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../lib/store.js';
import {
  MAX_LISTENING_BODY_BYTES,
  getUserListeningHistory,
  saveUserListeningHistory
} from '../../../lib/listening-store.js';

export const runtime = 'nodejs';

export async function GET(request) {
  const user = getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const data = getUserListeningHistory(user.id);
  if (!data.ok) {
    return NextResponse.json({ error: data.error }, { status: data.status || 400 });
  }

  return NextResponse.json({
    hasSnapshot: Boolean(data.hasSnapshot),
    version: data.version,
    updatedAt: data.updatedAt,
    entries: data.entries
  });
}

export async function PUT(request) {
  const user = getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  let rawText = '';
  try {
    rawText = await request.text();
  } catch {
    return NextResponse.json({ error: 'Cuerpo de solicitud inválido' }, { status: 400 });
  }

  if (Buffer.byteLength(rawText, 'utf8') > MAX_LISTENING_BODY_BYTES) {
    return NextResponse.json(
      { error: 'El historial de escucha supera el límite permitido de 1 MB.' },
      { status: 413 }
    );
  }

  let body;
  try {
    body = JSON.parse(rawText || '{}');
  } catch {
    return NextResponse.json({ error: 'Formato JSON inválido' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Datos de escucha inválidos' }, { status: 400 });
  }

  const result = saveUserListeningHistory(user.id, {
    baseVersion: body.baseVersion,
    entries: body.entries
  });

  if (!result.ok) {
    if (result.status === 409 && result.snapshot) {
      return NextResponse.json(
        {
          error: 'Conflicto de versión en historial de escucha.',
          conflict: true,
          hasSnapshot: Boolean(result.snapshot.hasSnapshot),
          version: result.snapshot.version,
          updatedAt: result.snapshot.updatedAt,
          entries: result.snapshot.entries
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: result.error }, { status: result.status || 400 });
  }

  const saved = result.snapshot;
  return NextResponse.json({
    ok: true,
    version: saved.version,
    updatedAt: saved.updatedAt,
    entryCount: Object.keys(saved.entries || {}).length
  });
}
