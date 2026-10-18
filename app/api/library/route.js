import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDownloadsDir, getSessionUser } from '../../../lib/store';

export async function GET(request) {
  try {
    const user = getSessionUser(request);
    if (!user) {
      return NextResponse.json({ files: [], unauthorized: true }, { status: 401 });
    }

    const downloadsDir = getDownloadsDir();
    if (!fs.existsSync(downloadsDir)) {
      return NextResponse.json({ files: [] });
    }

    const files = fs
      .readdirSync(downloadsDir)
      .filter(
        f => !f.includes('.raw.') && (f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.opus'))
      )
      .map(name => {
        const filePath = path.join(downloadsDir, name);
        const stat = fs.statSync(filePath);
        return {
          filename: name,
          sizeMB: (stat.size / (1024 * 1024)).toFixed(2),
          mtime: stat.mtimeMs,
          url: `/api/stream?file=${encodeURIComponent(name)}`
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    return NextResponse.json({ files });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const user = getSessionUser(request);
    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const rawFile = searchParams.get('file') || '';
    const safeName = path.basename(rawFile);

    if (!safeName || safeName !== rawFile) {
      return NextResponse.json({ error: 'Nombre de archivo inválido' }, { status: 400 });
    }

    const downloadsDir = getDownloadsDir();
    const targetPath = path.join(downloadsDir, safeName);

    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }

    return NextResponse.json({ deleted: true, filename: safeName });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
