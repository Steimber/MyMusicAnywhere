import test from 'node:test';
import assert from 'node:assert/strict';

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
import { GET as getSearchRoute } from '../app/api/search/route.js';

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
