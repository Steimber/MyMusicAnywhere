import test from 'node:test';
import assert from 'node:assert/strict';

import {
  wrap01,
  createArtistKeyResolver,
  getShuffleTrackKey,
  buildSmartShuffleOrder
} from '../lib/shuffle.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertIsValidPermutation(order, expectedLength) {
  assert.equal(order.length, expectedLength);
  const sorted = [...order].sort((a, b) => a - b);
  for (let i = 0; i < expectedLength; i++) {
    assert.equal(sorted[i], i, `Missing or duplicate index at ${i}`);
  }
}

test('shuffle: wrap01 wraps negative and >1 numbers into [0, 1)', () => {
  assert.ok(wrap01(-0.05) >= 0 && wrap01(-0.05) < 1);
  assert.ok(Math.abs(wrap01(-0.05) - 0.95) < 1e-9);
  assert.ok(Math.abs(wrap01(1.25) - 0.25) < 1e-9);
  assert.equal(wrap01(0), 0);
});

test('shuffle: always returns a valid permutation and preserves startIdx at order[0]', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({
    id: `t_${i}`,
    title: `Track ${i}`,
    artist: `Artist ${i % 6}`
  }));

  for (let startIdx = 0; startIdx < list.length; startIdx += 5) {
    const rng = mulberry32(1000 + startIdx);
    const order = buildSmartShuffleOrder(list, { startIdx, rng });
    assertIsValidPermutation(order, list.length);
    assert.equal(order[0], startIdx);
  }
});

test('shuffle: 3 artists x 10 songs produces 0 adjacent same-artist repeats across 200 seeds', () => {
  const artists = ['Soda Stereo', 'Gustavo Cerati', 'Charly García'];
  const list = [];
  for (const artist of artists) {
    for (let i = 0; i < 10; i++) {
      list.push({
        id: `${artist}_${i}`,
        title: `Song ${i}`,
        artist
      });
    }
  }

  const getKey = createArtistKeyResolver(list);

  for (let seed = 1; seed <= 200; seed++) {
    const rng = mulberry32(seed * 7919);
    const order = buildSmartShuffleOrder(list, { startIdx: -1, rng });
    assertIsValidPermutation(order, 30);

    for (let i = 1; i < order.length; i++) {
      const prevArtist = getKey(order[i - 1]);
      const curArtist = getKey(order[i]);
      assert.notEqual(
        curArtist,
        prevArtist,
        `Seed ${seed} had adjacent artist "${curArtist}" at positions ${i - 1} and ${i}`
      );
    }
  }
});

test('shuffle: dominant artist (20 of 25 songs) terminates quickly and returns valid permutation', () => {
  const list = [];
  for (let i = 0; i < 20; i++) {
    list.push({ id: `dom_${i}`, title: `Hit ${i}`, artist: 'Bad Bunny' });
  }
  for (let i = 0; i < 5; i++) {
    list.push({ id: `other_${i}`, title: `Other ${i}`, artist: `Indie ${i}` });
  }

  const rng = mulberry32(42);
  const startMs = Date.now();
  const order = buildSmartShuffleOrder(list, { startIdx: 3, rng });
  const elapsedMs = Date.now() - startMs;

  assert.ok(elapsedMs < 50, `Expected <50ms, took ${elapsedMs}ms`);
  assertIsValidPermutation(order, 25);
  assert.equal(order[0], 3);
});

test('shuffle: artist normalization preserves "Simon & Garfunkel", "Earth, Wind & Fire", and "Tyler, The Creator" while grouping collaborations', () => {
  const list = [
    { id: '1', title: 'The Sound of Silence', artist: 'Simon & Garfunkel' },
    { id: '2', title: 'Solo Track', artist: 'Simon' },
    { id: '3', title: 'September', artist: 'Earth, Wind & Fire' },
    { id: '4', title: 'Solo Earth', artist: 'Earth' },
    { id: '5', title: 'EARFQUAKE', artist: 'Tyler, The Creator' },
    { id: '6', title: 'Solo Tyler', artist: 'Tyler' },
    { id: '7', title: 'Monaco', artist: 'Bad Bunny' },
    { id: '8', title: 'Perro Negro', artist: 'Bad Bunny, Feid' },
    { id: '9', title: 'Dakiti', artist: 'Bad Bunny & Jhay Cortez' },
    { id: '10', title: 'La Canción', artist: 'Bad Bunny feat. J Balvin' }
  ];

  const getKey = createArtistKeyResolver(list);

  // "Simon & Garfunkel" must NOT merge with solo "Simon"
  assert.equal(getKey(0), 'simon & garfunkel');
  assert.equal(getKey(1), 'simon');
  assert.notEqual(getKey(0), getKey(1));

  // "Earth, Wind & Fire" must NOT merge with "Earth"
  assert.equal(getKey(2), 'earth, wind & fire');
  assert.notEqual(getKey(2), getKey(3));

  // "Tyler, The Creator" must NOT merge with "Tyler"
  assert.equal(getKey(4), 'tyler, the creator');
  assert.notEqual(getKey(4), getKey(5));

  // Collaborations with "Bad Bunny" (which exists standalone in the library) all group under "bad bunny"
  assert.equal(getKey(6), 'bad bunny');
  assert.equal(getKey(7), 'bad bunny');
  assert.equal(getKey(8), 'bad bunny');
  assert.equal(getKey(9), 'bad bunny');
});

test('shuffle: recentKeys cooldown keeps recently played tracks out of the first 5 positions on startRandom', () => {
  const list = Array.from({ length: 20 }, (_, i) => ({
    id: `song_${i}`,
    title: `Song ${i}`,
    artist: `Artist ${i % 5}`
  }));

  // Mark 8 songs as recently played
  const recentTracks = list.slice(0, 8);
  const recentKeys = new Set(recentTracks.map(t => getShuffleTrackKey(t)));
  const recentIds = new Set(recentTracks.map(t => t.id));

  for (let seed = 1; seed <= 50; seed++) {
    const rng = mulberry32(seed * 1337);
    const order = buildSmartShuffleOrder(list, {
      startIdx: -1,
      rng,
      recentKeys
    });
    assertIsValidPermutation(order, 20);

    for (let pos = 0; pos < 5; pos++) {
      const pickedTrack = list[order[pos]];
      assert.equal(
        recentIds.has(pickedTrack.id),
        false,
        `Seed ${seed}: expected position ${pos} (${pickedTrack.id}) not to be in recentIds`
      );
    }
  }
});
