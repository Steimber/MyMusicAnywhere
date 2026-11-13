import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPoolState,
  computePresentUsersAndFairShare,
  enqueueNetDownload,
  acquireContinuationNetSlot,
  enqueueCpuJob,
  getPoolStatus
} from '../lib/download/queue.js';

import {
  stripMediaExtensionNoise,
  cleanYouTubeOembedMetadata,
  buildCandidateContext,
  evaluateCandidate,
  evaluateCandidatePool,
  scoreLoopCandidate,
  buildRejectTitleRegex,
  isUrlDrmBlocked,
  markUrlDrmBlocked
} from '../lib/download/candidates.js';
import {
  YOUTUBE_BLOCK_TTL_MS,
  YOUTUBE_FALLBACK_NOTICE,
  NO_SOURCE_FOUND_ERROR,
  createYouTubeStatusState,
  isYouTubeTargetUrl,
  buildYtDlpProxyArgs,
  redactProxySecrets,
  isYouTubeBotBlockError,
  isYouTubeBlocked,
  markYouTubeBlocked,
  onYouTubeBlockedTransition,
  getYouTubeAdminStatus,
  classifyDirectLinkSource
} from '../lib/download/youtube-status.js';
import {
  GET as getSearchRoute,
  resolveYouTubeLinkTrack
} from '../app/api/search/route.js';
import {
  POST as postDownloadRoute,
  GET as getDownloadRoute,
  shouldPreferYouTubePrimary,
  buildDownloadDedupeKey
} from '../app/api/download/route.js';
import { loadStore, createSessionToken } from '../lib/store.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('queue: single user bursts up to MAX_NET_DOWNLOADS (4)', async () => {
  const pools = createPoolState({ maxNetDownloads: 4, maxPerUser: 2, maxQueuedPerUser: 50 });

  const blockers = Array.from({ length: 6 }, () => createDeferred());
  const started = [];

  const tasks = blockers.map((b, i) =>
    enqueueNetDownload(
      'alice',
      `dl-${i}`,
      false,
      async () => {
        started.push(i);
        await b.promise;
        return i;
      },
      pools
    )
  );

  await new Promise(r => setImmediate(r));
  assert.equal(pools.netRunning, 4);
  assert.equal(pools.netActiveByUser.get('alice'), 4);
  assert.deepEqual(started, [0, 1, 2, 3]);

  const { presentCount, fairShare } = computePresentUsersAndFairShare(pools);
  assert.equal(presentCount, 1);
  assert.equal(fairShare, 4);

  blockers.forEach(b => b.resolve());
  await Promise.all(tasks);
  assert.equal(pools.netRunning, 0);
  assert.equal(pools.netActiveByUser.has('alice'), false);
});

test('queue: 2 users converge from 4+0 burst to 2+2 fair share as slots release', async () => {
  const pools = createPoolState({ maxNetDownloads: 4, maxPerUser: 2, maxQueuedPerUser: 50 });

  const aliceBlockers = Array.from({ length: 6 }, () => createDeferred());
  const bobBlockers = Array.from({ length: 4 }, () => createDeferred());

  // Alice starts alone and takes all 4 slots (with 2 more queued)
  const aliceTasks = aliceBlockers.map((b, i) =>
    enqueueNetDownload('alice', `a-${i}`, false, () => b.promise, pools)
  );
  await new Promise(r => setImmediate(r));
  assert.equal(pools.netActiveByUser.get('alice'), 4);

  // Bob arrives and queues 4 songs
  const bobTasks = bobBlockers.map((b, i) =>
    enqueueNetDownload('bob', `b-${i}`, false, () => b.promise, pools)
  );
  await new Promise(r => setImmediate(r));

  const { presentCount, fairShare } = computePresentUsersAndFairShare(pools);
  assert.equal(presentCount, 2);
  assert.equal(fairShare, 2);

  // As Alice finishes 2 songs, Bob must get both freed slots (reaching 2 + 2)
  aliceBlockers[0].resolve();
  aliceBlockers[1].resolve();
  await new Promise(r => setImmediate(r));

  assert.equal(pools.netActiveByUser.get('alice'), 2);
  assert.equal(pools.netActiveByUser.get('bob'), 2);
  assert.equal(pools.netRunning, 4);

  aliceBlockers.forEach(b => b.resolve());
  bobBlockers.forEach(b => b.resolve());
  await Promise.all([...aliceTasks, ...bobTasks]);
  assert.equal(pools.netRunning, 0);
});

test('queue: 3 users — 3rd user gets the very first freed slot (Pass 1) and all 4 slots stay busy (Pass 2)', async () => {
  const pools = createPoolState({ maxNetDownloads: 4, maxPerUser: 2, maxQueuedPerUser: 50 });

  const aliceBlockers = Array.from({ length: 4 }, () => createDeferred());
  const bobBlockers = Array.from({ length: 4 }, () => createDeferred());
  const charlieBlockers = Array.from({ length: 2 }, () => createDeferred());

  // Alice and Bob arrive together and each queue 4 songs -> 2 + 2 active
  const aliceTasks = [];
  const bobTasks = [];
  for (let i = 0; i < 4; i++) {
    aliceTasks.push(enqueueNetDownload('alice', `a-${i}`, false, () => aliceBlockers[i].promise, pools));
    bobTasks.push(enqueueNetDownload('bob', `b-${i}`, false, () => bobBlockers[i].promise, pools));
  }
  await new Promise(r => setImmediate(r));
  assert.equal(pools.netActiveByUser.get('alice'), 2);
  assert.equal(pools.netActiveByUser.get('bob'), 2);

  // Charlie arrives and queues 2 songs while Alice & Bob are still ahead in queue
  const charlieTasks = charlieBlockers.map((b, i) =>
    enqueueNetDownload('charlie', `c-${i}`, false, () => b.promise, pools)
  );
  await new Promise(r => setImmediate(r));

  const { presentCount, fairShare } = computePresentUsersAndFairShare(pools);
  assert.equal(presentCount, 3);
  assert.equal(fairShare, 1);

  // Alice finishes 1 download -> Pass 1 sees Charlie has 0 < fairShare(1), so Charlie gets the slot IMMEDIATELY
  aliceBlockers[0].resolve();
  await new Promise(r => setImmediate(r));

  assert.equal(pools.netActiveByUser.get('charlie'), 1);
  assert.equal(pools.netActiveByUser.get('alice'), 1);
  assert.equal(pools.netActiveByUser.get('bob'), 2);
  assert.equal(pools.netRunning, 4); // All 4 slots utilized (1 + 2 + 1)

  // Now Bob finishes 1 download -> everyone has 1 active (1 + 1 + 1 = 3), Pass 2 assigns the 4th spare slot without leaving it idle
  bobBlockers[0].resolve();
  await new Promise(r => setImmediate(r));
  assert.equal(pools.netRunning, 4);

  aliceBlockers.forEach(b => b.resolve());
  bobBlockers.forEach(b => b.resolve());
  charlieBlockers.forEach(b => b.resolve());
  await Promise.all([...aliceTasks, ...bobTasks, ...charlieTasks]);
  assert.equal(pools.netRunning, 0);
});

test('queue: 4 users get 1+1+1+1 and error paths never leak slots or present users', async () => {
  const pools = createPoolState({ maxNetDownloads: 4, maxPerUser: 2, maxQueuedPerUser: 50 });

  const users = ['u1', 'u2', 'u3', 'u4'];
  const blockers = users.map(() => createDeferred());

  const tasks = users.map((u, idx) =>
    enqueueNetDownload(
      u,
      `dl-${u}`,
      false,
      async () => {
        await blockers[idx].promise;
        if (u === 'u2') throw new Error('simulated network failure');
        return u;
      },
      pools
    )
  );

  await new Promise(r => setImmediate(r));
  for (const u of users) {
    assert.equal(pools.netActiveByUser.get(u), 1);
  }

  blockers.forEach(b => b.resolve());
  const results = await Promise.allSettled(tasks);
  assert.equal(results[1].status, 'rejected');
  assert.equal(pools.netRunning, 0);
  assert.equal(pools.netActiveByUser.size, 0);
  assert.equal(pools.netTurnOrder.length, 0);
});

test('queue: acquireContinuationNetSlot re-acquires slot cleanly after early release', async () => {
  const pools = createPoolState({ maxNetDownloads: 4, maxPerUser: 2, maxQueuedPerUser: 50 });

  const task = enqueueNetDownload(
    'alice',
    'dl-cont',
    false,
    async releaseInitialSlot => {
      assert.equal(pools.netRunning, 1);
      // Release initial slot before CPU phase, then re-acquire continuation slot
      releaseInitialSlot();
      assert.equal(pools.netRunning, 0);

      const releaseContSlot = await acquireContinuationNetSlot('alice', pools);
      assert.equal(pools.netRunning, 1);
      assert.equal(pools.netActiveByUser.get('alice'), 1);

      releaseContSlot();
      assert.equal(pools.netRunning, 0);
    },
    pools
  );

  await task;
  assert.equal(pools.netRunning, 0);
  assert.equal(pools.netActiveByUser.size, 0);
  const status = getPoolStatus('alice', null, pools);
  assert.equal(status.active, 0);
});

test('queue: CPU pool limits concurrency to maxCpuJobs (2) and releases on error', async () => {
  const pools = createPoolState({ maxCpuJobs: 2 });

  const b1 = createDeferred();
  const b2 = createDeferred();
  const b3 = createDeferred();
  const order = [];

  const t1 = enqueueCpuJob(
    'alice',
    async () => {
      order.push('start-1');
      await b1.promise;
    },
    null,
    pools
  );
  const t2 = enqueueCpuJob(
    'bob',
    async () => {
      order.push('start-2');
      await b2.promise;
      throw new Error('ffmpeg error');
    },
    null,
    pools
  );
  const t3 = enqueueCpuJob(
    'charlie',
    async () => {
      order.push('start-3');
      await b3.promise;
    },
    null,
    pools
  );

  await new Promise(r => setImmediate(r));
  assert.equal(pools.cpuRunning, 2);
  assert.deepEqual(order, ['start-1', 'start-2']);

  b2.resolve();
  await assert.rejects(t2, /ffmpeg error/);
  await new Promise(r => setImmediate(r));
  assert.equal(pools.cpuRunning, 2);
  assert.deepEqual(order, ['start-1', 'start-2', 'start-3']);

  b1.resolve();
  b3.resolve();
  await Promise.all([t1, t3]);
  assert.equal(pools.cpuRunning, 0);
});

test('candidates: evaluateCandidate filters Shorts, unrequested live/remix/karaoke, and allows requested covers', () => {
  const ctx = buildCandidateContext(
    'De Musica Ligera',
    'De Musica Ligera',
    'Soda Stereo',
    212
  );

  const valid = evaluateCandidate(
    {
      extractor: 'youtube',
      title: 'Soda Stereo - De Música Ligera (Official Audio)',
      uploader: 'Soda Stereo - Topic',
      duration: 212
    },
    ctx
  );
  assert.ok(valid.score > 100);
  assert.equal(valid.reason, 'ok');

  const shortVideo = evaluateCandidate(
    {
      extractor: 'youtube',
      title: 'Soda Stereo - De Música Ligera #shorts',
      uploader: 'Soda Stereo',
      duration: 30
    },
    ctx
  );
  assert.equal(shortVideo.score, -1);
  assert.match(shortVideo.reason, /duration_bounds/);

  const unrequestedKaraoke = evaluateCandidate(
    {
      extractor: 'youtube',
      title: 'Soda Stereo - De Música Ligera (Karaoke Instrumental)',
      uploader: 'Karaoke Hits',
      duration: 212
    },
    ctx
  );
  assert.equal(unrequestedKaraoke.score, -1);
  assert.match(unrequestedKaraoke.reason, /banned_term/);

  // When user explicitly asks for a cover, both buildRejectTitleRegex and evaluateCandidate allow "cover"
  const coverRegex = buildRejectTitleRegex('De Musica Ligera Cover');
  assert.ok(!coverRegex.includes('|cover|'));

  const coverCtx = buildCandidateContext(
    'De Musica Ligera (Cover)',
    'De Musica Ligera Cover',
    'Soda Stereo',
    210
  );
  const requestedCover = evaluateCandidate(
    {
      extractor: 'youtube',
      title: 'Soda Stereo - De Musica Ligera (Cover)',
      uploader: 'Soda Stereo',
      duration: 210
    },
    coverCtx
  );
  assert.ok(requestedCover.score > 0);
});

test('candidates: scoreLoopCandidate accepts clean multi-cycle loops and rejects remixed loops', () => {
  const ctx = buildCandidateContext(
    'De Musica Ligera',
    'De Musica Ligera',
    'Soda Stereo',
    210
  );

  // 2x loop (420s for a 210s song)
  const cleanLoop = scoreLoopCandidate(
    {
      extractor: 'youtube',
      title: 'Soda Stereo - De Música Ligera (Extended Loop)',
      uploader: 'Soda Stereo',
      duration: 420
    },
    ctx
  );
  assert.ok(cleanLoop !== null);
  assert.ok(cleanLoop.score > 0);
  assert.equal(cleanLoop.trimDurationSec, 210);

  // Remix loop when user didn't ask for remix -> rejected (null)
  const remixLoop = scoreLoopCandidate(
    {
      extractor: 'youtube',
      title: 'Soda Stereo - De Música Ligera (Club Remix Loop)',
      uploader: 'Soda Stereo',
      duration: 420
    },
    ctx
  );
  assert.equal(remixLoop, null);
});

test('candidates: DRM cache blocks marked HTTP(S) URLs for 24h and ignores search queries', () => {
  const cache = new Map();
  const url = 'https://www.youtube.com/watch?v=drm123456';
  const searchTarget = 'ytsearch5:Soda Stereo De Musica Ligera';

  assert.equal(isUrlDrmBlocked(url, cache, 1000), false);
  markUrlDrmBlocked(url, cache, 1000);
  assert.equal(isUrlDrmBlocked(url, cache, 2000), true);

  // Search queries are never cached as DRM URLs
  markUrlDrmBlocked(searchTarget, cache, 1000);
  assert.equal(isUrlDrmBlocked(searchTarget, cache, 2000), false);

  // Expires after 24 hours
  const after25Hours = 1000 + 25 * 60 * 60 * 1000;
  assert.equal(isUrlDrmBlocked(url, cache, after25Hours), false);
});

test('candidates: cleanYouTubeOembedMetadata strips warning/lyric tags and preserves Unicode artist + Demo number', () => {
  const cleaned = cleanYouTubeOembedMetadata(
    '*flash warning* ミラクルミュージカル – The Mind Electric (Demo 4) Fanmade Lyric Video',
    'weirdredstone42'
  );
  assert.equal(cleaned.artist, 'ミラクルミュージカル');
  assert.equal(cleaned.title, 'The Mind Electric (Demo 4)');

  // Hyphenated titles must not split into Artist/Title
  const hyphenated = cleanYouTubeOembedMetadata(
    'Anti-Hero (Official Music Video)',
    'Taylor Swift'
  );
  assert.equal(hyphenated.artist, 'Taylor Swift');
  assert.equal(hyphenated.title, 'Anti-Hero');

  // Official - Topic channels must not split "Song - Interlude" into artist="Song"
  const topicTrack = cleanYouTubeOembedMetadata(
    "Don't Go Breaking My Heart - Interlude",
    'Taron Egerton - Topic'
  );
  assert.equal(topicTrack.artist, 'Taron Egerton');
  assert.equal(topicTrack.title, "Don't Go Breaking My Heart - Interlude");

  const ctx = buildCandidateContext(
    cleaned.title,
    cleaned.title,
    cleaned.artist,
    null
  );

  const pool = evaluateCandidatePool(
    [
      {
        extractor: 'soundcloud',
        webpageUrl: 'https://soundcloud.com/user-721711351/the-mind-electric-demo-3',
        title: 'ミラクルミュージカル - The Mind Electric (Demo 3)',
        uploader: 'ミラクルミュージカル archive',
        duration: 145.7
      },
      {
        extractor: 'soundcloud',
        webpageUrl: 'https://soundcloud.com/user-721711351/other-song-demo-4',
        title: 'ミラクルミュージカル - Labyrinth (Demo 4)',
        uploader: 'ミラクルミュージカル archive',
        duration: 94.6
      },
      {
        extractor: 'soundcloud',
        webpageUrl: 'https://soundcloud.com/miracle-musical/the-mind-electric-demo-4',
        title: 'The Mind Electric (Demo 4)',
        uploader: 'Miracle Musical |ミラクルミュージカル',
        duration: 94.6
      }
    ],
    ctx,
    'sc-test',
    'ミラクルミュージカル - The Mind Electric (Demo 4)'
  );

  assert.equal(pool.tier1.length, 1);
  assert.equal(
    pool.tier1[0].webpageUrl,
    'https://soundcloud.com/miracle-musical/the-mind-electric-demo-4'
  );
});

test('candidates: evaluateCandidatePool falls back to relaxedDuration when only extended version exists and still rejects slowed/reverb', () => {
  const ctx = buildCandidateContext('Hero', 'Hero', 'Miss Papaya', 215);
  const pool = evaluateCandidatePool(
    [
      {
        extractor: 'soundcloud',
        webpageUrl: 'https://soundcloud.com/youth-is-arcadia/hero-papaya-mp3',
        title: 'Hero - Papaya.mp3',
        uploader: 'Arcadia',
        duration: 264.87
      },
      {
        extractor: 'soundcloud',
        webpageUrl: 'https://soundcloud.com/nashirangels/miss-papaya-hero-slowed-reverb',
        title: 'Miss Papaya - Hero (Slowed + Reverb)',
        uploader: 'Nashirabutterfly',
        duration: 361.46
      }
    ],
    ctx,
    'sc-test',
    'Miss Papaya - Hero'
  );

  assert.equal(pool.tier1.length, 1);
  assert.equal(pool.tier1[0].webpageUrl, 'https://soundcloud.com/youth-is-arcadia/hero-papaya-mp3');
  assert.equal(pool.tier1[0].relaxedDuration, true);
});

test('candidates: strips glued/dotted media extensions without corrupting real names and matches Black Sun on SoundCloud', () => {
  // Glued uppercase+lowercase and dotted/unambiguous extensions
  assert.equal(
    stripMediaExtensionNoise('Torrez Aleks - BLACKSUN LA PINTA LA NIÑA Y LA SANTA MARIAavi'),
    'Torrez Aleks - BLACKSUN LA PINTA LA NIÑA Y LA SANTA MARIA'
  );
  assert.equal(
    stripMediaExtensionNoise('Cancion.avi'),
    'Cancion'
  );
  assert.equal(
    stripMediaExtensionNoise('TemaFinalmp4'),
    'TemaFinal'
  );
  assert.equal(
    stripMediaExtensionNoise('Archivo_mkv'),
    'Archivo'
  );

  // Must NEVER corrupt real artist/song words ending in avi, mov, ogg, aac, opus
  for (const safeTitle of [
    'Javi',
    'JAVI',
    'Xavi',
    'Navi',
    'Snoop Dogg',
    'SNOOP DOGG',
    'Isaac Asimov',
    'Octopus'
  ]) {
    assert.equal(stripMediaExtensionNoise(safeTitle), safeTitle);
  }

  const meta = cleanYouTubeOembedMetadata(
    'Torrez Aleks - BLACKSUN LA PINTA LA NIÑA Y LA SANTA MARIAavi',
    'Torrez Aleks'
  );
  assert.equal(meta.artist, 'Torrez Aleks');
  assert.equal(meta.title, 'BLACKSUN LA PINTA LA NIÑA Y LA SANTA MARIA');

  const ctx = buildCandidateContext(meta.title, meta.title, meta.artist, null);
  const pool = evaluateCandidatePool(
    [
      {
        extractor: 'soundcloud',
        webpageUrl: 'https://soundcloud.com/blacksun-ec/la-nina-la-pinta-y-la-santa-maria',
        title: 'La Niña la Pinta y la Santa María',
        uploader: 'Black Sun',
        duration: 258
      },
      {
        extractor: 'soundcloud',
        webpageUrl: 'https://soundcloud.com/rock-ecuador/blacksun-la-nina',
        title: 'Black Sun - La Niña la Pinta y la Santa María',
        uploader: 'Rock Ecuatoriano',
        duration: 258
      },
      {
        extractor: 'soundcloud',
        webpageUrl: 'https://soundcloud.com/pedro-perez/la-nina-la-pinta',
        title: 'La Niña la Pinta y la Santa María',
        uploader: 'Pedro Perez',
        duration: 258
      },
      {
        extractor: 'soundcloud',
        webpageUrl: 'https://soundcloud.com/blacksun-ec/milenio',
        title: 'Milenio',
        uploader: 'Black Sun',
        duration: 245
      }
    ],
    ctx,
    'sc-blacksun',
    meta.title
  );

  assert.equal(pool.tier1.length, 2);
  // Official/band uploader ("Black Sun") ranks #1 ahead of third-party uploader ("Rock Ecuatoriano")
  assert.equal(
    pool.tier1[0].webpageUrl,
    'https://soundcloud.com/blacksun-ec/la-nina-la-pinta-y-la-santa-maria'
  );
  assert.equal(
    pool.tier1[1].webpageUrl,
    'https://soundcloud.com/rock-ecuador/blacksun-la-nina'
  );
});

test('youtube-status: YTDLP_PROXY applies only to YouTube targets and secrets are scrubbed from errors', () => {
  const secretProxy = 'http://proxyUser99:Sup3rS3cret!@proxy.internal.test:8080';

  assert.equal(isYouTubeTargetUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeTargetUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeTargetUrl('ytsearch6:Soda Stereo De Musica Ligera'), true);
  assert.equal(isYouTubeTargetUrl('https://soundcloud.com/artist/track'), false);
  assert.equal(isYouTubeTargetUrl('scsearch15:Soda Stereo'), false);
  assert.equal(isYouTubeTargetUrl('bilisearch1:Soda Stereo'), false);

  assert.deepEqual(buildYtDlpProxyArgs(true, secretProxy), ['--proxy', secretProxy]);
  assert.deepEqual(buildYtDlpProxyArgs(false, secretProxy), []);
  assert.deepEqual(buildYtDlpProxyArgs(true, ''), []);
  assert.deepEqual(buildYtDlpProxyArgs(true, null), []);

  const rawErr = `ERROR: Unable to connect to proxy ${secretProxy} (auth proxyUser99:Sup3rS3cret! at proxy.internal.test:8080)`;
  const scrubbed = redactProxySecrets(rawErr, secretProxy);
  assert.ok(!scrubbed.includes('Sup3rS3cret!'));
  assert.ok(!scrubbed.includes('proxyUser99:Sup3rS3cret!'));
  assert.ok(!scrubbed.includes('proxy.internal.test:8080'));
});

test('youtube-status: bot-check marks youtube_blocked for 15m and admin status hides proxy value', () => {
  const state = createYouTubeStatusState();
  const t0 = 1_700_000_000_000;
  let transitions = 0;
  const unsub = onYouTubeBlockedTransition(() => {
    transitions += 1;
  }, state);

  assert.equal(
    isYouTubeBotBlockError("ERROR: [youtube] 19W4JGa76IY: Sign in to confirm you’re not a bot"),
    true
  );
  assert.equal(
    isYouTubeBotBlockError("ERROR: [youtube] abc: Sign in to confirm you're not a bot."),
    true
  );
  assert.equal(isYouTubeBotBlockError('ERROR: Video unavailable'), false);

  assert.equal(isYouTubeBlocked(t0, state), false);
  const firstMark = markYouTubeBlocked("Sign in to confirm you're not a bot", t0, state);
  assert.equal(firstMark.becameBlocked, true);
  assert.equal(transitions, 1);
  assert.equal(isYouTubeBlocked(t0 + 60_000, state), true);

  // Subsequent failures while already blocked extend TTL without firing duplicate transition alerts
  const secondMark = markYouTubeBlocked("Sign in to confirm you're not a bot", t0 + 120_000, state);
  assert.equal(secondMark.becameBlocked, false);
  assert.equal(transitions, 1);

  const secretProxy = 'socks5://ytuser:ytpass@proxy.internal.test:1080';
  const adminStatus = getYouTubeAdminStatus(t0 + 120_000, state, secretProxy);
  assert.equal(adminStatus.status, 'blocked');
  assert.equal(adminStatus.blocked, true);
  assert.equal(adminStatus.proxyConfigured, true);
  assert.equal(adminStatus.blockedSince, new Date(t0).toISOString());
  assert.ok(!JSON.stringify(adminStatus).includes('ytpass'));
  assert.ok(!JSON.stringify(adminStatus).includes('proxy.internal.test'));

  // Expires after 15 minutes from latest block timestamp
  const afterExpiry = t0 + 120_000 + YOUTUBE_BLOCK_TTL_MS + 1;
  assert.equal(isYouTubeBlocked(afterExpiry, state), false);
  const okStatus = getYouTubeAdminStatus(afterExpiry, state, null);
  assert.equal(okStatus.status, 'ok');
  assert.equal(okStatus.blocked, false);
  assert.equal(okStatus.blockedSince, null);
  assert.equal(okStatus.proxyConfigured, false);
  assert.ok(YOUTUBE_FALLBACK_NOTICE.includes('SoundCloud'));
  assert.equal(NO_SOURCE_FOUND_ERROR, 'No se encontró en ninguna fuente');
  unsub();
});

test('direct-link source detection classifies YouTube, SoundCloud, and unsupported URLs cleanly', async () => {
  assert.deepEqual(classifyDirectLinkSource('https://youtu.be/dQw4w9WgXcQ'), {
    isUrl: true,
    source: 'youtube',
    label: 'YouTube',
    supported: true
  });
  assert.deepEqual(classifyDirectLinkSource('https://soundcloud.com/blacksun-ec/milenio'), {
    isUrl: true,
    source: 'soundcloud',
    label: 'SoundCloud',
    supported: true
  });
  assert.deepEqual(classifyDirectLinkSource('https://example.com/audio.mp3'), {
    isUrl: true,
    source: 'other',
    label: 'Otra fuente',
    supported: false
  });
  assert.equal(classifyDirectLinkSource('Soda Stereo De Musica Ligera').isUrl, false);

  const unsupportedRes = await getSearchRoute(
    new Request('http://localhost:3333/api/search?q=' + encodeURIComponent('https://example.com/audio.mp3'))
  );
  assert.equal(unsupportedRes.status, 400);
  const unsupportedBody = await unsupportedRes.json();
  assert.equal(unsupportedBody.source, 'other');
  assert.match(unsupportedBody.error, /YouTube o SoundCloud/i);
});

test('youtube-priority: YTDLP_PROXY promotes YouTube to primary even without cookies unless blocked', () => {
  assert.equal(
    shouldPreferYouTubePrimary({
      skipYoutube: false,
      hasCookiesConfigured: false,
      hasProxyConfigured: true,
      isDirectScAltRetry: false
    }),
    true
  );
  assert.equal(
    shouldPreferYouTubePrimary({
      skipYoutube: false,
      hasCookiesConfigured: false,
      hasProxyConfigured: false,
      isDirectScAltRetry: false
    }),
    false
  );
  assert.equal(
    shouldPreferYouTubePrimary({
      skipYoutube: true,
      hasCookiesConfigured: true,
      hasProxyConfigured: true,
      isDirectScAltRetry: false
    }),
    false
  );
});

test('link-preview: resolveYouTubeLinkTrack skips yt-dlp probe when oEmbed succeeds and falls back when oEmbed fails', async () => {
  let probeCalls = 0;
  const fromOembed = await resolveYouTubeLinkTrack('dQw4w9WgXcQ', {
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
        author_name: 'Rick Astley',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
      })
    }),
    probeFn: async () => {
      probeCalls += 1;
      return { durationSec: 213, title: 'Should Not Be Called' };
    },
    catalogDurationFn: async () => 213
  });

  assert.equal(probeCalls, 0);
  assert.equal(fromOembed.artist, 'Rick Astley');
  assert.equal(fromOembed.title, 'Never Gonna Give You Up');
  assert.equal(fromOembed.durationSec, 213);
  assert.equal(fromOembed.duration, '3:33');

  const fromProbeFallback = await resolveYouTubeLinkTrack('dQw4w9WgXcQ', {
    fetchFn: async () => ({ ok: false, status: 404 }),
    probeFn: async () => {
      probeCalls += 1;
      return {
        durationSec: 198,
        title: 'Solar Echo - Aurora Borealis',
        uploader: 'Solar Echo',
        thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg'
      };
    },
    catalogDurationFn: async () => 0
  });

  assert.equal(probeCalls, 1);
  assert.equal(fromProbeFallback.artist, 'Solar Echo');
  assert.equal(fromProbeFallback.title, 'Aurora Borealis');
  assert.equal(fromProbeFallback.durationSec, 198);
});

test('dedupe: buildDownloadDedupeKey normalizes URLs/remasters and POST /api/download coalesces in-flight + reuses warm bridge files safely', async () => {
  assert.equal(
    buildDownloadDedupeKey({ rawQuery: 'https://youtu.be/dQw4w9WgXcQ?si=xyz123' }),
    buildDownloadDedupeKey({
      rawQuery: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share'
    })
  );
  assert.notEqual(
    buildDownloadDedupeKey({
      rawQuery: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      forceAlternateSource: false
    }),
    buildDownloadDedupeKey({
      rawQuery: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      forceAlternateSource: true
    })
  );
  assert.equal(
    buildDownloadDedupeKey({
      rawQuery: 'Soda Stereo - De Musica Ligera',
      title: 'De Música Ligera (Remastered 2007)',
      artist: 'Soda Stereo'
    }),
    buildDownloadDedupeKey({
      rawQuery: 'Soda Stereo - De Musica Ligera',
      title: 'De Musica Ligera',
      artist: 'Soda Stereo'
    })
  );

  const prevDataDir = process.env.DATA_DIR;
  const prevDownloadsDir = process.env.DOWNLOADS_DIR;
  const prevYtDlpBin = process.env.YTDLP_BIN;
  const prevLogPath = process.env.E2E_YTDLP_LOG_PATH;
  const prevMockM4aPath = process.env.E2E_MOCK_M4A_PATH;
  const origFetch = globalThis.fetch;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-dedupe-test-'));
  const tempData = path.join(tempRoot, 'data');
  const tempDownloads = path.join(tempRoot, 'downloads');
  const logFile = path.join(tempRoot, 'ytdlp.jsonl');
  const mockM4aFile = path.join(tempRoot, 'fixture.m4a');
  fs.mkdirSync(tempData, { recursive: true });
  fs.mkdirSync(tempDownloads, { recursive: true });

  const gen = spawnSync(
    process.env.FFMPEG_BIN?.trim() || 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=20:c=pink:r=44100:a=0.18',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      mockM4aFile
    ],
    { stdio: 'pipe' }
  );
  assert.equal(gen.status, 0);

  process.env.DATA_DIR = tempData;
  process.env.DOWNLOADS_DIR = tempDownloads;
  process.env.YTDLP_BIN = path.resolve('tests/e2e/yt-dlp-mock.mjs');
  process.env.E2E_YTDLP_LOG_PATH = logFile;
  process.env.E2E_MOCK_M4A_PATH = mockM4aFile;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

  try {
    const store = loadStore();
    const adminUser = store.users[0];
    const token = createSessionToken(adminUser);
    const cookieHeader = `mymusic_session=${encodeURIComponent(token)}`;

    const makePost = () =>
      postDownloadRoute(
        new Request('http://localhost:3333/api/download', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookieHeader
          },
          body: JSON.stringify({
            sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            title: 'Aurora Borealis',
            artist: 'Solar Echo',
            priority: true
          })
        })
      );

    // Fire two simultaneous requests for the exact same YouTube URL
    const [res1, res2] = await Promise.all([makePost(), makePost()]);
    const body1 = await res1.json();
    const body2 = await res2.json();
    assert.equal(body1.ok, true);
    assert.equal(body2.ok, true);
    assert.equal(body2.coalesced, true);
    assert.notEqual(body1.downloadId, body2.downloadId);

    // Poll until both reach ready
    const waitReady = async id => {
      for (let i = 0; i < 60; i += 1) {
        const pollRes = await getDownloadRoute(
          new Request(`http://localhost:3333/api/download?id=${encodeURIComponent(id)}`, {
            headers: { Cookie: cookieHeader }
          })
        );
        const pollBody = await pollRes.json();
        if (pollBody.status === 'ready') return pollBody;
        if (pollBody.status === 'error') {
          throw new Error(`Unexpected download error for ${id}: ${pollBody.error}`);
        }
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`Timed out waiting for ${id}`);
    };

    const [ready1, ready2] = await Promise.all([
      waitReady(body1.downloadId),
      waitReady(body2.downloadId)
    ]);

    assert.ok(ready1.filename);
    assert.ok(ready2.filename);
    assert.notEqual(ready1.filename, ready2.filename);
    assert.equal(ready1.dedupeKey, undefined);
    assert.ok(fs.existsSync(path.join(tempDownloads, ready1.filename)));
    assert.ok(fs.existsSync(path.join(tempDownloads, ready2.filename)));

    // Verify yt-dlp ran only ONCE for both concurrent downloads
    const logLines = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => JSON.parse(l));
    const downloadSpawns = logLines.filter(l => l.mode === 'download');
    assert.equal(downloadSpawns.length, 1);

    // Simulate /api/stream deleting the first request's file: follower's file stays intact
    // and a 3rd request hits the warm 90s bridge cache immediately with 0 extra yt-dlp spawns
    fs.unlinkSync(path.join(tempDownloads, ready1.filename));
    assert.ok(fs.existsSync(path.join(tempDownloads, ready2.filename)));

    const res3 = await makePost();
    const body3 = await res3.json();
    assert.equal(body3.ok, true);
    assert.equal(body3.cached, true);
    const ready3 = await waitReady(body3.downloadId);
    assert.ok(ready3.filename);
    assert.notEqual(ready3.filename, ready2.filename);
    assert.ok(fs.existsSync(path.join(tempDownloads, ready3.filename)));

    const logLinesAfterCache = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => JSON.parse(l));
    assert.equal(logLinesAfterCache.filter(l => l.mode === 'download').length, 1);
  } finally {
    globalThis.fetch = origFetch;
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    if (prevDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = prevDownloadsDir;
    if (prevYtDlpBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevYtDlpBin;
    if (prevLogPath === undefined) delete process.env.E2E_YTDLP_LOG_PATH;
    else process.env.E2E_YTDLP_LOG_PATH = prevLogPath;
    if (prevMockM4aPath === undefined) delete process.env.E2E_MOCK_M4A_PATH;
    else process.env.E2E_MOCK_M4A_PATH = prevMockM4aPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
