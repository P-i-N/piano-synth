// The song: the link format and what is sent to the engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/song.js';

function sample() {
  const s = S.newSong();
  s.title = 'Test'; s.bpm = 132; s.bpb = 3; s.grid = 6;
  s.notes = [{ t: 0, d: 480, m: 60, v: 80 }, { t: 0, d: 960, m: 64, v: 33 }, { t: 240, d: 100, m: 21, v: 1 }, { t: 5000, d: 7, m: 108, v: 127 }];
  s.pedal = [[0, 480], [960, 2000]];
  s.loop = [480, 1440];
  s.inst.hard = -0.4;
  S.setReverbSpace(s.fx, 'hall'); s.fx.dlyOn = true; s.fx.dlyTime = '8t'; s.fx.vol = 0.5;
  return s;
}

test('a song survives the link round trip', async () => {
  const s = sample(), link = await S.encodeSong(s);
  assert.match(link, /^[zj][A-Za-z0-9_-]+$/);
  assert.deepEqual(await S.decodeSong(link), s);
});

test('a link made with the first version of the format still loads', () => {
  // frozen: the packed form of a song as written on the first day. New settings go at the
  // end of `i` and `x`; these positions must keep their meaning.
  const packed = { v: 1, t: 'Old', b: 90, g: [4, 4], n: [0, 480, 60, 80, 480, 240, 62, 100], p: [0, 960], l: [0, 1920], i: [0.5], x: [1, 0.16, 0.6, 0.45, 0, '8d', 0.35, 0.22, 0.8] };
  const s = S.unpackSong(packed);
  assert.deepEqual(s.notes, [{ t: 0, d: 480, m: 60, v: 80 }, { t: 480, d: 240, m: 62, v: 100 }]);
  assert.deepEqual(s.pedal, [[0, 960]]);
  assert.deepEqual(s.loop, [0, 1920]);
  assert.equal(s.inst.hard, 0.5);
  assert.equal(S.reverbSpace(s.fx), 'room');
  assert.equal(s.bpm, 90);
});

test('a link with missing or broken parts gives a playable song', () => {
  const s = S.unpackSong({ n: [0, -5, 999, 300, 'x', 1, 2], p: [5, 5, 9], l: [4, 2], i: ['a'], x: [] });
  assert.deepEqual(s.notes, [{ t: 0, d: 1, m: 108, v: 127 }]);
  assert.deepEqual(s.pedal, []);
  assert.equal(s.loop, null);
  assert.equal(s.inst.hard, 0);
  assert.throws(() => S.unpackSong(null));
});

test('new songs play in the room', () => {
  assert.equal(S.reverbSpace(S.newSong().fx), 'room');
});

test('a few thousand notes fit in a link', async () => {
  const s = S.newSong();
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 5000; i++) s.notes.push({ t: i * 120, d: 120 * (1 + Math.floor(4 * rnd())), m: 36 + Math.floor(48 * rnd()), v: 40 + Math.floor(80 * rnd()) });
  const link = await S.encodeSong(s);
  assert.equal((await S.decodeSong(link)).notes.length, 5000);
  assert.ok(link.length < 40000, `${link.length} characters for 5000 random notes`);
});

test('the pedal lane: pressing joins, lifting cuts', () => {
  const s = S.newSong();
  S.setPedal(s, 0, 100, true); S.setPedal(s, 200, 300, true);
  assert.deepEqual(s.pedal, [[0, 100], [200, 300]]);
  S.setPedal(s, 50, 250, true);
  assert.deepEqual(s.pedal, [[0, 300]]);
  S.setPedal(s, 100, 150, false);
  assert.deepEqual(s.pedal, [[0, 100], [150, 300]]);
  assert.equal(S.pedalAt(s, 99), true);
  assert.equal(S.pedalAt(s, 100), false);
});

test('keys go down and up in order; a key struck again comes up first', () => {
  const s = S.newSong();
  s.notes = [{ t: 0, d: 960, m: 60, v: 127 }, { t: 480, d: 480, m: 60, v: 64 }, { t: 960, d: 480, m: 62, v: 64 }];
  s.pedal = [[960, 1440]];
  const list = S.compile(s).map((e) => `${e.tick}${e.type}${e.m ?? e.v}`);
  assert.deepEqual(list, ['0n60', '480o60', '480n60', '960o60', '960p1', '960n62', '1440o62', '1440p0']);
  assert.equal(S.compile(s)[0].v, 1);
});

test('events are sent in windows without losing or doubling any', () => {
  const s = sample(), list = S.compile(s), all = S.eventsBetween(s, list, 0, Infinity, 1);
  const parts = [];
  for (let a = 0; a < 6000; a += 137) parts.push(...S.eventsBetween(s, list, a, a + 137, 1 + a * S.tickSecs(s)));
  assert.equal(parts.length, all.length);
  parts.forEach((e, i) => { assert.equal(e.type, all[i].type); assert.ok(Math.abs(e.t - all[i].t) < 1e-9); });
  // tick 480 at 132 bpm is a quarter note after the start
  assert.ok(Math.abs(all.find((e) => e.type === 'o' && e.m === 60).t - (1 + 60 / 132)) < 1e-9);
});

test('a song is whole bars long, at least four', () => {
  const s = S.newSong();
  assert.equal(S.songTicks(s), 4 * 4 * S.PPQ);
  s.notes = [{ t: 8 * 4 * S.PPQ, d: 10, m: 60, v: 80 }];
  assert.equal(S.songTicks(s), 9 * 4 * S.PPQ);
  assert.equal(S.songEnd(s), 8 * 4 * S.PPQ + 10);
});
