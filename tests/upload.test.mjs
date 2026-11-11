import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-upload-test-'));
const tempDataDir = path.join(tempRoot, 'data');
const tempDownloadsDir = path.join(tempRoot, 'downloads');
fs.mkdirSync(tempDataDir, { recursive: true });
fs.mkdirSync(tempDownloadsDir, { recursive: true });

process.env.DATA_DIR = tempDataDir;
process.env.DOWNLOADS_DIR = tempDownloadsDir;

const storeMod = await import('../lib/store.js');
const uploadMod = await import('../lib/upload.js');
const uploadRoute = await import('../app/api/upload/route.js');
const uploadDeleteRoute = await import('../app/api/upload/[id]/route.js');
const streamRoute = await import('../app/api/stream/route.js');

const {
  loadStore,
  saveStore,
  createSessionToken,
  createUserWithInvite,
  getDownloadsDir,
  purgeExpiredUploads,
  purgeTempAndExpiredFiles,
  UPLOAD_TTL_MS
} = storeMod;

const {
  MAX_UPLOAD_BYTES,
  UPLOAD_ID_REGEX,
  probeAudioFile,
  sanitizeDisplayMetadataFromName
} = uploadMod;

function setupTwoUsers() {
  const store = loadStore();
  store.invites.push({
    code: 'TESTINV1',
    label: 'Test',
    max_uses: 5,
    used_count: 0,
    revoked: false,
    created_at: new Date().toISOString()
  });
  saveStore(store);

  const adminUser = store.users[0];
  const regRes = createUserWithInvite('otheruser', 'secret123', 'TESTINV1');
  assert.ok(regRes.user, 'Second user should be created');

  return {
    owner: adminUser,
    ownerCookie: `mymusic_session=${encodeURIComponent(createSessionToken(adminUser))}`,
    other: regRes.user,
    otherCookie: `mymusic_session=${encodeURIComponent(createSessionToken(regRes.user))}`
  };
}

function generateSineAudioFile(targetPath, formatArgs = []) {
  const ffmpegBin = process.env.FFMPEG_BIN?.trim() || 'ffmpeg';
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=1.2',
    ...formatArgs,
    targetPath
  ];
  const res = spawnSync(ffmpegBin, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `ffmpeg fixture generation failed: ${res.stderr}`);
}

const fixturesDir = path.join(tempRoot, 'fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });
const auth = setupTwoUsers();

test.after(() => {
  if (global.__uploadCleanupInterval) {
    clearInterval(global.__uploadCleanupInterval);
    global.__uploadCleanupInterval = null;
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

test('upload endpoints enforce authenticated session (401 without valid cookie)', async () => {
  const getRes = await uploadRoute.GET(new Request('http://localhost/api/upload'));
  assert.equal(getRes.status, 401);

  const form = new FormData();
  form.append('file', new File([Buffer.from('hello')], 'song.mp3', { type: 'audio/mpeg' }));
  const postRes = await uploadRoute.POST(
    new Request('http://localhost/api/upload', { method: 'POST', body: form })
  );
  assert.equal(postRes.status, 401);

  const forgedRes = await uploadRoute.POST(
    new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { cookie: 'mymusic_session=invalid.token' },
      body: form
    })
  );
  assert.equal(forgedRes.status, 401);

  const fakeId = 'upl_' + 'a'.repeat(32);
  const delRes = await uploadDeleteRoute.DELETE(
    new Request(`http://localhost/api/upload/${fakeId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: fakeId }) }
  );
  assert.equal(delRes.status, 401);
});

test('POST /api/upload rejects non-audio files via ffprobe and blocks path traversal names', async () => {
  const fakeMp3Bytes = Buffer.from('ID3-not-really-an-audio-stream-just-plain-text\n'.repeat(40));
  const form = new FormData();
  form.append(
    'file',
    new File([fakeMp3Bytes], '../../outside-dir/evil.mp3', { type: 'audio/mpeg' })
  );

  const res = await uploadRoute.POST(
    new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { cookie: auth.ownerCookie },
      body: form
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);

  assert.equal(fs.existsSync(path.join(tempRoot, 'evil.mp3')), false);
  assert.deepEqual(fs.readdirSync(getDownloadsDir()), []);

  // Also reject a real video stream disguised with .mp3 extension
  const fakeVideoPath = path.join(fixturesDir, 'video_disguised.mp4');
  const ffmpegBin = process.env.FFMPEG_BIN?.trim() || 'ffmpeg';
  const vidRes = spawnSync(
    ffmpegBin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=32x32:d=0.5',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:d=0.5',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      fakeVideoPath
    ],
    { encoding: 'utf8', windowsHide: true }
  );
  if (vidRes.status === 0 && fs.existsSync(fakeVideoPath)) {
    const vidForm = new FormData();
    vidForm.append(
      'file',
      new File([fs.readFileSync(fakeVideoPath)], 'sneaky_movie.mp3', { type: 'audio/mpeg' })
    );
    const vidUploadRes = await uploadRoute.POST(
      new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { cookie: auth.ownerCookie },
        body: vidForm
      })
    );
    assert.equal(vidUploadRes.status, 400);
    assert.deepEqual(fs.readdirSync(getDownloadsDir()), []);
  }
});

test('POST /api/upload enforces 50 MB maximum limit on multipart and chunked uploads (413)', async () => {
  // 1. Multipart upload slightly over 50 MB without relying solely on Content-Length
  const oversizedBlob = new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 2048)], {
    type: 'audio/wav'
  });
  const form = new FormData();
  form.append('file', oversizedBlob, 'too_big.wav');

  const multiRes = await uploadRoute.POST(
    new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { cookie: auth.ownerCookie },
      body: form
    })
  );
  assert.equal(multiRes.status, 413);

  // 2. Chunked upload declaring > 50 MB
  const chunkDeclaredRes = await uploadRoute.POST(
    new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: {
        cookie: auth.ownerCookie,
        'x-upload-mode': 'chunk',
        'x-chunk-index': '0',
        'x-total-chunks': '15',
        'x-total-size': String(MAX_UPLOAD_BYTES + 1),
        'x-file-name': encodeURIComponent('huge.flac')
      },
      body: Buffer.alloc(1024, 1)
    })
  );
  assert.equal(chunkDeclaredRes.status, 413);
  assert.deepEqual(fs.readdirSync(getDownloadsDir()), []);
});

test('POST /api/upload converts WAV to random-named M4A, sets source="own", and restricts cross-user access', async () => {
  const wavPath = path.join(fixturesDir, 'sample.wav');
  generateSineAudioFile(wavPath);
  const wavBytes = fs.readFileSync(wavPath);

  const form = new FormData();
  form.append(
    'file',
    new File([wavBytes], '..\\..\\Banda Local - Mi Tema Demo.wav', { type: 'audio/wav' })
  );

  const postRes = await uploadRoute.POST(
    new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { cookie: auth.ownerCookie },
      body: form
    })
  );
  assert.equal(postRes.status, 200);
  const data = await postRes.json();

  assert.equal(data.ok, true);
  assert.match(data.id, UPLOAD_ID_REGEX);
  assert.equal(data.filename, `${data.id}.m4a`);
  assert.equal(data.filename.includes('Banda'), false);
  assert.equal(data.track.source, 'own');
  assert.equal(data.track.fileDeleted, false);
  assert.equal(data.track.artist, 'Banda Local');
  assert.equal(data.track.title, 'Mi Tema Demo');

  const storedM4aPath = path.join(getDownloadsDir(), data.filename);
  assert.equal(fs.existsSync(storedM4aPath), true);

  const probe = await probeAudioFile(storedM4aPath);
  assert.equal(probe.ok, true);
  assert.equal(probe.acodec, 'aac');
  assert.match(probe.formatName, /m4a|mp4/);

  // Stream endpoint allows owner (200) and blocks other user (403)
  const ownerStream = await streamRoute.GET(
    new Request(`http://localhost/api/stream?file=${data.filename}`, {
      headers: { cookie: auth.ownerCookie }
    })
  );
  assert.equal(ownerStream.status, 200);
  const streamedBuf = Buffer.from(await ownerStream.arrayBuffer());
  assert.ok(streamedBuf.length > 512);

  const otherStream = await streamRoute.GET(
    new Request(`http://localhost/api/stream?file=${data.filename}`, {
      headers: { cookie: auth.otherCookie }
    })
  );
  assert.equal(otherStream.status, 403);
});

test('Chunked FLAC upload + DELETE /api/upload/:id deletes VPS file while preserving source="own" library entry', async () => {
  const flacPath = path.join(fixturesDir, 'sample.flac');
  generateSineAudioFile(flacPath, ['-metadata', 'title=Noche Acústica', '-metadata', 'artist=Solista']);
  const flacBytes = fs.readFileSync(flacPath);

  const mid = Math.floor(flacBytes.length / 2);
  const chunks = [flacBytes.subarray(0, mid), flacBytes.subarray(mid)];

  let sessionId = '';
  let finalData = null;

  for (let idx = 0; idx < chunks.length; idx++) {
    const res = await uploadRoute.POST(
      new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: {
          cookie: auth.ownerCookie,
          'x-upload-mode': 'chunk',
          'x-chunk-index': String(idx),
          'x-total-chunks': String(chunks.length),
          'x-total-size': String(flacBytes.length),
          'x-file-name': encodeURIComponent('recording.flac'),
          ...(sessionId ? { 'x-upload-session': sessionId } : {})
        },
        body: chunks[idx]
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    if (body.partial) {
      sessionId = body.uploadSession;
      assert.ok(sessionId.startsWith('ups_'));
    } else {
      finalData = body;
    }
  }

  assert.ok(finalData);
  assert.match(finalData.id, UPLOAD_ID_REGEX);
  assert.equal(finalData.track.source, 'own');
  assert.equal(finalData.track.title, 'Noche Acústica');
  assert.equal(finalData.track.artist, 'Solista');

  const m4aPath = path.join(getDownloadsDir(), finalData.filename);
  assert.equal(fs.existsSync(m4aPath), true);

  // Other user cannot delete owner's upload (403)
  const forbiddenDel = await uploadDeleteRoute.DELETE(
    new Request(`http://localhost/api/upload/${finalData.id}`, {
      method: 'DELETE',
      headers: { cookie: auth.otherCookie }
    }),
    { params: Promise.resolve({ id: finalData.id }) }
  );
  assert.equal(forbiddenDel.status, 403);
  assert.equal(fs.existsSync(m4aPath), true);

  // Owner confirms offline caching -> DELETE /api/upload/:id deletes VPS file and preserves library entry
  const ownerDel = await uploadDeleteRoute.DELETE(
    new Request(`http://localhost/api/upload/${finalData.id}`, {
      method: 'DELETE',
      headers: { cookie: auth.ownerCookie }
    }),
    { params: Promise.resolve({ id: finalData.id }) }
  );
  assert.equal(ownerDel.status, 200);
  const delBody = await ownerDel.json();
  assert.equal(delBody.ok, true);
  assert.equal(delBody.deleted, true);
  assert.equal(delBody.track.source, 'own');
  assert.equal(delBody.track.fileDeleted, true);
  assert.equal(fs.existsSync(m4aPath), false);

  // Library GET still contains the song marked as source: "own"
  const libRes = await uploadRoute.GET(
    new Request('http://localhost/api/upload', {
      headers: { cookie: auth.ownerCookie }
    })
  );
  assert.equal(libRes.status, 200);
  const libBody = await libRes.json();
  const kept = libBody.tracks.find(t => t.id === finalData.id);
  assert.ok(kept, 'Entry must remain in user library after VPS file deletion');
  assert.equal(kept.source, 'own');
  assert.equal(kept.fileDeleted, true);
});

test('24-hour sweep deletes unconfirmed upload files while keeping <24h uploads and library metadata', async () => {
  const mp3Path = path.join(fixturesDir, 'sweep.mp3');
  generateSineAudioFile(mp3Path, ['-c:a', 'libmp3lame', '-b:a', '128k']);
  const mp3Bytes = fs.readFileSync(mp3Path);

  const uploadOne = async name => {
    const form = new FormData();
    form.append('file', new File([mp3Bytes], name, { type: 'audio/mpeg' }));
    const r = await uploadRoute.POST(
      new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { cookie: auth.ownerCookie },
        body: form
      })
    );
    assert.equal(r.status, 200);
    return r.json();
  };

  const staleUpload = await uploadOne('Stale - Unconfirmed.mp3');
  const recentUpload = await uploadOne('Recent - PendingPhone.mp3');

  const staleFile = path.join(getDownloadsDir(), staleUpload.filename);
  const recentFile = path.join(getDownloadsDir(), recentUpload.filename);

  // Backdate staleUpload to 25 hours ago
  const store = loadStore();
  const staleRec = store.uploads.find(u => u.id === staleUpload.id);
  staleRec.createdAt = Date.now() - (UPLOAD_TTL_MS + 60 * 60 * 1000);
  saveStore(store);

  // 10-minute ephemeral sweep must NOT touch recentUpload (<24h)
  purgeTempAndExpiredFiles(Date.now() + 10 * 60 * 1000);
  assert.equal(fs.existsSync(recentFile), true);
  assert.equal(fs.existsSync(staleFile), false, 'Stale >24h upload should be purged');

  // Verify explicitly via purgeExpiredUploads as well
  const sweepResult = purgeExpiredUploads(Date.now());
  assert.equal(typeof sweepResult.purgedCount, 'number');

  const afterStore = loadStore();
  const staleAfter = afterStore.uploads.find(u => u.id === staleUpload.id);
  const recentAfter = afterStore.uploads.find(u => u.id === recentUpload.id);

  assert.equal(staleAfter.source, 'own');
  assert.equal(staleAfter.fileDeleted, true);
  assert.equal(recentAfter.source, 'own');
  assert.equal(recentAfter.fileDeleted, false);
  assert.equal(fs.existsSync(recentFile), true);
});

test('sanitizeDisplayMetadataFromName strips downloader prefixes, bitrates, and glued media extensions', () => {
  const cleaned = sanitizeDisplayMetadataFromName(
    'y2mate.gs - Black Sun - La Pinta La Niña y la Santa MARIAavi (320 kbps) [Official Video].mp3'
  );
  assert.equal(cleaned.fallbackArtist, 'Black Sun');
  assert.equal(cleaned.fallbackTitle, 'La Pinta La Niña y la Santa MARIA');

  const singlePart = sanitizeDisplayMetadataFromName(
    'spotifydown.com - Bohemian_Rhapsody_320kbps.m4a'
  );
  assert.equal(singlePart.fallbackArtist, 'Archivo propio');
  assert.equal(singlePart.fallbackTitle, 'Bohemian Rhapsody');
});

test('POST /api/upload extracts embedded ID3 cover art and PATCH /api/upload/:id updates metadata for owner only', async () => {
  const ffmpegBin = process.env.FFMPEG_BIN?.trim() || 'ffmpeg';
  const coverJpgPath = path.join(fixturesDir, 'cover.jpg');
  const mp3WithCoverPath = path.join(fixturesDir, 'with_cover.mp3');

  const imgGen = spawnSync(
    ffmpegBin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=orange:s=120x120:d=0.1',
      '-frames:v',
      '1',
      coverJpgPath
    ],
    { encoding: 'utf8', windowsHide: true }
  );
  assert.equal(imgGen.status, 0, `Cover fixture generation failed: ${imgGen.stderr}`);

  const mp3Gen = spawnSync(
    ffmpegBin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=523.25:sample_rate=44100:duration=1.0',
      '-i',
      coverJpgPath,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-c:v',
      'mjpeg',
      '-id3v2_version',
      '3',
      '-disposition:v:0',
      'attached_pic',
      mp3WithCoverPath
    ],
    { encoding: 'utf8', windowsHide: true }
  );
  assert.equal(mp3Gen.status, 0, `MP3 with embedded cover failed: ${mp3Gen.stderr}`);

  const form = new FormData();
  form.append(
    'file',
    new File(
      [fs.readFileSync(mp3WithCoverPath)],
      'y2mate.gs - Black Sun - La Pinta La Niña.mp3',
      { type: 'audio/mpeg' }
    )
  );

  const uploadRes = await uploadRoute.POST(
    new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { cookie: auth.ownerCookie },
      body: form
    })
  );
  assert.equal(uploadRes.status, 200);
  const uploaded = await uploadRes.json();
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.track.artist, 'Black Sun');
  assert.equal(uploaded.track.title, 'La Pinta La Niña');
  assert.equal(uploaded.track.artwork, `/api/cover/${uploaded.id}`);
  assert.equal(
    fs.existsSync(path.join(tempDataDir, 'covers', `${uploaded.id}.jpg`)),
    true,
    'Extracted JPEG cover should be saved on disk under data/covers/<uploadId>.jpg'
  );

  // Unauthenticated PATCH -> 401
  const unauthPatch = await uploadDeleteRoute.PATCH(
    new Request(`http://localhost/api/upload/${uploaded.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist: 'Hacker' })
    }),
    { params: Promise.resolve({ id: uploaded.id }) }
  );
  assert.equal(unauthPatch.status, 401);

  // Non-owner PATCH -> 403
  const otherPatch = await uploadDeleteRoute.PATCH(
    new Request(`http://localhost/api/upload/${uploaded.id}`, {
      method: 'PATCH',
      headers: {
        cookie: auth.otherCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ artist: 'Other User' })
    }),
    { params: Promise.resolve({ id: uploaded.id }) }
  );
  assert.equal(otherPatch.status, 403);

  // Owner PATCH -> 200 and persists updated cover + metadata
  const newCover = 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/test/100x100bb.jpg';
  const ownerPatch = await uploadDeleteRoute.PATCH(
    new Request(`http://localhost/api/upload/${uploaded.id}`, {
      method: 'PATCH',
      headers: {
        cookie: auth.ownerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: 'La Pinta La Niña y la Santa María',
        artist: 'Black Sun',
        album: 'La Lógica del León',
        artwork: newCover
      })
    }),
    { params: Promise.resolve({ id: uploaded.id }) }
  );
  assert.equal(ownerPatch.status, 200);
  const patchedBody = await ownerPatch.json();
  assert.equal(patchedBody.ok, true);
  assert.equal(patchedBody.track.title, 'La Pinta La Niña y la Santa María');
  assert.equal(patchedBody.track.album, 'La Lógica del León');
  assert.equal(patchedBody.track.artwork, newCover);
});

test('POST /api/upload enforces 300 MB per-user quota across files still on the VPS (413) and frees quota after deletion', async () => {
  const prevMaxStorage = process.env.MAX_STORAGE_MB;
  process.env.MAX_STORAGE_MB = '1024';

  const quotaId1 = 'upl_' + 'c'.repeat(32);
  const quotaId2 = 'upl_' + 'd'.repeat(32);
  const quotaFile1 = path.join(getDownloadsDir(), `${quotaId1}.m4a`);
  const quotaFile2 = path.join(getDownloadsDir(), `${quotaId2}.m4a`);

  try {
    // Create two sparse files totaling 300 MB - 1024 bytes for auth.owner
    const halfQuota = 150 * 1024 * 1024;
    fs.writeFileSync(quotaFile1, '');
    fs.truncateSync(quotaFile1, halfQuota);
    fs.writeFileSync(quotaFile2, '');
    fs.truncateSync(quotaFile2, halfQuota - 1024);

    storeMod.addUserUploadRecord({
      id: quotaId1,
      userId: auth.owner.id,
      filename: `${quotaId1}.m4a`,
      title: 'Pesado 1',
      artist: 'Owner',
      fileDeleted: false,
      createdAt: Date.now()
    });
    storeMod.addUserUploadRecord({
      id: quotaId2,
      userId: auth.owner.id,
      filename: `${quotaId2}.m4a`,
      title: 'Pesado 2',
      artist: 'Owner',
      fileDeleted: false,
      createdAt: Date.now()
    });

    const wavPath = path.join(fixturesDir, 'quota_probe.wav');
    generateSineAudioFile(wavPath);
    const wavBytes = fs.readFileSync(wavPath);
    assert.ok(wavBytes.length > 2048);

    // 1. Multipart upload by auth.owner exceeds 300 MB -> 413 with clear message
    const ownerForm = new FormData();
    ownerForm.append('file', new File([wavBytes], 'OverQuota.wav', { type: 'audio/wav' }));
    const blockedMulti = await uploadRoute.POST(
      new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { cookie: auth.ownerCookie },
        body: ownerForm
      })
    );
    assert.equal(blockedMulti.status, 413);
    const blockedBody = await blockedMulti.json();
    assert.match(blockedBody.error, /300 MB/);

    // 2. Chunked upload by auth.owner also rejected with 413
    const blockedChunk = await uploadRoute.POST(
      new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: {
          cookie: auth.ownerCookie,
          'x-upload-mode': 'chunk',
          'x-chunk-index': '0',
          'x-total-chunks': '1',
          'x-total-size': String(wavBytes.length),
          'x-file-name': encodeURIComponent('OverQuotaChunk.wav')
        },
        body: wavBytes
      })
    );
    assert.equal(blockedChunk.status, 413);

    // 3. Another user (auth.other) is unaffected by auth.owner's quota -> 200
    const otherForm = new FormData();
    otherForm.append('file', new File([wavBytes], 'OtherUserSong.wav', { type: 'audio/wav' }));
    const otherRes = await uploadRoute.POST(
      new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { cookie: auth.otherCookie },
        body: otherForm
      })
    );
    assert.equal(otherRes.status, 200);

    // 4. Deleting one of auth.owner's pending VPS files frees quota -> upload now succeeds (200)
    const delRes = await uploadDeleteRoute.DELETE(
      new Request(`http://localhost/api/upload/${quotaId1}`, {
        method: 'DELETE',
        headers: { cookie: auth.ownerCookie }
      }),
      { params: Promise.resolve({ id: quotaId1 }) }
    );
    assert.equal(delRes.status, 200);

    const retryForm = new FormData();
    retryForm.append('file', new File([wavBytes], 'AfterFreeingSpace.wav', { type: 'audio/wav' }));
    const retryRes = await uploadRoute.POST(
      new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { cookie: auth.ownerCookie },
        body: retryForm
      })
    );
    assert.equal(retryRes.status, 200);
  } finally {
    if (prevMaxStorage === undefined) delete process.env.MAX_STORAGE_MB;
    else process.env.MAX_STORAGE_MB = prevMaxStorage;
    try {
      if (fs.existsSync(quotaFile1)) fs.unlinkSync(quotaFile1);
      if (fs.existsSync(quotaFile2)) fs.unlinkSync(quotaFile2);
    } catch {}
  }
});
