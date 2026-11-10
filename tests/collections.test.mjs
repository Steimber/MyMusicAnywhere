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
const collectionsRoute = await import('../app/api/collections/route.js');

const {
  loadStore,
  saveStore,
  createSessionToken,
  createUserWithInvite,
  addUserUploadRecord,
  updateUserUploadMetadata
} = storeMod;

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

  return {
    userA,
    cookieA: `mymusic_session=${encodeURIComponent(createSessionToken(userA))}`,
    userB: regB.user,
    cookieB: `mymusic_session=${encodeURIComponent(createSessionToken(regB.user))}`
  };
}

const users = createTestUsers();

test.after(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

test('saveStore writes atomically without leaving leftover .tmp files', () => {
  for (let i = 0; i < 8; i++) {
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
  const reloaded = loadStore();
  assert.equal(reloaded.invites[0].label, 'Atomic Iter 7');
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

test('GET and PUT /api/collections isolate users, sanitize tracks, and sync upload metadata', async () => {
  // Initial GET returns hasSnapshot: false before first PUT
  const initRes = await collectionsRoute.GET(
    new Request('http://localhost/api/collections', {
      headers: { cookie: users.cookieA }
    })
  );
  assert.equal(initRes.status, 200);
  const initBody = await initRes.json();
  assert.equal(initBody.hasSnapshot, false);

  const ownId = 'upl_' + 'f'.repeat(32);
  addUserUploadRecord({
    id: ownId,
    userId: users.userA.id,
    filename: `${ownId}.m4a`,
    title: 'Cancion Subida',
    artist: 'Archivo propio',
    album: 'Mi música',
    artwork: '/icon.svg?v=3'
  });

  const compactDataCover =
    'data:image/jpeg;base64,' + Buffer.from('tiny-jpeg-bytes').toString('base64');

  const putRes = await collectionsRoute.PUT(
    new Request('http://localhost/api/collections', {
      method: 'PUT',
      headers: {
        cookie: users.cookieA,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        likedTracks: [
          {
            id: ownId,
            uploadId: ownId,
            title: 'Cancion Subida',
            artist: 'Archivo propio',
            album: 'Mi música',
            source: 'own',
            artwork: compactDataCover
          },
          {
            id: 'offline_local_only.mp3',
            title: 'Local Only',
            artist: 'Guardado en dispositivo',
            artwork: '/icon.svg'
          },
          {
            id: 'xss_test',
            title: 'Bad Cover',
            artist: 'Test',
            artwork: 'javascript:alert(1)'
          }
        ],
        customPlaylists: [
          {
            id: 'pl_rock',
            name: 'Rock Nacional',
            tracks: [
              {
                id: ownId,
                uploadId: ownId,
                title: 'Cancion Subida',
                artist: 'Archivo propio',
                source: 'own',
                artwork: compactDataCover
              }
            ]
          }
        ]
      })
    })
  );
  assert.equal(putRes.status, 200);
  const putBody = await putRes.json();
  assert.equal(putBody.ok, true);
  assert.equal(putBody.counts.liked, 2);
  assert.equal(putBody.counts.playlists, 1);

  // User B must NOT see User A's collections
  const userBGet = await collectionsRoute.GET(
    new Request('http://localhost/api/collections', {
      headers: { cookie: users.cookieB }
    })
  );
  const userBBody = await userBGet.json();
  assert.equal(userBBody.hasSnapshot, false);
  assert.deepEqual(userBBody.likedTracks, []);

  // User A sees sanitized snapshot (offline_ stripped, javascript: replaced with placeholder, data:image/ kept)
  const userAGet = await collectionsRoute.GET(
    new Request('http://localhost/api/collections', {
      headers: { cookie: users.cookieA }
    })
  );
  const userABody = await userAGet.json();
  assert.equal(userABody.hasSnapshot, true);
  assert.equal(userABody.likedTracks.length, 2);
  assert.equal(userABody.likedTracks[0].artwork, compactDataCover);
  assert.equal(userABody.likedTracks[1].artwork, '/icon.svg?v=3');

  // Updating upload metadata propagates to both store.uploads and store.collections[userA.id]
  const cdnCover = 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/cover/100x100bb.jpg';
  updateUserUploadMetadata(ownId, users.userA.id, {
    title: 'La Pinta La Niña y la Santa María',
    artist: 'Black Sun',
    artwork: cdnCover
  });

  const afterPatchGet = await collectionsRoute.GET(
    new Request('http://localhost/api/collections', {
      headers: { cookie: users.cookieA }
    })
  );
  const afterPatchBody = await afterPatchGet.json();
  assert.equal(afterPatchBody.likedTracks[0].artist, 'Black Sun');
  assert.equal(afterPatchBody.likedTracks[0].artwork, cdnCover);
  assert.equal(afterPatchBody.customPlaylists[0].tracks[0].artwork, cdnCover);
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
      body: JSON.stringify({ likedTracks: [{ id: '1', title: hugeString }], customPlaylists: [] })
    })
  );
  assert.equal(res.status, 413);
});
