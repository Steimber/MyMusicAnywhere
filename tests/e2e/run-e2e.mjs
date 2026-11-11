import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, 'localhost', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3199;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForServer(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/manifest.json`, { cache: 'no-store' });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 350));
  }
  throw new Error(`Timed out waiting for E2E Next.js server at ${url}`);
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  } else {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

async function main() {
  const repoRoot = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-e2e-'));
  const dataDir = path.join(tempRoot, 'data');
  const downloadsDir = path.join(tempRoot, 'downloads');
  const fixturesDir = path.join(tempRoot, 'fixtures');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(fixturesDir, { recursive: true });

  const fixtureM4aPath = path.join(fixturesDir, 'mock_song.m4a');
  const ytdlpLogPath = path.join(fixturesDir, 'ytdlp_calls.jsonl');

  // Generate a valid >450 KB AAC .m4a offline audio fixture once via ffmpeg
  const ffmpegGen = spawnSync(
    process.env.FFMPEG_BIN?.trim() || 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=22:c=pink:r=44100:a=0.18',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      fixtureM4aPath
    ],
    { encoding: 'utf8' }
  );
  if (ffmpegGen.status !== 0 || !fs.existsSync(fixtureM4aPath)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`Failed to generate E2E audio fixture via ffmpeg: ${ffmpegGen.stderr || ''}`);
  }

  // Seed temporary store.json with isolated test user (never touches real data/)
  const testUsername = 'e2e_user';
  const testPassword = 'e2e_pass_123';
  const adminUsername = 'e2e_admin';
  const adminPassword = 'e2e_admin_pass_123';

  const seededStore = {
    secret: crypto.randomBytes(32).toString('hex'),
    users: [
      {
        id: 'usr_admin',
        username: adminUsername,
        passwordHash: hashPassword(adminPassword),
        is_admin: true,
        active: true,
        created_at: new Date().toISOString()
      },
      {
        id: 'usr_e2e_tester',
        username: testUsername,
        passwordHash: hashPassword(testPassword),
        is_admin: false,
        active: true,
        created_at: new Date().toISOString()
      }
    ],
    invites: [],
    uploads: []
  };
  fs.writeFileSync(path.join(dataDir, 'store.json'), JSON.stringify(seededStore, null, 2), {
    mode: 0o600
  });

  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  const mockYtDlpScript = path.join(repoRoot, 'tests', 'e2e', 'yt-dlp-mock.mjs');
  const nextCli = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');

  if (process.env.E2E_SKIP_BUILD !== '1' || !fs.existsSync(path.join(repoRoot, '.next', 'BUILD_ID'))) {
    const buildRes = spawnSync(process.execPath, [nextCli, 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }
    });
    if (buildRes.status !== 0) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      process.exit(buildRes.status ?? 1);
    }
  }

  const existingNodeOpts = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  const serverEnv = {
    ...process.env,
    NODE_ENV: 'production',
    DATA_DIR: dataDir,
    DOWNLOADS_DIR: downloadsDir,
    ADMIN_USERNAME: adminUsername,
    ADMIN_PASSWORD: adminPassword,
    YTDLP_BIN: mockYtDlpScript,
    YTDLP_PROXY: '',
    NTFY_URL: '',
    ENABLE_BILIBILI: 'false',
    E2E_BASE_URL: baseUrl,
    E2E_MOCK_M4A_PATH: fixtureM4aPath,
    E2E_YTDLP_LOG_PATH: ytdlpLogPath,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `${existingNodeOpts}--import ./tests/e2e/preload-offline-net.mjs`
  };

  let serverChild = null;
  let exitCode = 1;

  try {
    serverChild = spawn(
      process.execPath,
      [nextCli, 'start', '-H', 'localhost', '-p', String(port)],
      {
        cwd: repoRoot,
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let serverLogs = '';
    serverChild.stdout.on('data', d => {
      serverLogs += d.toString();
    });
    serverChild.stderr.on('data', d => {
      serverLogs += d.toString();
    });

    try {
      await waitForServer(baseUrl, 45000);
    } catch (err) {
      console.error('[e2e] Next.js server logs:\n', serverLogs.slice(-2500));
      throw err;
    }

    const pwCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
    const extraArgs = process.argv.slice(2);
    const pwRes = spawnSync(process.execPath, [pwCli, 'test', ...extraArgs], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        E2E_BASE_URL: baseUrl,
        E2E_DATA_DIR: dataDir,
        E2E_DOWNLOADS_DIR: downloadsDir,
        E2E_YTDLP_LOG_PATH: ytdlpLogPath,
        E2E_TEST_USERNAME: testUsername,
        E2E_TEST_PASSWORD: testPassword
      }
    });

    exitCode = pwRes.status ?? 1;
  } finally {
    killProcessTree(serverChild);
    // Allow brief handle release on Windows before removing temp directory
    await new Promise(r => setTimeout(r, 300));
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }

  process.exit(exitCode);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
