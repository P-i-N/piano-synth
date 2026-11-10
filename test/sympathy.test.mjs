// Sympathetic resonance: strings that are not struck ring with the ones that are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PIANO, keyHz } from '../js/worklet.js';
import { FS, freqNear, db, rms, engine, render } from './util.mjs';

function withPiano(values, fn) {
  const keep = {};
  for (const k of Object.keys(values)) { keep[k] = PIANO[k]; PIANO[k] = values[k]; }
  try { return fn(); } finally { Object.assign(PIANO, keep); }
}
// a short loud note; pedal: [down at, up at] in seconds, or null
function staccato(m, pedal, secs) {
  const e = engine();
  if (pedal) { e.post({ type: 'p', t: pedal[0], v: 1 }); if (pedal[1]) e.post({ type: 'p', t: pedal[1], v: 0 }); }
  e.post({ type: 'n', t: 0.05, m, v: 0.9 });
  e.post({ type: 'o', t: 0.25, m });
  return render(e, secs);
}
const diff = (a, b) => a.map((x, i) => x - b[i]);

test('with the pedal down, the other strings ring along: quieter than the note, and for long', () => {
  const on = staccato(60, [0, 0], 4), off = withPiano({ sympathy: 0 }, () => staccato(60, [0, 0], 4));
  const extra = diff(on, off);
  const ratio = db(rms(extra, 0.5, 1.5)) - db(rms(on, 0.05, 0.25));
  assert.ok(ratio > -45 && ratio < -12, `the other strings, 0.5 to 1.5 s: ${ratio.toFixed(1)} dB against the note`);
  const fall = db(rms(extra, 0.5, 1.5)) - db(rms(extra, 2.5, 3.5));
  assert.ok(fall < 20, `they fall by ${fall.toFixed(1)} dB in two seconds`);
});

test('without the pedal the damped strings stay silent; the top strings, which have no dampers, ring', () => {
  // C6, let go: its second partial is where C7 sounds, and C7 has no damper
  const on = staccato(84, null, 2), off = withPiano({ sympathy: 0 }, () => staccato(84, null, 2));
  const f = keyHz(96), a = freqNear(on, f, 1, 0.5, 0.02).mag, b = freqNear(off, f, 1, 0.5, 0.02).mag;
  assert.ok(db(a / b) > 20, `at C7's pitch, a second after C6 was let go: ${db(a / b).toFixed(1)} dB more with the top strings`);
  // C2, let go: nothing low rings on
  const lo = staccato(36, null, 2), lo0 = withPiano({ sympathy: 0 }, () => staccato(36, null, 2));
  const extra = diff(lo, lo0), low = db(freqNear(extra, keyHz(24) * 2, 1, 0.5, 0.05).mag + 1e-30) - db(freqNear(lo, keyHz(36), 0.06, 0.2, 0.05).mag);
  assert.ok(low < -60, `bass strings after C2 without pedal: ${low.toFixed(0)} dB against the note`);
});

test('the strings stop ringing along when the pedal comes up', () => {
  const on = staccato(60, [0, 1.5], 3), off = withPiano({ sympathy: 0 }, () => staccato(60, [0, 1.5], 3));
  const extra = diff(on, off), drop = db(rms(extra, 1, 1.4)) - db(rms(extra, 2.2, 2.6));
  assert.ok(drop > 30, `0.7 s after the pedal came up: ${drop.toFixed(1)} dB down`);
});
