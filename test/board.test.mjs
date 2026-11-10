// The soundboard: its resonances, its responses, and what the keyboard sounds like through it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plateModes, buildBoard, BOARD, chainGain } from '../js/board/model.js';
import { facts, vFor } from '../tools/notes.mjs';
import { FS, aLevel, cachedBoard, heardNote } from './util.mjs';

test('the board resonates where a concert grand\'s does, as densely as measured boards', () => {
  const modes = plateModes();
  // Conklin (1996): 49, 67 and 89 Hz
  for (const [i, want] of [[0, 49], [1, 67], [3, 89]]) assert.ok(Math.abs(modes[i].f - want) < 8, `resonance ${i + 1}: ${modes[i].f.toFixed(0)} Hz, measured ${want}`);
  // stiffness / mass of 70 to 100 m⁴/s² on 2.1 m²: a resonance every 8 to 10 Hz
  const n = modes.filter((m) => m.f > 200 && m.f < 1000).length / 800;
  assert.ok(n > 0.08 && n < 0.13, `${n.toFixed(3)} resonances per Hz`);
  const r = Math.sqrt(BOARD.Dx * BOARD.Dy) / BOARD.mass;
  assert.ok(r > 70 && r < 100, `stiffness / mass ${r.toFixed(0)} m⁴/s²`);
});

test('twelve responses, finite, built in a few seconds', () => {
  const t0 = performance.now(), b = buildBoard(FS), secs = (performance.now() - t0) / 1000;
  assert.equal(b.irs.length, 12);
  let peak = 0;
  for (const h of b.irs) for (let i = 0; i < h.length; i++) { assert.ok(Number.isFinite(h[i])); peak = Math.max(peak, Math.abs(h[i])); }
  assert.ok(Math.abs(peak - 1) < 1e-6, `peak ${peak}`);
  // measured alone: about 1 s
  assert.ok(secs < 6, `built in ${secs.toFixed(1)} s`);
  // the two microphones do not hear the same
  const d = b.irs[0].reduce((s, v, i) => s + (v - b.irs[1][i]) ** 2, 0) / b.irs[0].reduce((s, v) => s + v * v, 0);
  assert.ok(d > 0.01, `left and right differ by ${(10 * Math.log10(d)).toFixed(0)} dB`);
});

test('the microphone chain is a named table, read on a logarithmic scale', () => {
  assert.equal(chainGain(10), -24);
  assert.equal(chainGain(20000), -33);
  assert.ok(Math.abs(chainGain(Math.sqrt(500 * 800)) - 2) < 1e-9);
  assert.equal(chainGain(1000, []), 0);
});

test('through the board no key stands far out from its neighbours', () => {
  cachedBoard();
  const lv = [];
  for (let m = 36; m <= 96; m++) lv.push(aLevel(heardNote(m, 0.5, 0.5), 480, 16384));
  const step = lv.slice(1).map((x, i) => Math.abs(x - lv[i])), mean = step.reduce((a, b) => a + b, 0) / step.length;
  // with the resonances at their measured sharpness, and added with their true delays: 4.5 dB and 23 dB
  assert.ok(mean < 2.5, `neighbouring keys differ by ${mean.toFixed(1)} dB on average`);
  assert.ok(Math.max(...step) < 9, `and by ${Math.max(...step).toFixed(1)} dB at most`);
});

test('the loud notes are balanced along the keyboard as recorded', () => {
  // level of the ff notes of a Steinway B against its C4 (University of Iowa; 2026-11-10)
  const RECORDED = { 24: -5.6, 36: -6.4, 48: -2.2, 72: 1.9, 84: -6.3, 96: -8.9, 108: -21.6 };
  const level = (m) => facts(heardNote(m, vFor(4), 3), m, false).level, c4 = level(60);
  for (const m of Object.keys(RECORDED).map(Number)) {
    const got = level(m) - c4;
    assert.ok(Math.abs(got - RECORDED[m]) < 3, `key ${m}: ${got.toFixed(1)} dB against C4, recorded ${RECORDED[m]}`);
  }
});
