import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');

export async function GET() {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      return NextResponse.json({ files: [] });
    }

    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.opus'))
      .map(name => {
        const filePath = path.join(DOWNLOADS_DIR, name);
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
