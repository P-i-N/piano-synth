// The player: who plays each note (which hand, which finger) and how a person would play
// the written notes. The counterpart of vibetar's fretting hand (js/hand.js) and performer
// (in js/song.js there); the sizes of drift, phrase and ending are the ones found there.
//
//   * two hands: each takes the notes near where it is; one hand spans a ninth
//   * five fingers: in a chord by pitch, in a line by where the note lies under the hand;
//     the fourth and the fifth finger are weaker
//   * a chord too wide for the hand is rolled, from the bottom
//   * legato: in a line, a finger leaves its key a moment after the next one is down
//   * the foot: the pedal goes down a moment after the keys it is meant to catch
// and, scaled by Humanize:
//   * timing and loudness drift slowly, with a little scatter from note to note
//   * a phrase of four bars moves on towards its middle, eases off towards its end, and swells
//   * the melody (the top note) is brought out, and comes a little before the notes under it
//   * the song slows down and softens into its last note, unless it is looped
// With Humanize switched off none of this is used: the notes are played exactly as written.

import { PPQ, barTicks, tickSecs } from './song.js';

export const SPAN = 14;                                   // semitones one hand reaches: a ninth
export const FINGER_STRENGTH = [0, 1, 1, 1, 0.94, 0.88];  // by finger, 1 thumb .. 5 little finger
const ROLL = 0.04;                                        // seconds between the notes of a rolled chord
const LEGATO = 0.03;                                      // seconds a finger stays down after the next note
const FOOT = 0.07;                                        // seconds the pedal goes down after the keys
const PULL_T = 0.05, PULL = 0.08;                         // how strongly the drift returns: timing; loudness
const TIMING = 0.011, LOUDNESS = 0.1;                     // spread (standard deviation) of the drift at Humanize 100 %
const JITTER_T = 0.008, JITTER_V = 0.2;                   // note-to-note scatter (full width): seconds, relative loudness
const PHRASE_BARS = 4;
const BREATH = 0.004;                                     // a phrase runs ahead of the beat by up to this share of its length
const ARC = 0.12;                                         // and swells by this much
const RITARD = 0.07, SOFTEN = 0.15;                       // the last bar is late by up to this share of a bar, and softer
const MELODY = 0.12, INNER = 0.06;                        // the top note louder, the notes between top and bass softer
const LEAD = 0.012;                                       // seconds the melody comes before the notes under it

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clampTo = (x, lim) => Math.max(-lim, Math.min(lim, x));

// Notes that start together (within a 64th note), in order of time: [[note index, ...], ...],
// each group sorted from the lowest key up.
export function onsets(notes) {
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].t - notes[b].t || notes[a].m - notes[b].m), out = [];
  for (const i of order) {
    const g = out[out.length - 1];
    if (g && notes[i].t - notes[g[0]].t < PPQ / 16) g.push(i); else out.push([i]);
  }
  for (const g of out) g.sort((a, b) => notes[a].m - notes[b].m);
  return out;
}

// The hands' plan: for every note { hand: 0 left | 1 right, finger: 1..5, roll: place in a
// rolled chord (0: not rolled, or its lowest note) }.
export function planHands(notes) {
  const plan = notes.map(() => ({ hand: 1, finger: 3, roll: 0 }));
  const at = [43, 72];           // where each hand is: the key under its middle finger
  for (const g of onsets(notes)) {
    const ms = g.map((i) => notes[i].m), n = g.length;
    // the lowest k notes go to the left hand: the split that moves and stretches the hands least
    let best = 0, cost = Infinity;
    for (let k = 0; k <= n; k++) {
      let c = 0;
      for (let j = 0; j < n; j++) c += Math.abs(ms[j] - at[j < k ? 0 : 1]);
      const over = (lo, hi) => (hi > lo ? Math.max(0, ms[hi - 1] - ms[lo] - SPAN) * 6 + Math.max(0, hi - lo - 5) * 40 : 0);
      c += over(0, k) + over(k, n);
      if (c < cost) { cost = c; best = k; }
    }
    for (const [hand, lo, hi] of [[0, 0, best], [1, best, n]]) {
      const cnt = hi - lo;
      if (!cnt) continue;
      const wide = ms[hi - 1] - ms[lo] > SPAN;
      for (let j = lo; j < hi; j++) {
        const p = plan[g[j]];
        p.hand = hand;
        // place among the hand's notes, 0 lowest .. 1 highest; a single note: where it lies under the hand
        const place = cnt > 1 ? (j - lo) / (cnt - 1) : Math.max(0, Math.min(1, (ms[j] - at[hand] + 6) / 12));
        // the right hand's thumb is at the bottom, the left hand's at the top
        p.finger = 1 + Math.round(4 * (hand ? place : 1 - place));
        p.roll = wide ? j - lo : 0;
      }
      // the hand follows its notes
      at[hand] += 0.5 * ((ms[lo] + ms[hi - 1]) / 2 - at[hand]);
    }
  }
  return plan;
}

// What the keys and the pedal do when a person plays the song: the same list as compile()
// in song.js gives ({ tick, type, m, v }, in order), with ticks that are no longer whole.
// opts: { seed, loop: the song is played round and round (no slowing at its end), human: 0..1 }
export function perform(song, opts = {}) {
  const rnd = mulberry32(opts.seed == null ? 1 : opts.seed), h = opts.human == null ? 1 : opts.human;
  const notes = song.notes, plan = planHands(notes), groups = onsets(notes);
  const secs = tickSecs(song), bar = barTicks(song), phrase = PHRASE_BARS * bar;
  const g3 = () => (rnd() + rnd() + rnd() - 1.5) * 2;     // roughly standard normal
  const spread = (sd, pull) => sd * Math.sqrt(1 - (1 - pull) ** 2);
  const lastOnset = groups.length ? notes[groups[groups.length - 1][0]].t : 0;
  const on = new Float64Array(notes.length), off = new Float64Array(notes.length), vel = new Float64Array(notes.length);
  let dt = 0, dv = 0;
  for (const g of groups) {
    const t = notes[g[0]].t;
    dt = clampTo(dt * (1 - PULL_T) + spread(TIMING, PULL_T) * g3(), 0.025);
    dv = clampTo(dv * (1 - PULL) + spread(LOUDNESS, PULL) * g3(), 0.22);
    // where the group is in its phrase (0 .. 1) and in the last bar before the end (0 .. 1)
    const u = (t % phrase) / phrase;
    const last1 = opts.loop || lastOnset < 2 * bar ? 0 : Math.min(1, Math.max(0, (t - lastOnset + bar) / bar));
    const lag = dt - BREATH * phrase * secs * Math.sin(Math.PI * u) + RITARD * bar * secs * last1 * last1;
    const swell = dv + ARC * (Math.sin(Math.PI * u) - 2 / Math.PI) - SOFTEN * last1;
    const top = g[g.length - 1], bass = g[0];
    for (const i of g) {
      const n = notes[i], p = plan[i];
      let late = h * (lag + (rnd() - 0.5) * JITTER_T) + p.roll * ROLL;
      let v = (n.v / 127) * (1 + h * (swell + (rnd() - 0.5) * JITTER_V)) * (1 - h * (1 - FINGER_STRENGTH[p.finger]));
      if (g.length > 1) {
        if (i === top) { v *= 1 + MELODY * h; late -= LEAD * h; }
        else if (i !== bass) v *= 1 - INNER * h;
      }
      on[i] = Math.max(0, n.t + late / secs);
      off[i] = Math.max(on[i] + 1, n.t + n.d + late / secs);
      vel[i] = Math.max(0.02, Math.min(1, v));
    }
  }
  // legato: in a line, a note that ends where the next note of its hand begins is held a moment longer
  const byHand = [[], []];
  for (const g of groups) for (const hand of [0, 1]) { const mine = g.filter((i) => plan[i].hand === hand); if (mine.length) byHand[hand].push(mine); }
  for (const list of byHand) for (let k = 0; k + 1 < list.length; k++) {
    if (list[k].length !== 1 || list[k + 1].length !== 1) continue;
    const a = list[k][0], b = list[k + 1][0];
    if (notes[a].m !== notes[b].m && Math.abs(notes[a].t + notes[a].d - notes[b].t) < PPQ / 16) off[a] = Math.max(off[a], on[b] + LEGATO / secs);
  }
  // a key comes up before it is struck again
  const lastOf = new Map();
  for (const g of groups) for (const i of g) {
    const prev = lastOf.get(notes[i].m);
    if (prev != null && off[prev] > on[i] - 1) off[prev] = Math.max(on[prev] + 1, on[i] - 1);
    lastOf.set(notes[i].m, i);
  }
  const out = [];
  for (let i = 0; i < notes.length; i++) out.push({ tick: on[i], type: 'n', m: notes[i].m, v: vel[i] }, { tick: off[i], type: 'o', m: notes[i].m });
  // the foot: down a moment after the keys that start there, so that it catches them and not the notes before
  const starts = new Set(notes.map((n) => n.t));
  for (const [s, e] of song.pedal) {
    const down = starts.has(s) ? Math.min(s + FOOT / secs, e - 1) : s;
    out.push({ tick: down, type: 'p', v: 1 }, { tick: e, type: 'p', v: 0 });
  }
  const ORDER = { o: 0, p: 1, n: 2 };
  return out.sort((a, b) => a.tick - b.tick || ORDER[a.type] - ORDER[b.type]);
}
