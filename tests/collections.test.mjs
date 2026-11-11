import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-collections-test-'));
const tempDataDir = path.join(tempRoot, 'data');
const tempDownloadsDir = path.join(tempRoot, 'downloads');
fs.mkdirSync(tempDataDir, { recursive: true });
fs.mkdirSync(tempDownloadsDir, { recursive: true });

process.env.DATA_DIR = tempDataDir;
process.env.DOWNLOADS_DIR = tempDownloadsDir;

const storeMod = await import('../lib/store.js');
const mergeMod = await import('../lib/collections-merge.js');
const collectionsRoute = await import('../app/api/collections/route.js');
const coverRoute = await import('../app/api/cover/[id]/route.js');
const uploadIdRoute = await import('../app/api/upload/[id]/route.js');

const {
  loadStore,
  saveStore,
  getSessionUser,
  createSessionToken,
  createUserWithInvite,
  getUserCollections,
  saveUserCollections,
  resolveSafeUserJsonPath,
  resolveSafeCoverPath,
  addUserUploadRecord,
  updateUserUploadMetadata,
  migrateLegacyCollectionsIfNeeded
} = storeMod;

const { mergeCollectionsSnapshots } = mergeMod;

// Minimal valid JPEG buffer (>= 32 bytes, starts with SOI 0xFF 0xD8 and ends with EOI 0xFF 0xD9)
function createMinimalJpegBuffer(tagByte = 0x41) {
  const buf = Buffer.alloc(64, tagByte);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  buf[62] = 0xff;
  buf[63] = 0xd9;
  return buf;
}

function createTestUsers() {
  const store = loadStore();
  store.invites.push({
    code: 'COLLINV1',
    label: 'Collections Test',
    max_uses: 5,
    used_count: 0,
    revoked: false,
    created_at: new Date().toISOString()
  });
  saveStore(store);

  const userA = store.users[0];
  const regB = createUserWithInvite('secondcollector', 'pass1234', 'COLLINV1');
  assert.ok(regB.user);
  const regC = createUserWithInvite('migrateduser', 'pass1234', 'COLLINV1');
  assert.ok(regC.user);

  return {
    userA,
    cookieA: `mymusic_session=${encodeURIComponent(createSessionToken(userA))}`,
    userB: regB.user,
    cookieB: `mymusic_session=${encodeURIComponent(createSessionToken(regB.user))}`,
    userC: regC.user,
    cookieC: `mymusic_session=${encodeURIComponent(createSessionToken(regC.user))}`
  };
}

const users = createTestUsers();

test.after(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

test('saveStore writes atomically without collections key or leftover .tmp files', () => {
  for (let i = 0; i < 6; i++) {
    const store = loadStore();
    store.invites[0].label = `Atomic Iter ${i}`;
    saveStore(store);
  }
  const files = fs.readdirSync(tempDataDir);
  assert.equal(
    files.some(name => name.includes('.tmp.')),
    false,
    `Expected zero leftover temp files, found: ${files.join(', ')}`
  );
  const rawStoreJson = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'store.json'), 'utf8'));
  assert.equal('collections' in rawStoreJson, false);
  assert.equal(rawStoreJson.invites[0].label, 'Atomic Iter 5');
});

test('GET and PUT /api/collections require authentication (401)', async () => {
  const getRes = await collectionsRoute.GET(new Request('http://localhost/api/collections'));
  assert.equal(getRes.status, 401);

  const putRes = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ likedTracks: [], customPlaylists: [] })
    })
  );
  assert.equal(putRes.status, 401);
});

test('PUT /api/collections enforces optimistic locking (first upload, 200 increment, 400 missing baseVersion, 409 conflict without touching disk)', async () => {
  // Initial GET returns version: 0 and hasSnapshot: false
  const initRes = await collectionsRoute.GET(
    new Request('http://localhost/api/collections', {
      headers: { cookie: users.cookieA }
    })
  );
  assert.equal(initRes.status, 200);
  const initBody = await initRes.json();
  assert.equal(initBody.hasSnapshot, false);
  assert.equal(initBody.version, 0);

  // First upload exception: allowed without baseVersion when user has no snapshot yet -> version becomes 1
  const firstPut = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieA,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        likedTracks: [
          {
            id: 'trk_1',
            title: 'Canción Inicial',
            artist: 'Artista Uno',
            artwork: 'https://cdn.example.com/cover1.jpg',
            addedAt: 1000,
            updatedAt: 1000
          }
        ],
        customPlaylists: []
      })
    })
  );
  assert.equal(firstPut.status, 200);
  const firstBody = await firstPut.json();
  assert.equal(firstBody.version, 1);

  const userCollectionFile = path.join(tempDataDir, 'collections', `${users.userA.id}.json`);
  assert.equal(fs.existsSync(userCollectionFile), true);

  // Subsequent PUT without baseVersion -> 400
  const missingVerPut = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieA,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        likedTracks: [],
        customPlaylists: []
      })
    })
  );
  assert.equal(missingVerPut.status, 400);

  // PUT with matching baseVersion: 1 -> 200 and version increments to 2
  const validPut = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieA,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseVersion: 1,
        likedTracks: [
          {
            id: 'trk_1',
            title: 'Canción Inicial',
            artist: 'Artista Uno',
            artwork: 'https://cdn.example.com/cover1.jpg',
            addedAt: 1000,
            updatedAt: 1000
          },
          {
            id: 'trk_2',
            title: 'Segunda Canción',
            artist: 'Artista Dos',
            artwork: 'https://cdn.example.com/cover2.jpg',
            addedAt: 2000,
            updatedAt: 2000
          }
        ],
        customPlaylists: []
      })
    })
  );
  assert.equal(validPut.status, 200);
  const validBody = await validPut.json();
  assert.equal(validBody.version, 2);

  // Capture exact bytes on disk before stale PUT
  const diskBeforeConflict = fs.readFileSync(userCollectionFile, 'utf8');

  // PUT with stale baseVersion: 1 -> 409 returning current server snapshot (version 2) and modifying NOTHING on disk
  const stalePut = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieA,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseVersion: 1,
        likedTracks: [
          {
            id: 'trk_overwrite_attempt',
            title: 'No debe guardarse',
            artist: 'Intruso'
          }
        ],
        customPlaylists: []
      })
    })
  );
  assert.equal(stalePut.status, 409);
  const staleBody = await stalePut.json();
  assert.equal(staleBody.conflict, true);
  assert.equal(staleBody.version, 2);
  assert.equal(staleBody.likedTracks.length, 2);

  const diskAfterConflict = fs.readFileSync(userCollectionFile, 'utf8');
  assert.equal(diskAfterConflict, diskBeforeConflict);
});

test('Two-device merge preserves distinct additions, respects local playlist order, resolves updatedAt, and prevents deleted favorites from reviving', async () => {
  // Base state on server for User B (version 1):
  // Favorites: fav_shared (t=1000), fav_to_delete (t=1000)
  // Playlist pl_roadtrip: [song_a, song_b]
  const basePut = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieB,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        likedTracks: [
          { id: 'fav_shared', title: 'Shared Old Title', artist: 'Band', addedAt: 1000, updatedAt: 1000 },
          { id: 'fav_to_delete', title: 'Delete Me', artist: 'Band', addedAt: 1000, updatedAt: 1000 }
        ],
        customPlaylists: [
          {
            id: 'pl_roadtrip',
            name: 'Ruta',
            createdAt: 1000,
            updatedAt: 1000,
            tracks: [
              { id: 'song_a', title: 'Song A', artist: 'A', addedAt: 1000, updatedAt: 1000 },
              { id: 'song_b', title: 'Song B', artist: 'B', addedAt: 1001, updatedAt: 1001 }
            ]
          }
        ]
      })
    })
  );
  assert.equal(basePut.status, 200);
  const baseBody = await basePut.json();
  assert.equal(baseBody.version, 1);

  // Device 1 saves first (baseVersion 1 -> 2):
  // - Adds fav_device1
  // - Deletes fav_to_delete at deletedAt=3000
  // - Adds song_server_only to pl_roadtrip and adds new playlist pl_gym
  const dev1Put = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieB,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseVersion: 1,
        likedTracks: [
          { id: 'fav_shared', title: 'Shared Old Title', artist: 'Band', addedAt: 1000, updatedAt: 1000 },
          { id: 'fav_device1', title: 'Added On Phone', artist: 'Phone Artist', addedAt: 2500, updatedAt: 2500 }
        ],
        deletedLikes: [{ id: 'fav_to_delete', deletedAt: 3000 }],
        customPlaylists: [
          {
            id: 'pl_roadtrip',
            name: 'Ruta',
            createdAt: 1000,
            updatedAt: 2600,
            tracks: [
              { id: 'song_a', title: 'Song A', artist: 'A', addedAt: 1000, updatedAt: 1000 },
              { id: 'song_b', title: 'Song B', artist: 'B', addedAt: 1001, updatedAt: 1001 },
              { id: 'song_server_only', title: 'Server Only', artist: 'S', addedAt: 2600, updatedAt: 2600 }
            ]
          },
          {
            id: 'pl_gym',
            name: 'Gym',
            createdAt: 2700,
            updatedAt: 2700,
            tracks: [{ id: 'song_gym', title: 'Lift', artist: 'G', addedAt: 2700, updatedAt: 2700 }]
          }
        ]
      })
    })
  );
  assert.equal(dev1Put.status, 200);

  // Device 2 (still on baseVersion 1) had:
  // - Edited fav_shared title at updatedAt=4000 (newer than server's 1000)
  // - Still had fav_to_delete (updatedAt=1000, older than deletedAt=3000 -> MUST NOT REVIVE!)
  // - Added fav_device2
  // - Reordered pl_roadtrip locally as [song_local_first, song_b, song_a]
  const dev2Local = {
    baseVersion: 1,
    likedTracks: [
      { id: 'fav_device2', title: 'Added On PC', artist: 'PC Artist', addedAt: 3500, updatedAt: 3500 },
      { id: 'fav_shared', title: 'Shared Edited Title', artist: 'Band', addedAt: 1000, updatedAt: 4000 },
      { id: 'fav_to_delete', title: 'Delete Me', artist: 'Band', addedAt: 1000, updatedAt: 1000 }
    ],
    deletedLikes: [],
    customPlaylists: [
      {
        id: 'pl_roadtrip',
        name: 'Ruta',
        createdAt: 1000,
        updatedAt: 3600,
        tracks: [
          { id: 'song_local_first', title: 'Local First', artist: 'L', addedAt: 3600, updatedAt: 3600 },
          { id: 'song_b', title: 'Song B', artist: 'B', addedAt: 1001, updatedAt: 1001 },
          { id: 'song_a', title: 'Song A', artist: 'A', addedAt: 1000, updatedAt: 1000 }
        ]
      }
    ],
    deletedPlaylists: []
  };

  const conflictRes = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieB,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(dev2Local)
    })
  );
  assert.equal(conflictRes.status, 409);
  const conflictSnap = await conflictRes.json();
  assert.equal(conflictSnap.version, 2);

  // Client merges local + server conflict snapshot and retries with baseVersion = 2
  const merged = mergeCollectionsSnapshots(dev2Local, conflictSnap);

  const retryRes = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieB,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseVersion: conflictSnap.version,
        ...merged
      })
    })
  );
  assert.equal(retryRes.status, 200);
  const retryBody = await retryRes.json();
  assert.equal(retryBody.version, 3);

  const finalGet = await collectionsRoute.GET(
    new Request('http://localhost/api/collections', {
      headers: { cookie: users.cookieB }
    })
  );
  const finalSnap = await finalGet.json();

  const likedIds = finalSnap.likedTracks.map(t => t.id);
  assert.equal(likedIds.includes('fav_device1'), true, 'Device 1 favorite preserved');
  assert.equal(likedIds.includes('fav_device2'), true, 'Device 2 favorite preserved');
  assert.equal(likedIds.includes('fav_to_delete'), false, 'Deleted favorite must NOT revive');

  const sharedTrack = finalSnap.likedTracks.find(t => t.id === 'fav_shared');
  assert.equal(sharedTrack.title, 'Shared Edited Title', 'Newer updatedAt wins');

  const roadtrip = finalSnap.customPlaylists.find(p => p.id === 'pl_roadtrip');
  assert.ok(roadtrip);
  assert.deepEqual(
    roadtrip.tracks.map(t => t.id),
    ['song_local_first', 'song_b', 'song_a', 'song_server_only'],
    'Local playlist order respected and server-only tracks appended at the end'
  );
  assert.ok(finalSnap.customPlaylists.some(p => p.id === 'pl_gym'), 'Server-only playlist preserved');
});

test('Migration from store.json with legacy collections creates per-user files, cleans store.json, is idempotent, and getSessionUser never reads collections', () => {
  const storeFile = path.join(tempDataDir, 'store.json');
  const rawStore = JSON.parse(fs.readFileSync(storeFile, 'utf8'));

  // Inject legacy collections map into store.json
  rawStore.collections = {
    [users.userC.id]: {
      updatedAt: 5555,
      likedTracks: [
        { id: 'legacy_1', title: 'Canción Heredada', artist: 'Clásico', artwork: 'https://cdn.example.com/1.jpg' }
      ],
      customPlaylists: [
        {
          id: 'pl_legacy',
          name: 'Antes de Migrar',
          createdAt: 5000,
          tracks: [{ id: 'legacy_2', title: 'Pista 2', artist: 'Clásico' }]
        }
      ]
    }
  };
  fs.writeFileSync(storeFile, JSON.stringify(rawStore, null, 2), 'utf8');

  const firstMigration = migrateLegacyCollectionsIfNeeded();
  assert.equal(firstMigration.ok, true);
  assert.equal(firstMigration.migrated, true);

  const migratedFile = path.join(tempDataDir, 'collections', `${users.userC.id}.json`);
  assert.equal(fs.existsSync(migratedFile), true);

  const afterStoreRaw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.equal('collections' in afterStoreRaw, false, 'collections removed from store.json after copy');
  assert.equal(Array.isArray(afterStoreRaw.users), true, 'users preserved');
  assert.equal(Array.isArray(afterStoreRaw.invites), true, 'invites preserved');
  assert.equal(Array.isArray(afterStoreRaw.uploads), true, 'uploads preserved');

  // Running migration a second time (even if collections reappears) is idempotent and does not duplicate tracks
  fs.writeFileSync(
    storeFile,
    JSON.stringify({ ...afterStoreRaw, collections: rawStore.collections }, null, 2),
    'utf8'
  );
  const secondMigration = migrateLegacyCollectionsIfNeeded();
  assert.equal(secondMigration.ok, true);

  const colC = getUserCollections(users.userC.id);
  assert.equal(colC.ok, true);
  assert.equal(colC.likedTracks.length, 1);
  assert.equal(colC.customPlaylists.length, 1);
  assert.equal(colC.customPlaylists[0].tracks.length, 1);

  // Verify getSessionUser succeeds even if collections directory is unreadable/corrupted (does not read collections)
  fs.writeFileSync(migratedFile, '{corrupted-json-not-read-by-session', 'utf8');
  const sessionUser = getSessionUser(
    new Request('http://localhost/api/auth', {
      headers: { cookie: users.cookieC }
    })
  );
  assert.ok(sessionUser);
  assert.equal(sessionUser.id, users.userC.id);

  // Restore valid collection file
  saveUserCollections(users.userC.id, {
    likedTracks: colC.likedTracks,
    customPlaylists: colC.customPlaylists
  });
});

test('Path traversal in userId and uploadId is strictly rejected', async () => {
  const badUserIds = [
    '../store',
    '..\\store',
    'usr_../../etc/passwd',
    'usr_valid/../../evil',
    '',
    'admin'
  ];
  for (const badUid of badUserIds) {
    assert.equal(resolveSafeUserJsonPath('collections', badUid), null);
    const getRes = getUserCollections(badUid);
    assert.equal(getRes.ok, false);
    assert.equal(getRes.status, 400);
    const saveRes = saveUserCollections(badUid, { likedTracks: [] });
    assert.equal(saveRes.ok, false);
    assert.equal(saveRes.status, 400);
  }

  const badUploadIds = [
    '../store.json',
    '..\\secret',
    'upl_../../../../etc/passwd',
    'upl_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    'upl_123'
  ];
  for (const badId of badUploadIds) {
    assert.equal(resolveSafeCoverPath(badId), null);
    const res = await coverRoute.GET(
      new Request(`http://localhost/api/cover/${encodeURIComponent(badId)}`, {
        headers: { cookie: users.cookieA }
      }),
      { params: Promise.resolve({ id: badId }) }
    );
    assert.equal(res.status, 400);
  }
});

test('Covers stored outside JSON: /api/cover/<uploadId> enforces 401/403/200 and deleting upload record removes cover file', async () => {
  const ownId = 'upl_' + 'a'.repeat(32);
  const jpegBuf = createMinimalJpegBuffer(0x52);
  const dataUrl = `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;

  const created = addUserUploadRecord({
    id: ownId,
    userId: users.userA.id,
    filename: `${ownId}.m4a`,
    title: 'Tema Con Portada',
    artist: 'Banda Propia',
    album: ' Álbum ',
    artwork: dataUrl
  });

  // JSON record only stores /api/cover/<uploadId>, never base64 data:image/
  assert.equal(created.artwork, `/api/cover/${ownId}`);
  const rawStoreText = fs.readFileSync(path.join(tempDataDir, 'store.json'), 'utf8');
  assert.equal(rawStoreText.includes('data:image/'), false);

  const coverDiskPath = path.join(tempDataDir, 'covers', `${ownId}.jpg`);
  assert.equal(fs.existsSync(coverDiskPath), true);

  // 401 without session
  const unauthRes = await coverRoute.GET(
    new Request(`http://localhost/api/cover/${ownId}`),
    { params: Promise.resolve({ id: ownId }) }
  );
  assert.equal(unauthRes.status, 401);

  // 403 when requested by User B (not owner)
  const forbiddenRes = await coverRoute.GET(
    new Request(`http://localhost/api/cover/${ownId}`, {
      headers: { cookie: users.cookieB }
    }),
    { params: Promise.resolve({ id: ownId }) }
  );
  assert.equal(forbiddenRes.status, 403);

  // 200 image/jpeg for owner User A
  const ownerRes = await coverRoute.GET(
    new Request(`http://localhost/api/cover/${ownId}`, {
      headers: { cookie: users.cookieA }
    }),
    { params: Promise.resolve({ id: ownId }) }
  );
  assert.equal(ownerRes.status, 200);
  assert.equal(ownerRes.headers.get('Content-Type'), 'image/jpeg');
  const servedBytes = Buffer.from(await ownerRes.arrayBuffer());
  assert.deepEqual(servedBytes, jpegBuf);

  // External https covers continue to work unchanged alongside /api/cover/<id>
  const currentA = getUserCollections(users.userA.id);
  const putMix = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieA,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseVersion: currentA.version,
        likedTracks: [
          {
            id: ownId,
            uploadId: ownId,
            title: 'Tema Con Portada',
            artist: 'Banda Propia',
            source: 'own',
            artwork: `/api/cover/${ownId}`
          },
          {
            id: 'ext_1',
            title: 'Externa',
            artist: 'CDN',
            artwork: 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/cover/100x100bb.jpg'
          }
        ],
        customPlaylists: []
      })
    })
  );
  assert.equal(putMix.status, 200);

  // Metadata patch propagation updates per-user collection file as well
  updateUserUploadMetadata(ownId, users.userA.id, { artist: 'Banda Renombrada' });
  const updatedColA = getUserCollections(users.userA.id);
  assert.equal(updatedColA.likedTracks[0].artist, 'Banda Renombrada');

  // Deleting the upload record (?record=1) deletes both the upload record and data/covers/<uploadId>.jpg
  const delRecordRes = await uploadIdRoute.DELETE(
    new Request(`http://localhost/api/upload/${ownId}?record=1`, {
      method: 'DELETE',
      headers: { cookie: users.cookieA }
    }),
    { params: Promise.resolve({ id: ownId }) }
  );
  assert.equal(delRecordRes.status, 200);
  const delBody = await delRecordRes.json();
  assert.equal(delBody.recordDeleted, true);
  assert.equal(fs.existsSync(coverDiskPath), false, 'Cover file removed when upload record is deleted');

  const afterDelCoverRes = await coverRoute.GET(
    new Request(`http://localhost/api/cover/${ownId}`, {
      headers: { cookie: users.cookieA }
    }),
    { params: Promise.resolve({ id: ownId }) }
  );
  assert.equal(afterDelCoverRes.status, 404);
});

test('PUT /api/collections rejects oversized bodies above 2 MB (413)', async () => {
  const hugeString = 'x'.repeat(2 * 1024 * 1024 + 4096);
  const res = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieA,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseVersion: 1,
        likedTracks: [{ id: '1', title: hugeString }],
        customPlaylists: []
      })
    })
  );
  assert.equal(res.status, 413);
});
