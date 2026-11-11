// The string engine: tuning, the hammer, decay, dampers and the pedal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PIANO, STRETCH, inharmonicity, keyHz, hammerSpeed } from '../js/worklet.js';
import { modelNote, toneGain, modelCurve } from '../tools/notes.mjs';
import { FS, spectrum, bandEnergy, freqNear, db, cents, rms, peak, engine, render, note, decayRate } from './util.mjs';

// run with some PIANO values changed (they are read when an engine is built)
function withPiano(values, fn) {
  const keep = {};
  for (const k of Object.keys(values)) { keep[k] = PIANO[k]; PIANO[k] = values[k]; }
  try { return fn(); } finally { Object.assign(PIANO, keep); }
}
// level (dB) of the band above `from` Hz against the whole note, over its first third of a second
function highShare(x, from) {
  const n = 16384, m = spectrum(x, Math.floor(0.01 * FS), n);
  return 10 * Math.log10(bandEnergy(m, n, from, 20000) / bandEnergy(m, n, 20, 20000));
}

test('notes are in tune with the stretched scale; A4 is 440 Hz', () => {
  assert.ok(Math.abs(keyHz(69) - 440) < 1e-9);
  for (const m of [21, 36, 48, 60, 69, 72, 84, 96, 108]) {
    // strings in unison: exactly the pitch
    const x = withPiano({ detune: 0 }, () => note(m, 0.5, 1.5)), off = cents(freqNear(x, keyHz(m), 0.1, 1).f, keyHz(m));
    assert.ok(Math.abs(off) < (m > 90 ? 2 : 0.5), `key ${m}: ${off.toFixed(2)} cents off`);
    // as they are, up to 2 cents apart: the strongest of them is within 3 cents of it
    const y = note(m, 0.5, 1.5), spread = cents(freqNear(y, keyHz(m), 0.1, 1).f, keyHz(m));
    assert.ok(Math.abs(spread) < 3, `key ${m}, strings mistuned: ${spread.toFixed(2)} cents off`);
  }
});

test('the tuning is stretched: flat in the bass, sharp in the treble', () => {
  for (let m = 22; m <= 108; m++) assert.ok(STRETCH[m] >= STRETCH[m - 1], `key ${m}`);
  assert.ok(STRETCH[108] > 20 && STRETCH[108] < 40, `C8 ${STRETCH[108].toFixed(1)} cents`);
  assert.ok(STRETCH[21] < -5 && STRETCH[21] > -25, `A0 ${STRETCH[21].toFixed(1)} cents`);
});

test('the scale is the recorded piano\'s: stiffness of the strings and stretch of the tuning', () => {
  // A Steinway B (University of Iowa, mf and ff notes), from a fit to many partials of each
  // note, 2026-11-10: inharmonicity B, and the pitch in cents against C4.
  const B = { 24: 2.5e-4, 36: 1.4e-4, 48: 1.12e-4, 60: 3.2e-4, 72: 8.5e-4, 84: 24.7e-4 };
  for (const m of Object.keys(B).map(Number)) {
    const r = inharmonicity(m) / B[m];
    assert.ok(r > 0.8 && r < 1.25, `key ${m}: B ${inharmonicity(m).toExponential(2)}, recorded ${B[m].toExponential(2)}`);
  }
  const CENTS = { 24: -19.4, 36: -6.7, 48: -1.6, 72: 1.1, 84: 5.4, 96: 10.8 };
  for (const m of Object.keys(CENTS).map(Number)) {
    const got = STRETCH[m] - STRETCH[60];
    assert.ok(Math.abs(got - CENTS[m]) < 3, `key ${m}: ${got.toFixed(1)} cents from C4, recorded ${CENTS[m]}`);
  }
});

test('strings are as stiff as the scale says: partials are stretched', () => {
  // B from a few partials: f_k = k f1 sqrt((1 + B k²) / (1 + B))
  for (const [m, ks] of [[36, [12, 16, 20]], [48, [8, 12, 16]], [60, [6, 8, 10]], [72, [4, 5, 6]]]) {
    const x = withPiano({ detune: 0 }, () => note(m, 0.7, 1.2));
    const f1 = freqNear(x, keyHz(m), 0.05, 1).f, want = inharmonicity(m), Bs = [];
    for (const k of ks) {
      const fk = k * keyHz(m) * Math.sqrt((1 + want * k * k) / (1 + want));
      const r = freqNear(x, fk, 0.02, 0.3, 0.2 / k).f / (k * f1);
      Bs.push((r * r - 1) / (k * k - r * r));
    }
    const B = Bs.sort((a, b) => a - b)[1];
    assert.ok(B > 0.8 * want && B < 1.2 * want, `key ${m}: B ${B.toExponential(2)}, scale ${want.toExponential(2)}`);
  }
});

test('velocity changes the tone: a hard blow is brighter, not only louder', () => {
  // the share of the note above 4 kHz, soft against hard
  for (const m of [36, 48, 60, 72]) {
    const soft = highShare(note(m, 0.2, 0.5), 4000), hard = highShare(note(m, 0.9, 0.5), 4000);
    assert.ok(hard - soft > 8, `key ${m}: above 4 kHz ${soft.toFixed(1)} dB soft, ${hard.toFixed(1)} dB hard`);
  }
});

test('a harder blow is a shorter contact; the contact is shorter up the keyboard', () => {
  const contact = (m, v) => { const e = engine(); e.post({ type: 'n', t: 0.01, m, v }); render(e, 0.1); return (e.voices[m].contactFrames / FS) * 1000; };
  for (const m of [36, 60, 84]) {
    const soft = contact(m, 0.2), hard = contact(m, 0.9);
    assert.ok(hard < 0.92 * soft, `key ${m}: ${soft.toFixed(2)} ms soft, ${hard.toFixed(2)} ms hard`);
  }
  const c2 = contact(36, 0.5), c4 = contact(60, 0.5), c6 = contact(84, 0.5);
  assert.ok(c4 > 1.5 && c4 < 3, `C4 at mf: ${c4.toFixed(2)} ms`);
  assert.ok(c2 > c4 && c4 > c6, `${c2.toFixed(2)}, ${c4.toFixed(2)}, ${c6.toFixed(2)} ms`);
});

test('a harder blow changes the tone as much as on a recorded piano', () => {
  // Recorded notes of a Steinway B (University of Iowa; `node tools/notes.mjs`, 2026-11-10),
  // from mf to ff: for each dB the note gets louder, the bands 2-4 kHz and 4-8 kHz gain this
  // many dB more than the band of the fundamental. (Per dB of level, because nobody knows
  // how hard "mf" and "ff" were played.) The model must be within 30 % under and 50 % over.
  const RECORDED = { 36: [1.84], 48: [1.25, 1.76], 60: [1.21, 2.09], 72: [1.49, 1.94] };
  for (const m of [36, 48, 60, 72]) {
    const g = toneGain(modelNote(m, 1.5), modelNote(m, 4), m);
    RECORDED[m].forEach((want, i) => {
      const got = g.bands[3 + i] / g.level;
      assert.ok(got > 0.7 * want && got < 1.5 * want, `key ${m}, ${i ? '4-8' : '2-4'} kHz: ${got.toFixed(2)} dB per dB, recorded ${want}`);
    });
  }
});

test('the hammer stays on the strings about as long as measured on a real piano', () => {
  // Chaigne and Askenfelt (1994): 3.1, 2.0 and 0.6 ms for C2, C4 and C7 at mezzoforte (1.5 m/s)
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const v = (lo + hi) / 2; if (hammerSpeed(v) < 1.5) lo = v; else hi = v; }
  for (const [m, ms] of [[36, 3.1], [60, 2.0], [96, 0.6]]) {
    const e = engine(); e.post({ type: 'n', t: 0.01, m, v: lo }); render(e, 0.1);
    const got = (e.voices[m].contactFrames / FS) * 1000;
    assert.ok(got > 0.75 * ms && got < 1.4 * ms, `key ${m}: ${got.toFixed(2)} ms, measured ${ms} ms`);
  }
});

test('a harder blow is louder on every part of the keyboard', () => {
  for (const m of [21, 36, 60, 84, 96, 108]) {
    const lv = [0.15, 0.4, 0.7, 1].map((v) => db(peak(note(m, v, 0.3))));
    for (let i = 1; i < lv.length; i++) assert.ok(lv[i] > lv[i - 1] + 3, `key ${m}: ${lv.map((x) => x.toFixed(1)).join(', ')} dB`);
  }
});

test('tuning a note takes little from its highs: nearby pitches keep them equally long', () => {
  // the loop length of each of these pitches ends on another fraction of a sample
  const rates = withPiano({ detune: 0, uneven: 0 }, () => {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const e = engine(), v = e.voices[76];
      v.f = keyHz(76) * (1 + 0.0017 * i); v.design();
      e.post({ type: 'n', t: 0.01, m: 76, v: 0.8 });
      const x = render(e, 0.4), B = inharmonicity(76), k = 12;
      // the allpass chain is fitted up to 6 kHz: partial 12 lies about 4 % under the stiff
      // string's formula. Look for it 3.5 % to either side of that (its neighbours are 8 % away).
      out.push(decayRate(x, k * v.f * Math.sqrt((1 + B * k * k) / (1 + B)) * 0.97, 0.04, 0.2, 0.08, 0.035));
    }
    return out;
  });
  const lo = Math.min(...rates), hi = Math.max(...rates);
  assert.ok(lo > 0 && hi / lo < 1.6, `partial 12 (8 kHz) of notes around E5 decays at ${lo.toFixed(1)} to ${hi.toFixed(1)} /s`);
});

test('a loud note falls as on a recorded piano: quickly at first, slowly after', () => {
  // Recorded ff notes of a Steinway B (University of Iowa; `node tools/notes.mjs`, 2026-11-10):
  // dB under the level at 0.1 s, after 0.5, 1, 2, 3, 5 and 8 s (null: under the recording's noise).
  // The model, struck at 4 m/s, must be within 4 dB on average for every note.
  const RECORDED = {
    24: [-2.5, -5.2, -9.3, -12.1, -17.2, -23.7], 36: [-4.1, -7.0, -10.3, -14.5, -21.4, -22.7],
    48: [-5.1, -10.3, -19.3, -22.1, -24.5, -28.1], 60: [-12.8, -19.5, -21.9, -25.5, -35.4, null],
    72: [-11.3, -10.6, -24.0, -25.9, null, null], 84: [-6.1, -16.7, -28.7, -31.5, null, null],
    96: [-13.1, -24.9, null, null, null, null],
  };
  for (const m of Object.keys(RECORDED).map(Number)) {
    const got = modelCurve(m, 4), want = RECORDED[m];
    let err = 0, n = 0;
    want.forEach((w, i) => { if (w !== null) { err += Math.abs((Number.isFinite(got[i]) ? got[i] : -120) - w); n++; } });
    assert.ok(err / n < 4, `key ${m}: ${(err / n).toFixed(1)} dB off on average; model ${got.slice(0, n).map((x) => x.toFixed(0)).join(' ')}, recorded ${want.slice(0, n).join(' ')}`);
  }
});

test('three strings give a note two decays: quick at first, slow after', () => {
  const rate = (x, t0, t1) => (db(rms(x, t0, t0 + 0.3)) - db(rms(x, t1, t1 + 0.3))) / (t1 - t0); // dB/s
  const x = note(60, 0.6, 9), early = rate(x, 0.1, 1.1), late = rate(x, 5, 8);
  assert.ok(early > 2 * late && late > 0.5, `C4: ${early.toFixed(1)} dB/s at first, ${late.toFixed(1)} dB/s after`);
  // strings in perfect unison, struck equally, move together: only the quick decay is left
  const y = withPiano({ detune: 0, uneven: 0 }, () => note(60, 0.6, 5)), e2 = rate(y, 0.1, 1.1), l2 = rate(y, 2.5, 4.5);
  assert.ok(l2 > 0.8 * e2, `C4 in unison: ${e2.toFixed(1)} dB/s at first, ${l2.toFixed(1)} dB/s after`);
});

test('a damper stops the note when the key comes up; the top notes have none', () => {
  const held = note(60, 0.6, 1.5), let_go = note(60, 0.6, 1.5, 0.5);
  const drop = db(rms(held, 1, 1.2)) - db(rms(let_go, 1, 1.2));
  assert.ok(drop > 40, `C4, half a second after the key came up: ${drop.toFixed(1)} dB down`);
  const top = db(rms(note(96, 0.6, 0.6), 0.3, 0.5)) - db(rms(note(96, 0.6, 0.6, 0.1), 0.3, 0.5));
  assert.ok(Math.abs(top) < 0.5, `C7 rings on: ${top.toFixed(2)} dB`);
});

test('the sustain pedal keeps the dampers up', () => {
  const run = (pedalUp) => {
    const e = engine();
    e.post({ type: 'p', t: 0, v: 1 });
    e.post({ type: 'n', t: 0.01, m: 60, v: 0.6 });
    e.post({ type: 'o', t: 0.3, m: 60 });
    if (pedalUp) e.post({ type: 'p', t: 0.6, v: 0 });
    return render(e, 1.5);
  };
  // (the other strings, which ring along under the pedal, are left out here: see sympathy.test.mjs)
  const held = note(60, 0.6, 1.5), pedalled = withPiano({ sympathy: 0 }, () => run(false)), lifted = run(true);
  assert.ok(Math.abs(db(rms(held, 1, 1.2)) - db(rms(pedalled, 1, 1.2))) < 0.5, 'the note rings on under the pedal');
  assert.ok(db(rms(held, 1.2, 1.4)) - db(rms(lifted, 1.2, 1.4)) > 40, 'and stops when the pedal comes up');
});

test('a storm of keys and pedals stays bounded, and ends in silence', () => {
  const e = engine();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 600; i++) {
    const t = 4 * rnd(), m = 21 + Math.floor(88 * rnd());
    if (rnd() < 0.1) e.post({ type: 'p', t, v: rnd() < 0.5 ? 1 : 0 });
    else if (rnd() < 0.7) e.post({ type: 'n', t, m, v: rnd() });
    else e.post({ type: 'o', t, m });
  }
  // the same key struck again and again while it rings
  for (let i = 0; i < 40; i++) e.post({ type: 'n', t: 1 + 0.004 * i, m: 55, v: 1 });
  e.post({ type: 'O', t: 4.2 });
  const x = render(e, 9);
  for (let i = 0; i < x.length; i++) assert.ok(Number.isFinite(x[i]), `sample ${i}`);
  assert.ok(peak(x) < 4, `peak ${peak(x).toFixed(2)}`);
  // what is left has no damper: the top notes, which ring on for seconds, far below the storm
  assert.ok(e.live.every((v) => !v.hasDamper), `${e.live.filter((v) => v.hasDamper).length} damped notes still ring`);
  assert.ok(peak(x, 8.5, 9) < 1e-3 * peak(x, 0, 4), `still ${db(peak(x, 8.5, 9) / peak(x, 0, 4)).toFixed(0)} dB under the storm after 4 s`);
  // with dampers on every key, it is silence
  const y = withPiano({ lastDamper: 108 }, () => { const e2 = engine(); for (let i = 0; i < 200; i++) e2.post({ type: 'n', t: 0.01 * i, m: 21 + ((i * 37) % 88), v: 0.9 }); e2.post({ type: 'O', t: 2.2 }); return render(e2, 5); });
  assert.ok(peak(y, 4.5, 5) < 1e-5, `with dampers everywhere: still ${db(peak(y, 4.5, 5)).toFixed(0)} dB`);
});

test('no more notes ring at once than the engine can carry', () => {
  const e = engine();
  e.post({ type: 'p', t: 0, v: 1 });
  for (let m = 21; m <= 108; m++) e.post({ type: 'n', t: 0.01 + 0.01 * (m - 21), m, v: 0.8 });
  const x = render(e, 3);
  assert.ok(e.live.length <= 48, `${e.live.length} notes ring`);
  for (let i = 0; i < x.length; i += 97) assert.ok(Number.isFinite(x[i]));
});

test('the engine renders seven channels (six places on the bridge, and the knocks) that add up to the single one', () => {
  const post = (e) => { for (const [m, t] of [[30, 0.01], [50, 0.05], [64, 0.1], [80, 0.15], [100, 0.2]]) e.post({ type: 'n', t, m, v: 0.7 }); };
  const a = engine(), b = engine();
  post(a); post(b);
  const mono = render(a, 0.5), n = mono.length, ch = [0, 1, 2, 3, 4, 5, 6].map(() => new Float32Array(n));
  for (let i = 0; i < n; i += 128) b.render(ch.map((c) => c.subarray(i, i + 128)), 128, i);
  let err = 0, used = 0;
  for (let c = 0; c < 7; c++) if (peak(ch[c]) > 1e-4) used++;
  for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(mono[i] - ch.reduce((s, c) => s + c[i], 0)));
  assert.ok(err < 1e-5, `difference ${err}`);
  assert.ok(used >= 5, `${used} channels carry sound`);
});

// ---- no two strikes the same ------------------------------------------------------------
// PIANO.vary with every amount 0
const noVariation = () => ({ ...Object.fromEntries(Object.keys(PIANO.vary).map((k) => [k, 0])), feltNoiseHz: PIANO.vary.feltNoiseHz });

test('no two strikes are the same; the same seed gives the same strike', () => {
  const strike = (seed) => { const e = engine({}, FS, seed); e.post({ type: 'n', t: 0.01, m: 60, v: 0.5 }); return render(e, 0.3); };
  const a = strike(1), b = strike(2), c = strike(1);
  const d = a.map((x, i) => x - b[i]), diff = db(rms(d, 0.01, 0.29)) - db(rms(a, 0.01, 0.29));
  assert.ok(diff > -40, `two seeds differ by ${diff.toFixed(1)} dB`);
  assert.deepEqual(a, c);
});

test('the variation leaves the mean level of a note where it was', () => {
  for (const m of [36, 60, 84]) {
    const level = (seed) => { const e = engine({}, FS, seed); e.post({ type: 'n', t: 0.01, m, v: 0.5 }); return rms(render(e, 0.5), 0.05, 0.49); };
    let s = 0;
    for (let k = 1; k <= 8; k++) s += level(k) ** 2;
    const mean = db(Math.sqrt(s / 8)), still = db(withPiano({ vary: noVariation() }, () => level(1)));
    assert.ok(Math.abs(mean - still) < 0.5, `key ${m}: ${(mean - still).toFixed(2)} dB`);
  }
});

test('the detuning of a key does not depend on the strike', () => {
  const pitches = (seed) => engine({}, FS, seed).voices[60].strings.map((s) => s.f);
  assert.deepEqual(pitches(1), pitches(2));
});
