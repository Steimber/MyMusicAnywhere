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
      .filter(f => f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.opus'))
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
