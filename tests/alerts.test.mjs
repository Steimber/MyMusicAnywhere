import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ALERT_COOLDOWN_MS,
  ALERT_TYPES,
  createAlertsState,
  getNtfyUrl,
  notifyYouTubeBlocked,
  recordDownloadOutcome,
  checkDownloadsDiskAlert
} from '../lib/alerts.js';
import {
  YOUTUBE_BLOCK_TTL_MS,
  createYouTubeStatusState,
  markYouTubeBlocked
} from '../lib/download/youtube-status.js';
import { collectDownloadsDiskMetrics } from '../lib/store.js';

function createMockFetch(status = 200) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method,
      headers: { ...(init.headers || {}) },
      body: init.body
    });
    return { ok: status >= 200 && status < 300, status };
  };
  return { calls, fetchFn };
}

test('alerts stay disabled when NTFY_URL is unset or invalid', async () => {
  assert.equal(getNtfyUrl({}), null);
  assert.equal(getNtfyUrl({ NTFY_URL: '   ' }), null);
  assert.equal(getNtfyUrl({ NTFY_URL: 'ftp://example.invalid/topic' }), null);

  const { calls, fetchFn } = createMockFetch();
  const state = createAlertsState();

  const ytRes = await notifyYouTubeBlocked({ env: {}, state, fetchFn });
  assert.equal(ytRes.sent, false);
  assert.equal(ytRes.reason, 'disabled');

  for (let i = 0; i < 6; i += 1) {
    await recordDownloadOutcome(false, { env: {}, state, fetchFn });
  }
  assert.equal(calls.length, 0);
});

test('youtube_blocked alert fires on transition to blocked and respects 30m cooldown', async () => {
  const env = { NTFY_URL: 'https://ntfy.example.invalid/ops-secret-topic' };
  const { calls, fetchFn } = createMockFetch();
  const alertState = createAlertsState();
  const ytState = createYouTubeStatusState();
  const t0 = 1_700_000_000_000;

  // Transition OK -> blocked sends 1 alert
  const first = markYouTubeBlocked(
    'ERROR: Sign in to confirm you are not a bot (Track: Cancion Privada - usr_abc123)',
    t0,
    ytState,
    { env, state: alertState, fetchFn }
  );
  assert.equal(first.becameBlocked, true);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);

  // Calling again while still blocked does not fire
  const whileBlocked = markYouTubeBlocked('Sign in to confirm', t0 + 60_000, ytState, {
    env,
    state: alertState,
    fetchFn
  });
  assert.equal(whileBlocked.becameBlocked, false);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);

  // After 16m YouTube 15m block expired, so becameBlocked=true again,
  // but 30m alert cooldown suppresses duplicate notification
  const t16m = t0 + YOUTUBE_BLOCK_TTL_MS + 60_000;
  const reblockedWithin30m = markYouTubeBlocked('Sign in to confirm', t16m, ytState, {
    env,
    state: alertState,
    fetchFn
  });
  assert.equal(reblockedWithin30m.becameBlocked, true);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);

  // After >30m from first alert AND after previous 15m block window expired, sends again
  const t32m = t16m + YOUTUBE_BLOCK_TTL_MS + 60_000;
  assert.ok(t32m - t0 >= ALERT_COOLDOWN_MS);
  const afterCooldown = markYouTubeBlocked('Sign in to confirm', t32m, ytState, {
    env,
    state: alertState,
    fetchFn
  });
  assert.equal(afterCooldown.becameBlocked, true);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 2);
});

test('consecutive_download_failures fires on 5th consecutive failure and resets on success', async () => {
  const env = { NTFY_URL: 'https://ntfy.example.invalid/ops-secret-topic' };
  const { calls, fetchFn } = createMockFetch();
  const state = createAlertsState();
  const t0 = 1_700_000_000_000;

  // 4 failures followed by 1 success -> resets counter, 0 alerts
  for (let i = 0; i < 4; i += 1) {
    const res = await recordDownloadOutcome(false, { now: t0 + i * 1000, env, state, fetchFn });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'below_threshold');
  }
  const resetRes = await recordDownloadOutcome(true, { now: t0 + 5_000, env, state, fetchFn });
  assert.equal(resetRes.consecutiveFailures, 0);
  assert.equal(calls.length, 0);

  // 4 more failures still do not alert
  for (let i = 0; i < 4; i += 1) {
    const res = await recordDownloadOutcome(false, {
      now: t0 + 10_000 + i * 1000,
      env,
      state,
      fetchFn
    });
    assert.equal(res.sent, false);
  }
  assert.equal(calls.length, 0);

  // 5th consecutive failure sends alert
  const fifth = await recordDownloadOutcome(false, {
    now: t0 + 20_000,
    env,
    state,
    fetchFn
  });
  assert.equal(fifth.sent, true);
  assert.equal(fifth.consecutiveFailures, 5);
  assert.equal(calls.length, 1);

  // 6th consecutive failure 1 minute later is suppressed by 30m cooldown
  const sixth = await recordDownloadOutcome(false, {
    now: t0 + 80_000,
    env,
    state,
    fetchFn
  });
  assert.equal(sixth.sent, false);
  assert.equal(sixth.reason, 'cooldown');
  assert.equal(calls.length, 1);
});

test('downloads_disk_high fires only strictly above 90% and cooldown is independent per type', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-alerts-disk-'));
  try {
    const env = { NTFY_URL: 'https://ntfy.example.invalid/ops-secret-topic' };
    const { calls, fetchFn } = createMockFetch();
    const state = createAlertsState();
    const t0 = 1_700_000_000_000;
    const healthyFs = () => ({ blocks: 1000, bavail: 600, bsize: 4096 }); // 40% OS disk

    // Write exactly 90% of 1 MB (not > 90%)
    const ninetyPctBytes = Math.floor(0.9 * 1024 * 1024);
    fs.writeFileSync(path.join(tempDir, 'Artist - Cancion Secreta.m4a'), Buffer.alloc(ninetyPctBytes));

    const at90 = await checkDownloadsDiskAlert(
      collectDownloadsDiskMetrics(tempDir, 1, healthyFs),
      { now: t0, env, state, fetchFn }
    );
    assert.equal(at90.sent, false);
    assert.equal(at90.reason, 'below_threshold');
    assert.equal(calls.length, 0);

    // Push past 90% (~92%)
    fs.writeFileSync(path.join(tempDir, 'extra.m4a'), Buffer.alloc(24 * 1024));
    const over90 = await checkDownloadsDiskAlert(
      collectDownloadsDiskMetrics(tempDir, 1, healthyFs),
      { now: t0 + 1000, env, state, fetchFn }
    );
    assert.equal(over90.sent, true);
    assert.equal(calls.length, 1);

    // Independent per-type cooldown: youtube_blocked at t0 + 2s still sends even though disk alert is in cooldown
    const ytAlert = await notifyYouTubeBlocked({ now: t0 + 2000, env, state, fetchFn });
    assert.equal(ytAlert.sent, true);
    assert.equal(calls.length, 2);

    // OS partition > 90% also triggers when quota usage is tiny (after 30m cooldown)
    fs.unlinkSync(path.join(tempDir, 'Artist - Cancion Secreta.m4a'));
    const fullOsFs = () => ({ blocks: 1000, bavail: 70, bsize: 4096 }); // 93% OS disk
    const osOver90 = await checkDownloadsDiskAlert(
      collectDownloadsDiskMetrics(tempDir, 100, fullOsFs),
      { now: t0 + ALERT_COOLDOWN_MS + 5000, env, state, fetchFn }
    );
    assert.equal(osOver90.sent, true);
    assert.equal(calls.length, 3);

    // Privacy check across all sent alerts: no filenames, song titles, user IDs, or topic secrets in headers/body
    for (const call of calls) {
      const serializedPayload = JSON.stringify({
        headers: call.headers,
        body: call.body
      });
      assert.ok(!serializedPayload.includes('Cancion Secreta'));
      assert.ok(!serializedPayload.includes('Cancion Privada'));
      assert.ok(!serializedPayload.includes('usr_'));
      assert.ok(!serializedPayload.includes('ops-secret-topic'));
      assert.ok(!serializedPayload.includes(tempDir));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('alert network errors never throw or leak NTFY_URL to console', async () => {
  const secretUrl = 'https://ntfy.example.invalid/super-private-token-999';
  const env = { NTFY_URL: secretUrl };
  const state = createAlertsState();
  const logged = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => logged.push(args.join(' '));

  try {
    const res = await notifyYouTubeBlocked({
      env,
      state,
      fetchFn: async url => {
        throw new Error(`connect ECONNREFUSED for ${url}`);
      }
    });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'network_error');
    assert.equal(ALERT_TYPES.YOUTUBE_BLOCKED, 'youtube_blocked');
    assert.ok(!logged.join('\n').includes('super-private-token-999'));
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
});
