// The player: hands, fingers, and what Humanize does to the written notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/song.js';
import { planHands, perform, SPAN, FINGER_STRENGTH } from '../js/player.js';

const Q = S.PPQ;
function song(notes, more = {}) { const s = S.newSong(); s.notes = notes.map(([t, d, m, v = 80]) => ({ t, d, m, v })); S.sortNotes(s); return Object.assign(s, more); }
// a melody in quarters over a bass in halves, 16 bars at 100 bpm
function tune(bars = 16) {
  const n = [];
  for (let b = 0; b < bars; b++) for (let q = 0; q < 4; q++) {
    n.push([(4 * b + q) * Q, Q, 72 + ((b + q) % 5) * 2]);
    if (q % 2 === 0) n.push([(4 * b + q) * Q, 2 * Q, 41 + (b % 3) * 2]);
  }
  return song(n);
}
const ms = (s, ticks) => ticks * S.tickSecs(s) * 1000;
const ons = (list) => list.filter((e) => e.type === 'n');

test('two hands: the bass to the left, the melody to the right; a hand spans a ninth', () => {
  const s = tune(4), plan = planHands(s.notes);
  s.notes.forEach((n, i) => assert.equal(plan[i].hand, n.m < 60 ? 0 : 1, `key ${n.m}`));
  // a chord of ten notes: five to each hand
  const c = song([36, 40, 43, 48, 52, 60, 64, 67, 72, 76].map((m) => [0, Q, m])), p = planHands(c.notes);
  assert.deepEqual(p.map((x) => x.hand), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  for (const hand of [0, 1]) { const mine = c.notes.filter((_, i) => p[i].hand === hand).map((n) => n.m); assert.ok(Math.max(...mine) - Math.min(...mine) <= 16); }
});

test('five fingers: thumbs towards the middle, the little fingers outside', () => {
  const c = song([36, 40, 43, 48, 52, 60, 64, 67, 72, 76].map((m) => [0, Q, m])), p = planHands(c.notes);
  assert.deepEqual(p.map((x) => x.finger), [5, 4, 3, 2, 1, 1, 2, 3, 4, 5]);
  assert.ok(FINGER_STRENGTH[4] < 1 && FINGER_STRENGTH[5] < FINGER_STRENGTH[4]);
});

test('the fourth and fifth fingers play softer', () => {
  // the same five-note chord many times: mean loudness by finger
  const n = [];
  for (let k = 0; k < 200; k++) for (const m of [60, 62, 64, 65, 67]) n.push([k * Q, Q / 2, m]);
  const s = song(n), list = ons(perform(s, { seed: 3 })), by = {};
  for (const e of list) (by[e.m] = by[e.m] || []).push(e.v);
  const mean = (m) => by[m].reduce((a, b) => a + b, 0) / by[m].length;
  // (the top note is also the melody, which is brought out: compare the inner fingers)
  assert.ok(mean(65) < 0.97 * mean(62), `fourth finger ${mean(65).toFixed(3)}, second ${mean(62).toFixed(3)}`);
});

test('a chord too wide for one hand is rolled from the bottom', () => {
  // the right hand is busy high up: the left has to take a tenth and more
  const wide = [36, 43, 36 + SPAN + 3], high = [72, 76, 79];
  const s = song([...wide, ...high].map((m) => [0, Q, m])), list = ons(perform(s, { seed: 1, human: 0 }));
  const at = (m) => list.find((e) => e.m === m).tick;
  const gaps = [ms(s, at(wide[1]) - at(wide[0])), ms(s, at(wide[2]) - at(wide[1]))];
  for (const g of gaps) assert.ok(g > 25 && g < 60, `${g.toFixed(0)} ms between the notes`);
  // the right hand's chord is within reach: together
  assert.ok(ms(s, at(79) - at(72)) < 1);
  // with the right hand free, it takes the top note and nothing is rolled
  const t = song(wide.map((m) => [0, Q, m])), free = ons(perform(t, { seed: 1, human: 0 }));
  assert.ok(ms(t, free[2].tick - free[0].tick) < 1);
});

test('legato: in a line a finger leaves its key a moment after the next one is down', () => {
  const s = song([[0, Q, 60], [Q, Q, 62], [2 * Q, Q, 64], [4 * Q, Q, 65]]), list = perform(s, { seed: 1, human: 0 });
  const up = (m) => list.find((e) => e.type === 'o' && e.m === m).tick, down = (m) => list.find((e) => e.type === 'n' && e.m === m).tick;
  for (const [a, b] of [[60, 62], [62, 64]]) { const o = ms(s, up(a) - down(b)); assert.ok(o > 15 && o < 50, `${a} overlaps ${b} by ${o.toFixed(0)} ms`); }
  // before a rest the note ends where it is written
  assert.ok(Math.abs(up(64) - 3 * Q) < 1);
});

test('the foot: the pedal goes down a moment after the keys it catches', () => {
  const s = song([[0, Q, 60], [2 * Q, Q, 64]], { pedal: [[2 * Q, 4 * Q]] }), list = perform(s, { seed: 1, human: 0 });
  const p = list.filter((e) => e.type === 'p'), late = ms(s, p[0].tick - 2 * Q);
  assert.ok(late > 40 && late < 100, `${late.toFixed(0)} ms after the keys`);
  assert.equal(p[1].tick, 4 * Q);
});

test('Humanize at 100 %: timing drifts by about 11 ms, loudness by about 10 %', () => {
  const s = tune(64), list = ons(perform(s, { seed: 5 })), bass = list.filter((e) => e.m < 60);
  // the bass notes, written every half note, far from the last bar
  const dev = bass.slice(4, -8).map((e) => ms(s, e.tick - Math.round(e.tick / (2 * Q)) * 2 * Q));
  const mean = dev.reduce((a, b) => a + b, 0) / dev.length, sd = Math.sqrt(dev.reduce((a, b) => a + (b - mean) ** 2, 0) / dev.length);
  assert.ok(sd > 6 && sd < 18, `timing spread ${sd.toFixed(1)} ms`);
  const v = bass.map((e) => e.v / (80 / 127)), vm = v.reduce((a, b) => a + b, 0) / v.length, vsd = Math.sqrt(v.reduce((a, b) => a + (b - vm) ** 2, 0) / v.length);
  assert.ok(vsd > 0.06 && vsd < 0.2, `loudness spread ${(100 * vsd).toFixed(0)} %`);
});

test('the melody is brought out, and comes a little before the bass', () => {
  const s = tune(64), list = ons(perform(s, { seed: 7 }));
  const pairs = [];
  for (let t = 0; t < 60 * 4 * Q; t += 2 * Q) {
    const near = list.filter((e) => Math.abs(e.tick - t) < Q / 4);
    const top = near.find((e) => e.m >= 60), low = near.find((e) => e.m < 60);
    if (top && low) pairs.push([top, low]);
  }
  const louder = pairs.reduce((a, [t, l]) => a + t.v / l.v, 0) / pairs.length, ahead = pairs.reduce((a, [t, l]) => a + ms(s, l.tick - t.tick), 0) / pairs.length;
  assert.ok(louder > 1.05 && louder < 1.3, `the melody is ${(100 * (louder - 1)).toFixed(0)} % louder`);
  assert.ok(ahead > 6 && ahead < 20, `and ${ahead.toFixed(1)} ms ahead`);
});

test('the song slows down and softens into its last note, unless it is looped', () => {
  const s = tune(16), end = s.notes[s.notes.length - 1].t, bar = S.barTicks(s);
  const lastLate = (opts) => { let sum = 0; for (let seed = 1; seed <= 20; seed++) { const l = ons(perform(s, { seed, ...opts })); sum += l[l.length - 1].tick - end; } return sum / 20 / bar; };
  const late = lastLate({}), looped = lastLate({ loop: true });
  assert.ok(late > 0.04 && late < 0.1, `the last note is ${(100 * late).toFixed(1)} % of a bar late`);
  assert.ok(Math.abs(looped) < 0.02, `looped: ${(100 * looped).toFixed(1)} %`);
});

test('what comes out can be played: in order, every key comes up, and before it is struck again', () => {
  const n = [];
  for (let k = 0; k < 300; k++) n.push([k * 60, 200, 48 + (k * 7) % 30, 40 + (k * 13) % 80]);
  const s = song(n, { pedal: [[0, 4 * Q], [5 * Q, 9 * Q]] }), list = perform(s, { seed: 9 });
  for (let i = 1; i < list.length; i++) assert.ok(list[i].tick >= list[i - 1].tick);
  const down = new Map();
  for (const e of list) {
    assert.ok(e.tick >= 0 && Number.isFinite(e.tick));
    if (e.type === 'n') { assert.ok(!down.get(e.m), `key ${e.m} struck while down at ${e.tick}`); assert.ok(e.v > 0 && e.v <= 1); down.set(e.m, true); }
    else if (e.type === 'o') down.set(e.m, false);
  }
  assert.ok([...down.values()].every((d) => !d));
  // the same seed gives the same performance
  assert.deepEqual(perform(s, { seed: 9 }), list);
});

test('Humanize is on at 100 % in a new song, and survives the link; old links get it too', async () => {
  const s = S.newSong();
  assert.equal(S.humanOf(s.inst), 1);
  s.inst.human = 0.4; s.inst.humanOn = 0;
  const back = await S.decodeSong(await S.encodeSong(s));
  assert.equal(back.inst.human, 0.4); assert.equal(S.humanOf(back.inst), 0);
  assert.equal(S.humanOf(S.unpackSong({ i: [0.5] }).inst), 1);
});
