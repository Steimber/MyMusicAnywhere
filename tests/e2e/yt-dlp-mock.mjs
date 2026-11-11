import fs from 'fs';
import path from 'path';

// Simulated offline yt-dlp + SoundCloud extractor for E2E tests (zero network usage).
const args = process.argv.slice(2);
const logPath = process.env.E2E_YTDLP_LOG_PATH || '';

function appendLog(entry) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {}
}

const sepIdx = args.indexOf('--');
const targets = sepIdx >= 0 ? args.slice(sepIdx + 1) : [args[args.length - 1]].filter(Boolean);

function parseQueryArtistTitle(rawTarget) {
  const cleaned = String(rawTarget || '')
    .replace(/^(?:ytsearch|scsearch|bilisearch)\d*:/i, '')
    .replace(/\bofficial\s+audio\b/gi, '')
    .trim();
  if (cleaned.includes(' - ')) {
    const [artist, ...rest] = cleaned.split(' - ');
    return {
      artist: artist.trim() || 'Solar Echo',
      title: rest.join(' - ').trim() || 'Aurora Borealis'
    };
  }
  return { artist: 'Solar Echo', title: cleaned || 'Aurora Borealis' };
}

// 1. Flat-playlist candidate search (YouTube & SoundCloud)
if (args.includes('--flat-playlist')) {
  appendLog({ mode: 'flat-playlist', targets });
  for (const t of targets) {
    const isSc = /^scsearch|soundcloud\.com/i.test(t);
    const { artist, title } = parseQueryArtistTitle(t);
    if (isSc) {
      process.stdout.write(
        `soundcloud\tsc_e2e_900101\thttps://soundcloud.com/solar-echo/aurora-borealis\thttps://soundcloud.com/solar-echo/aurora-borealis\t62\t${artist}\t${artist} - ${title}\n`
      );
    } else {
      process.stdout.write(
        `youtube\tdQw4w9WgXcQ\thttps://www.youtube.com/watch?v=dQw4w9WgXcQ\thttps://www.youtube.com/watch?v=dQw4w9WgXcQ\t62\t${artist}\t${artist} - ${title}\n`
      );
    }
  }
  process.exit(0);
}

// 2. Direct link metadata probe (--skip-download)
if (args.includes('--skip-download')) {
  appendLog({ mode: 'probe', targets });
  const baseOrigin = process.env.E2E_BASE_URL || 'http://127.0.0.1:3199';
  process.stdout.write(`62\tSolar Echo - Aurora Borealis\tSolar Echo\t${baseOrigin}/icon.svg\n`);
  process.exit(0);
}

// 3. Audio download (-o <template>)
const outFlagIdx = args.indexOf('-o');
const outputTemplate = outFlagIdx >= 0 ? args[outFlagIdx + 1] : '';
appendLog({ mode: 'download', targets, outputTemplate });

if (!outputTemplate) {
  process.stderr.write('Missing -o template in simulated yt-dlp\n');
  process.exit(1);
}

const fixturePath = process.env.E2E_MOCK_M4A_PATH || '';
if (!fixturePath || !fs.existsSync(fixturePath)) {
  process.stderr.write(`Missing E2E_MOCK_M4A_PATH fixture: ${fixturePath}\n`);
  process.exit(1);
}

const rawFilePath = outputTemplate.replace(/%\(ext\)s/g, 'm4a');
fs.mkdirSync(path.dirname(rawFilePath), { recursive: true });
fs.copyFileSync(fixturePath, rawFilePath);

process.stdout.write('[download] 45.0%\n');
process.stdout.write('[download] 100.0%\n');
process.stdout.write('mp4a.40.2\n');
process.stdout.write(`${rawFilePath}\n`);
process.exit(0);
