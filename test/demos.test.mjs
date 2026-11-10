// The demo songs: each is a playable song, and the known pieces have their notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/song.js';
import { DEMOS, key, voice } from '../js/demos.js';
import { perform } from '../js/player.js';
import { engine, render, peak } from './util.mjs';

const names = (notes) => notes.map((n) => n.m);

test('the notation: names, lengths, chords, rests, ties, loudness', () => {
  assert.deepEqual(['c4', 'a0', 'c8', 'f#3', 'bb5'].map(key), [60, 21, 108, 54, 82]);
  const v = voice('v50 c4:4 [e4 g4]:8 r:8 | v90 a4:2.+4 b4:8t', { t0: 480 });
  assert.deepEqual(v, [{ t: 480, d: 480, m: 60, v: 50 }, { t: 960, d: 240, m: 64, v: 50 }, { t: 960, d: 240, m: 67, v: 50 }, { t: 1440, d: 1920, m: 69, v: 90 }, { t: 3360, d: 160, m: 71, v: 90 }]);
  assert.throws(() => voice('h4:4'));
});

test('about a dozen demos, each with a name and one line about what it shows', () => {
  assert.ok(DEMOS.length >= 10 && DEMOS.length <= 14, `${DEMOS.length} demos`);
  for (const d of DEMOS) { assert.ok(d.name && d.about && !d.about.includes('\n') && d.about.length < 130, d.name); }
  assert.equal(new Set(DEMOS.map((d) => d.name)).size, DEMOS.length);
});

test('every demo is a playable song: on the keys, no key struck while it is held, in the room, humanized', async () => {
  for (const d of DEMOS) {
    const s = d.make();
    assert.ok(s.notes.length > 5, d.name);
    const held = new Map();
    for (const n of s.notes) {
      assert.ok(n.m >= S.LO && n.m <= S.HI && n.v >= 1 && n.v <= 127 && n.d >= 1 && Number.isInteger(n.t), `${d.name}: ${JSON.stringify(n)}`);
      assert.ok(!(held.get(n.m) > n.t), `${d.name}: key ${n.m} struck at ${n.t} while held`);
      held.set(n.m, n.t + n.d);
    }
    assert.equal(S.reverbSpace(s.fx), 'room', d.name);
    assert.equal(S.humanOf(s.inst), 1, d.name);
    assert.deepEqual(await S.decodeSong(await S.encodeSong(s)), s, `${d.name} survives the link`);
    // its first seconds sound, and stay finite
    const e = engine();
    for (const ev of S.eventsBetween(s, perform(s, { seed: 1 }), 0, 6 / S.tickSecs(s), 0.05)) e.post(ev);
    const x = render(e, 6);
    assert.ok(Number.isFinite(peak(x)) && peak(x) > 0.001 && peak(x) < 2, `${d.name}: peak ${peak(x)}`);
  }
});

const demo = (name) => DEMOS.find((d) => d.name.includes(name)).make();

test('Bach\'s prelude: the first bar, the pattern of every bar, the bars that are known by heart', () => {
  const s = demo('Prelude'), bar = S.barTicks(s);
  const inBar = (b) => s.notes.filter((n) => n.t >= b * bar && n.t < (b + 1) * bar);
  // bar 1: C E G C E as 1 2 3 4 5 3 4 5, twice
  assert.deepEqual(names(inBar(0)), [60, 64, 67, 72, 76, 67, 72, 76, 60, 64, 67, 72, 76, 67, 72, 76]);
  const sets = [[60, 64, 67, 72, 76], [60, 62, 69, 74, 77], [59, 62, 67, 74, 77], [60, 64, 67, 72, 76], [60, 64, 69, 76, 81], [60, 62, 66, 69, 74], [59, 62, 67, 74, 79], [59, 60, 64, 67, 72], [57, 60, 64, 67, 72], [50, 57, 62, 66, 72], [55, 59, 62, 67, 71]];
  sets.forEach((want, b) => assert.deepEqual([...new Set(names(inBar(b)))].sort((x, y) => x - y), want, `bar ${b + 1}`));
  for (let b = 0; b < 19; b++) assert.equal(inBar(b).length, 16, `bar ${b + 1}`);
});

test('Für Elise: the right hand\'s first notes; the left hand\'s A minor and E major', () => {
  const s = demo('Elise'), rh = s.notes.filter((n) => n.m >= 60), lh = s.notes.filter((n) => n.m < 60);
  assert.deepEqual(names(rh).slice(0, 13), [76, 75, 76, 75, 76, 71, 74, 72, 69, 60, 64, 69, 71]);
  assert.deepEqual(names(lh).slice(0, 6), [45, 52, 57, 40, 52, 56]);
});

test('Gymnopédie: G and D in the bass, the major sevenths over them, the melody', () => {
  const s = demo('Gymnop');
  assert.deepEqual(names(s.notes.filter((n) => n.m < 45)).slice(0, 4), [43, 38, 43, 38]);
  assert.deepEqual(names(s.notes.filter((n) => n.t === S.PPQ)), [59, 62, 66]);
  assert.deepEqual(names(s.notes.filter((n) => n.t === 4 * S.PPQ)), [57, 61, 66]);
  assert.deepEqual(names(s.notes.filter((n) => n.m > 66 && n.v === 64)), [78, 81, 79, 78, 73, 71, 73, 74, 69]);
});

test('Minuet in G and Ode to Joy: the tunes', () => {
  const m = demo('Minuet'), top = m.notes.filter((n) => n.v >= 74);
  assert.deepEqual(names(top).slice(0, 11), [74, 67, 69, 71, 72, 74, 67, 67, 76, 72, 74]);
  const o = demo('Ode'), tune = o.notes.filter((n) => n.v === 56);
  assert.deepEqual(names(tune).slice(0, 15), [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62]);
});

test('the rolled tenths are wider than a hand, and the player rolls them', () => {
  const s = demo('Rolled'), list = perform(s, { seed: 1, human: 0 }).filter((e) => e.type === 'n');
  const first = list.filter((e) => e.tick < S.PPQ / 2 && e.m < 60).map((e) => e.tick);
  assert.equal(first.length, 3);
  assert.ok(first[2] - first[0] > 0.05 / S.tickSecs(s), 'the first left-hand chord is rolled');
});
