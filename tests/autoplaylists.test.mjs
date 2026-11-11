import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-autoplaylists-test-'));
const tempDataDir = path.join(tempRoot, 'data');
const tempDownloadsDir = path.join(tempRoot, 'downloads');
fs.mkdirSync(tempDataDir, { recursive: true });
fs.mkdirSync(tempDownloadsDir, { recursive: true });

process.env.DATA_DIR = tempDataDir;
process.env.DOWNLOADS_DIR = tempDownloadsDir;

const storeMod = await import('../lib/store.js');
const listeningShared = await import('../lib/listening-shared.js');
const listeningStore = await import('../lib/listening-store.js');
const listeningRoute = await import('../app/api/listening/route.js');
const shuffleMod = await import('../lib/shuffle.js');
const autoMod = await import('../lib/autoplaylists.js');

const { loadStore, saveStore, createSessionToken, createUserWithInvite } = storeMod;
const { getHourBucketName, mergeListeningEntries, applyListeningDeltaToMap } = listeningShared;
const { getUserListeningHistory, saveUserListeningHistory } = listeningStore;
const { createArtistKeyResolver } = shuffleMod;
const {
  COLD_START_MESSAGE,
  MIN_AUTOPLAYLIST_SIZE,
  MAX_AUTOPLAYLIST_SIZE,
  isRealGenre,
  scoreTrackAffinity,
  computeArtistAffinities,
  generateAutoPlaylists
} = autoMod;

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = Date.parse('2026-11-10T15:30:00Z');

function setupTestAuth() {
  const store = loadStore();
  store.invites.push({
    code: 'LISTEN01',
    label: 'Listening Test',
    max_uses: 5,
    used_count: 0,
    revoked: false,
    created_at: new Date().toISOString()
  });
  saveStore(store);

  const reg = createUserWithInvite('listenerone', 'secret1234', 'LISTEN01');
  assert.ok(reg.user);
  return {
    user: reg.user,
    cookie: `mymusic_session=${encodeURIComponent(createSessionToken(reg.user))}`
  };
}

const auth = setupTestAuth();

test.after(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

function buildRichFixture() {
  const artists = [
    { name: 'Soda Stereo', genre: 'Rock Alternativo' },
    { name: 'Gustavo Cerati', genre: 'Rock Alternativo' },
    { name: 'Zoé', genre: 'Rock Alternativo' },
    { name: 'Enjambre', genre: 'Rock Alternativo' },
    { name: 'Babasónicos', genre: 'Rock Alternativo' },
    { name: 'Caifanes', genre: 'Rock Alternativo' },
    { name: 'Los Bunkers', genre: 'Rock Alternativo' },
    { name: 'Café Tacvba', genre: 'Rock Alternativo' },
    { name: 'Daft Punk', genre: 'Offline' },
    { name: 'Justice', genre: 'YouTube' },
    { name: 'Parcels', genre: 'Música' },
    { name: 'Jungle', genre: 'Spotify CSV' }
  ];

  const tracksPool = [];
  const likedTracks = [];
  const recommendedTracks = [];
  const listeningEntries = {};

  let idCounter = 1;

  for (let aIdx = 0; aIdx < artists.length; aIdx++) {
    const artist = artists[aIdx];
    const songCount = aIdx < 3 ? 16 : 6;

    for (let s = 0; s < songCount; s++) {
      const id = `trk_${idCounter++}`;
      const track = {
        id,
        title: `Canción ${s + 1} (${artist.name})`,
        artist: artist.name,
        genre: artist.genre,
        artwork: `https://cdn.example.com/covers/${id}.jpg`,
        addedAt: FIXED_NOW - 40 * DAY_MS
      };
      tracksPool.push(track);

      // Favorites spread across artists
      if (s < 2) {
        likedTracks.push(track);
      }

      if (s === 0 || s === 1) {
        // Recent high-affinity plays in afternoon ('tarde')
        const basePlays = aIdx < 3 ? 8 - aIdx : 3;
        listeningEntries[id] = {
          plays: basePlays,
          skips: 0,
          completes: Math.max(1, basePlays - 1),
          lastPlayedAt: FIXED_NOW - (s + 1) * DAY_MS,
          hourBuckets: { madrugada: 0, manana: 1, tarde: basePlays - 1, noche: 0 }
        };
      } else if (s === 2 || s === 3) {
        // Older plays (> 21 days ago) for "Redescubre"
        listeningEntries[id] = {
          plays: 4,
          skips: 0,
          completes: 3,
          lastPlayedAt: FIXED_NOW - (25 + s) * DAY_MS,
          hourBuckets: { madrugada: 0, manana: 0, tarde: 3, noche: 1 }
        };
      } else {
        // Saved unplayed / 1-play gems with 0 skips ("Joyas sin escuchar")
        if (s === 4) {
          listeningEntries[id] = {
            plays: 1,
            skips: 0,
            completes: 1,
            lastPlayedAt: FIXED_NOW - 5 * DAY_MS,
            hourBuckets: { madrugada: 0, manana: 0, tarde: 1, noche: 0 }
          };
        }
      }
    }
  }

  // Add boundary-date track played 20 days ago (must NOT appear in Redescubre) and exact 21 days ago (must NOT appear in > 21 days Redescubre)
  const boundaryRecentId = 'trk_boundary_21d';
  tracksPool.push({
    id: boundaryRecentId,
    title: 'Exactamente 21 Días',
    artist: 'Mon Laferte',
    genre: 'Indie',
    artwork: 'https://cdn.example.com/covers/b21.jpg',
    addedAt: FIXED_NOW - 21 * DAY_MS
  });
  listeningEntries[boundaryRecentId] = {
    plays: 6,
    skips: 0,
    completes: 6,
    lastPlayedAt: FIXED_NOW - 21 * DAY_MS,
    hourBuckets: { madrugada: 0, manana: 0, tarde: 6, noche: 0 }
  };

  // Add heavily skipped tracks (> 60% skip rate) that MUST NEVER appear in any playlist
  const skippedIds = ['trk_skip_75pct', 'trk_skip_100pct'];
  tracksPool.push(
    {
      id: skippedIds[0],
      title: 'Siempre Saltada 75',
      artist: 'Soda Stereo',
      genre: 'Rock Alternativo',
      artwork: 'https://cdn.example.com/covers/sk1.jpg',
      addedAt: FIXED_NOW - 30 * DAY_MS
    },
    {
      id: skippedIds[1],
      title: 'Siempre Saltada 100',
      artist: 'Gustavo Cerati',
      genre: 'Rock Alternativo',
      artwork: 'https://cdn.example.com/covers/sk2.jpg',
      addedAt: FIXED_NOW - 30 * DAY_MS
    }
  );
  likedTracks.push(tracksPool[tracksPool.length - 2]);
  listeningEntries[skippedIds[0]] = {
    plays: 1,
    skips: 3, // 75% skip rate > 60%
    completes: 0,
    lastPlayedAt: FIXED_NOW - DAY_MS,
    hourBuckets: { madrugada: 0, manana: 0, tarde: 1, noche: 0 }
  };
  listeningEntries[skippedIds[1]] = {
    plays: 0,
    skips: 4, // 100% skip rate > 60%
    completes: 0,
    lastPlayedAt: 0,
    hourBuckets: { madrugada: 0, manana: 0, tarde: 0, noche: 0 }
  };

  // Recommended external catalog (24 tracks across 8 artists)
  const recArtists = [
    'Jorge Drexler',
    'Natalia Lafourcade',
    'León Larregui',
    'Él Mató a un Policía Motorizado',
    'Bandalos Chinos',
    'Conociendo Rusia',
    'Usted Señalemelo',
    'Little Jesus'
  ];
  for (let i = 0; i < 24; i++) {
    const rArtist = recArtists[i % recArtists.length];
    recommendedTracks.push({
      id: `rec_${i + 1}`,
      title: `Descubrimiento ${i + 1}`,
      artist: rArtist,
      genre: 'Recomendado',
      artwork: `https://cdn.example.com/rec/${i + 1}.jpg`
    });
  }

  const customPlaylists = [
    {
      id: 'pl_rock_latino',
      name: 'Ruta Nocturna',
      tracks: tracksPool.slice(0, 10)
    }
  ];

  return {
    tracksPool,
    likedTracks,
    customPlaylists,
    recommendedTracks,
    listeningEntries,
    skippedIds,
    boundaryRecentId
  };
}

test('Scoring: skips lower track affinity, favorites raise affinity, and artist affinity is play-weighted mean', () => {
  const sampleTrack = { id: 't1', title: 'Prófugos', artist: 'Soda Stereo' };

  const noSkips = scoreTrackAffinity(sampleTrack, { plays: 6, skips: 0, completes: 5 });
  const someSkips = scoreTrackAffinity(sampleTrack, { plays: 6, skips: 2, completes: 5 });
  const manySkips = scoreTrackAffinity(sampleTrack, { plays: 6, skips: 6, completes: 5 });

  assert.ok(noSkips > someSkips, `Expected ${noSkips} > ${someSkips}`);
  assert.ok(someSkips > manySkips, `Expected ${someSkips} > ${manySkips}`);

  const plainScore = scoreTrackAffinity(
    sampleTrack,
    { plays: 3, skips: 0, completes: 2 },
    { isLiked: false }
  );
  const likedScore = scoreTrackAffinity(
    sampleTrack,
    { plays: 3, skips: 0, completes: 2 },
    { isLiked: true }
  );
  assert.ok(likedScore > plainScore, `Expected liked ${likedScore} > plain ${plainScore}`);

  // Play-weighted artist affinity verification: (scoreA * 10 + scoreB * 2) / (10 + 2)
  const artistTracks = [
    { id: 'w1', title: 'Hit', artist: 'Cerati' },
    { id: 'w2', title: 'B-Side', artist: 'Cerati' }
  ];
  const entries = {
    w1: { plays: 10, skips: 0, completes: 9 },
    w2: { plays: 2, skips: 2, completes: 0 }
  };
  const likedIds = new Set(['w1']);
  const s1 = scoreTrackAffinity(artistTracks[0], entries.w1, { likedIds });
  const s2 = scoreTrackAffinity(artistTracks[1], entries.w2, { likedIds });
  const expectedWeightedMean = Number(((s1 * 10 + s2 * 2) / 12).toFixed(6));

  const affinities = computeArtistAffinities(artistTracks, entries, { likedIds });
  const cerati = affinities.get('cerati');
  assert.ok(cerati);
  assert.equal(cerati.totalPlays, 12);
  assert.equal(cerati.affinity, expectedWeightedMean);
});

test('Generator constraints: 15-40 size, zero adjacent artist repeats, <= 30% artist cap, > 60% skips excluded, real genres only', () => {
  const fx = buildRichFixture();
  const result = generateAutoPlaylists({
    userId: auth.user.id,
    dateKey: '2026-11-10',
    now: FIXED_NOW,
    currentHour: 15, // tarde
    tracksPool: fx.tracksPool,
    likedTracks: fx.likedTracks,
    customPlaylists: fx.customPlaylists,
    listeningEntries: fx.listeningEntries,
    recommendedTracks: fx.recommendedTracks
  });

  assert.equal(result.coldStart, false);
  assert.ok(result.totalPlays >= 20);

  const kinds = result.playlists.map(p => p.kind);
  assert.ok(kinds.includes('favorites_now'), 'Missing Tus favoritas ahora');
  assert.ok(kinds.includes('rediscover'), 'Missing Redescubre');
  assert.ok(kinds.includes('gems'), 'Missing Joyas sin escuchar');
  assert.equal(
    kinds.filter(k => k === 'artist_mix').length,
    3,
    'Expected 3 Mix de [artista] playlists'
  );
  assert.ok(kinds.includes('hour'), 'Missing Para esta hora');
  assert.ok(kinds.includes('genre_mix'), 'Missing Mix de [género]');
  assert.ok(kinds.includes('discover'), 'Missing Descubre');

  // Verify ignored genres are strictly rejected
  assert.equal(isRealGenre('Offline'), false);
  assert.equal(isRealGenre('YouTube'), false);
  assert.equal(isRealGenre('Música'), false);
  assert.equal(isRealGenre('Spotify CSV'), false);
  assert.equal(isRealGenre('Rock Alternativo'), true);

  for (const pl of result.playlists) {
    assert.ok(
      pl.tracks.length >= MIN_AUTOPLAYLIST_SIZE && pl.tracks.length <= MAX_AUTOPLAYLIST_SIZE,
      `Playlist "${pl.title}" length ${pl.tracks.length} out of [15, 40]`
    );
    assert.equal(pl.trackCount, pl.tracks.length);
    assert.equal(pl.mosaicCovers.length, 4);
    assert.ok(pl.reason && pl.reason.length > 5);

    // Never include > 60% skipped songs
    for (const tr of pl.tracks) {
      assert.equal(
        fx.skippedIds.includes(String(tr.id)),
        false,
        `Excluded high-skip track ${tr.id} leaked into "${pl.title}"`
      );
    }

    // Genre mix must never use fake genres
    if (pl.kind === 'genre_mix') {
      assert.equal(pl.title, 'Mix de Rock Alternativo');
    }

    // Redescubre must exclude songs played <= 21 days ago
    if (pl.kind === 'rediscover') {
      assert.equal(
        pl.tracks.some(t => t.id === fx.boundaryRecentId),
        false,
        'Track played exactly 21 days ago must not appear in Redescubre (> 21 days)'
      );
    }

    const resolveArtist = createArtistKeyResolver(pl.tracks);
    if (pl.kind !== 'artist_mix') {
      // Strictly <= 30% per artist and ZERO adjacent repeats
      const counts = new Map();
      const maxAllowed = Math.floor(pl.tracks.length * 0.3);
      for (let i = 0; i < pl.tracks.length; i++) {
        const key = resolveArtist(i);
        if (i > 0 && key) {
          const prevKey = resolveArtist(i - 1);
          assert.notEqual(
            key,
            prevKey,
            `Adjacent repeat of artist "${key}" at index ${i} in "${pl.title}"`
          );
        }
        if (key) {
          const next = (counts.get(key) || 0) + 1;
          counts.set(key, next);
          assert.ok(
            next <= maxAllowed,
            `Artist "${key}" has ${next}/${pl.tracks.length} tracks (> 30% cap ${maxAllowed}) in "${pl.title}"`
          );
        }
      }
    } else {
      // Artist mix: ~70% target artist + ~30% similar artists
      const counts = new Map();
      for (let i = 0; i < pl.tracks.length; i++) {
        const key = resolveArtist(i);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const maxSingleArtist = Math.max(...counts.values());
      const ratio = maxSingleArtist / pl.tracks.length;
      assert.ok(
        ratio >= 0.6 && ratio <= 0.75,
        `Expected ~70% target artist share in "${pl.title}", got ${(ratio * 100).toFixed(1)}%`
      );
      assert.ok(counts.size >= 2, `Expected similar artists alongside main artist in "${pl.title}"`);
    }
  }
});

test('Daily determinism: identical output for same userId + dateKey, renewed output on next day', () => {
  const fx = buildRichFixture();
  const baseArgs = {
    userId: 'usr_det_42',
    now: FIXED_NOW,
    currentHour: 15,
    tracksPool: fx.tracksPool,
    likedTracks: fx.likedTracks,
    customPlaylists: fx.customPlaylists,
    listeningEntries: fx.listeningEntries,
    recommendedTracks: fx.recommendedTracks
  };

  const day1RunA = generateAutoPlaylists({ ...baseArgs, dateKey: '2026-11-10' });
  const day1RunB = generateAutoPlaylists({ ...baseArgs, dateKey: '2026-11-10' });
  const day2Run = generateAutoPlaylists({ ...baseArgs, dateKey: '2026-11-11' });

  assert.deepEqual(
    day1RunA.playlists.map(p => ({ id: p.id, ids: p.tracks.map(t => t.id) })),
    day1RunB.playlists.map(p => ({ id: p.id, ids: p.tracks.map(t => t.id) }))
  );

  const favDay1 = day1RunA.playlists.find(p => p.kind === 'favorites_now').tracks.map(t => t.id);
  const favDay2 = day2Run.playlists.find(p => p.kind === 'favorites_now').tracks.map(t => t.id);
  assert.notDeepEqual(favDay1, favDay2, 'Expected daily seed renewal to reorder playlist on next day');
});

test('Empty or cold-start (< 20 plays) history never fails and shows only Descubre and Joyas sin escuchar', () => {
  // Completely empty catalog and empty history
  const completelyEmpty = generateAutoPlaylists({
    userId: 'usr_new',
    dateKey: '2026-11-10',
    now: FIXED_NOW
  });
  assert.equal(completelyEmpty.coldStart, true);
  assert.equal(completelyEmpty.totalPlays, 0);
  assert.equal(completelyEmpty.message, COLD_START_MESSAGE);
  assert.deepEqual(completelyEmpty.playlists, []);

  // 12 total plays (< 20) with saved tracks and recommendations
  const fx = buildRichFixture();
  const sparseHistory = {
    [fx.tracksPool[0].id]: {
      plays: 7,
      skips: 0,
      completes: 6,
      lastPlayedAt: FIXED_NOW - DAY_MS,
      hourBuckets: { madrugada: 0, manana: 2, tarde: 5, noche: 0 }
    },
    [fx.tracksPool[1].id]: {
      plays: 5,
      skips: 1,
      completes: 4,
      lastPlayedAt: FIXED_NOW - 2 * DAY_MS,
      hourBuckets: { madrugada: 0, manana: 0, tarde: 5, noche: 0 }
    }
  };

  const coldRes = generateAutoPlaylists({
    userId: 'usr_sparse',
    dateKey: '2026-11-10',
    now: FIXED_NOW,
    tracksPool: fx.tracksPool,
    likedTracks: fx.likedTracks,
    listeningEntries: sparseHistory,
    recommendedTracks: fx.recommendedTracks
  });

  assert.equal(coldRes.coldStart, true);
  assert.equal(coldRes.totalPlays, 12);
  assert.equal(coldRes.message, COLD_START_MESSAGE);
  assert.deepEqual(
    coldRes.playlists.map(p => p.title),
    ['Descubre', 'Joyas sin escuchar']
  );
});

test('Two-device listening merge sums counters and keeps newest lastPlayedAt; hour buckets map accurately', () => {
  assert.equal(getHourBucketName(3), 'madrugada');
  assert.equal(getHourBucketName(8), 'manana');
  assert.equal(getHourBucketName(15), 'tarde');
  assert.equal(getHourBucketName(22), 'noche');

  const phoneMap = applyListeningDeltaToMap({}, 'song_abc', {
    plays: 3,
    skips: 1,
    completes: 2,
    lastPlayedAt: 1700005000000,
    hourBuckets: { madrugada: 0, manana: 2, tarde: 1, noche: 0 }
  });

  const desktopMap = {
    song_abc: {
      plays: 4,
      skips: 2,
      completes: 3,
      lastPlayedAt: 1700009999000,
      hourBuckets: { madrugada: 1, manana: 0, tarde: 2, noche: 1 }
    },
    song_only_pc: {
      plays: 2,
      skips: 0,
      completes: 2,
      lastPlayedAt: 1700001000000,
      hourBuckets: { madrugada: 0, manana: 0, tarde: 0, noche: 2 }
    }
  };

  const merged = mergeListeningEntries(phoneMap, desktopMap);
  assert.deepEqual(merged.song_abc, {
    plays: 7,
    skips: 3,
    completes: 5,
    lastPlayedAt: 1700009999000,
    hourBuckets: { madrugada: 1, manana: 2, tarde: 3, noche: 1 }
  });
  assert.equal(merged.song_only_pc.plays, 2);
});

test('/api/listening enforces auth, path-traversal protection, optimistic locking (409), and 1 MB body limit (413)', async () => {
  // Path traversal rejected in store helpers
  for (const malicious of ['../etc/passwd', '..\\secret', 'usr/../../x', 'bad\0id', '']) {
    const rGet = getUserListeningHistory(malicious);
    assert.equal(rGet.ok, false);
    assert.equal(rGet.status, 400);

    const rSave = saveUserListeningHistory(malicious, { entries: {} });
    assert.equal(rSave.ok, false);
    assert.equal(rSave.status, 400);
  }

  // 401 without session
  const unauthGet = await listeningRoute.GET(new Request('http://localhost/api/listening'));
  assert.equal(unauthGet.status, 401);

  const unauthPut = await listeningRoute.PUT(
    new Request('http://localhost/api/listening', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: {} })
    })
  );
  assert.equal(unauthPut.status, 401);

  // First PUT creates version 1
  const put1 = await listeningRoute.PUT(
    new Request('http://localhost/api/listening', {
      method: 'PUT',
      headers: {
        cookie: auth.cookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        entries: {
          s1: {
            plays: 5,
            skips: 0,
            completes: 4,
            lastPlayedAt: 1700000000000,
            hourBuckets: { madrugada: 0, manana: 5, tarde: 0, noche: 0 }
          }
        }
      })
    })
  );
  assert.equal(put1.status, 200);
  const put1Json = await put1.json();
  assert.equal(put1Json.version, 1);

  // Missing baseVersion once snapshot exists -> 400
  const putMissingBase = await listeningRoute.PUT(
    new Request('http://localhost/api/listening', {
      method: 'PUT',
      headers: {
        cookie: auth.cookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ entries: {} })
    })
  );
  assert.equal(putMissingBase.status, 400);

  // Second valid PUT with baseVersion: 1 -> version 2
  const put2 = await listeningRoute.PUT(
    new Request('http://localhost/api/listening', {
      method: 'PUT',
      headers: {
        cookie: auth.cookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseVersion: 1,
        entries: {
          s1: {
            plays: 8,
            skips: 1,
            completes: 6,
            lastPlayedAt: 1700000500000,
            hourBuckets: { madrugada: 0, manana: 5, tarde: 3, noche: 0 }
          }
        }
      })
    })
  );
  assert.equal(put2.status, 200);
  const put2Json = await put2.json();
  assert.equal(put2Json.version, 2);

  // Stale baseVersion: 1 -> 409 conflict without altering disk
  const diskFile = path.join(tempDataDir, 'listening', `${auth.user.id}.json`);
  const beforeConflictRaw = fs.readFileSync(diskFile, 'utf8');

  const putStale = await listeningRoute.PUT(
    new Request('http://localhost/api/listening', {
      method: 'PUT',
      headers: {
        cookie: auth.cookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseVersion: 1,
        entries: { s999: { plays: 99 } }
      })
    })
  );
  assert.equal(putStale.status, 409);
  const staleJson = await putStale.json();
  assert.equal(staleJson.conflict, true);
  assert.equal(staleJson.version, 2);
  assert.equal(staleJson.entries.s1.plays, 8);
  assert.equal(fs.readFileSync(diskFile, 'utf8'), beforeConflictRaw);

  // Oversized body (> 1 MB) -> 413
  const hugePayload = JSON.stringify({
    baseVersion: 2,
    padding: 'x'.repeat(1024 * 1024 + 512)
  });
  const putHuge = await listeningRoute.PUT(
    new Request('http://localhost/api/listening', {
      method: 'PUT',
      headers: {
        cookie: auth.cookie,
        'Content-Type': 'application/json'
      },
      body: hugePayload
    })
  );
  assert.equal(putHuge.status, 413);
});
