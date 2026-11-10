// The tone of whole pieces against a studio recording of a grand piano.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMOS } from '../js/demos.js';
import { heardSong } from '../tools/song.mjs';
import { ltas, BANDS } from '../tools/ltas.mjs';

// Long-term third-octave spectrum of a recording (Bach, Goldberg Variations, variation 22,
// Kimiko Ishizaka on a Bösendorfer 290, CC0; `node tools/ltas.mjs`, 2026-11-10), 99 Hz to
// 8 kHz, each band against the mean of 200 Hz to 1 kHz.
const RECORDED = [-15.6, -7.8, -4.1, -3.1, -0.6, 0.4, 4.0, 1.3, 2.0, 1.2, -5.1, -8.5, -9.7, -15.4, -20.0, -25.1, -29.7, -38.9, -51.2, -58.3];
const FROM = BANDS.findIndex((f) => Math.abs(f - 99) < 2);
const level = (b) => { let s = 0, n = 0; BANDS.forEach((f, i) => { if (f > 190 && f < 1050) { s += b[i]; n++; } }); return b.map((x) => x - s / n); };

test('six demos together have the tone of a recorded grand: not thin, not nasal, not dull', () => {
  // the first 25 seconds of each, as the microphones hear them (no reverb)
  const each = ['Nocturne', 'Prelude', 'Elise', 'Gymnop', 'Canon', 'Minuet'].map((n) => level(ltas(heardSong(DEMOS.find((d) => d.name.includes(n)).make(), 25)).bands));
  const mean = level(BANDS.map((_, i) => 10 * Math.log10(each.reduce((s, c) => s + Math.pow(10, c[i] / 10), 0) / each.length)));
  let sum = 0;
  const lines = [];
  RECORDED.forEach((want, k) => {
    const f = BANDS[FROM + k], d = mean[FROM + k] - want;
    sum += Math.abs(d);
    lines.push(`${f.toFixed(0)} Hz ${d > 0 ? '+' : ''}${d.toFixed(1)}`);
    // other music than the recording's: a band may differ by what the pieces play
    assert.ok(Math.abs(d) < 8, `${f.toFixed(0)} Hz: ${d.toFixed(1)} dB from the recording (${lines.join(', ')})`);
  });
  assert.ok(sum / RECORDED.length < 3.5, `${(sum / RECORDED.length).toFixed(1)} dB from the recording on average: ${lines.join(', ')}`);
});

// ---- stereo ---------------------------------------------------------------------------
import { width, OCTAVES } from '../tools/width.mjs';
import { perform } from '../js/player.js';
import { eventsBetween, tickSecs } from '../js/song.js';
import { engine, throughBoard } from './util.mjs';

test('the two microphones do not hear the same: a piano as wide as a recorded one, not a point', () => {
  // Difference of the channels against their sum, by octave from 63 Hz to 8 kHz, in the
  // recording above. With the same response in both microphones but for its size the model
  // had -20 to -25 dB everywhere: a point between the speakers.
  const RECORDED_WIDTH = [-17.3, -7.5, -4.7, -2.5, -0.7, -1.3, -1.6, -0.4];
  const s = DEMOS[0].make(), e = engine();
  for (const ev of eventsBetween(s, perform(s, { seed: 1 }), 0, 20 / tickSecs(s), 0.05)) e.post(ev);
  const { L, R } = throughBoard(e, 20), w = width(L, R);
  OCTAVES.forEach((f, k) => {
    // from 500 Hz up as wide as the recording, within 6 dB
    if (f >= 500) assert.ok(Math.abs(w[k] - RECORDED_WIDTH[k]) < 6, `${f} Hz: ${w[k].toFixed(1)} dB, recorded ${RECORDED_WIDTH[k]}`);
    // the lows stay in the middle: the channels can be added without losing the bass
    else if (f <= 125) assert.ok(w[k] < -6, `${f} Hz: ${w[k].toFixed(1)} dB`);
  });
});
