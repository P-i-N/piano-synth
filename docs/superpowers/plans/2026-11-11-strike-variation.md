# Strike Variation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every strike of a key sounds a little different: hammer, felt, strings and knock vary at random.

**Architecture:** `PianoEngine` takes a random source (`() => 0..1`) in its constructor and hands it to `Voice.strike` and to the knocks. All amounts are one table, `PIANO.vary`. The per-key tuning (detuning drawn in `Voice.design` from a seeded `mulberry32`) does not change.

**Tech Stack:** Plain ES modules, AudioWorklet, Node 22 `node:test`. No packages.

**Spec:** [docs/superpowers/specs/2026-11-11-strike-variation-design.md](../specs/2026-11-11-strike-variation-design.md)

## Global Constraints

- Every render in the app is random (`Math.random`). Tests and tools use `mulberry32` with a fixed seed and stay deterministic.
- The detuning of a key's strings stays fixed by key.
- No new UI setting. Knock noise is under "Action noise" (`P.noise`); the felt noise and the per-strike variation are not.
- Real time: nothing allocated per sample; random draws per strike, or per sample only during hammer contact or a knock.
- The existing tests keep passing. Do not widen a tolerance. If a fitted test fails, report it.
- Amounts are estimates. Their comment in `PIANO.vary` says so.
- Commits: `type(module): summary`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `janp/strike-variation` from `janp/lzma-links` (there is no `develop` here).

## Review Focus

1. Highest key at full velocity (C8, `v: 1`) with the felt noise: the render stays finite. Test in Task 2.
2. `PIANO.vary` with all amounts 0: two engines with different seeds give the same output sample for sample, so every random draw goes through `vary`. Test in Task 2.
3. Knock level after the noise is added: the recorded-knock test (`test/sympathy.test.mjs`, C6–C8) holds without a change of its tolerance. Task 3.
4. Removing the per-key `share` draw from `Voice.design` changes the detuning sequence (the loop draws `det` and `share` in turn). The draws must stay. Test in Task 1.
5. Sympathy strings (`Sympathy` builds `Voice`s that never strike) are not affected: covered by `test/sympathy.test.mjs`.

---

### Task 1: Random source and per-strike variation of hammer and strings

**Files:**
- Modify: `js/worklet.js` (`PIANO`, `Voice.design`, `Voice.strike`, `Voice.hammerTick`, `PianoEngine` constructor and `handle`, the export line)
- Modify: `test/util.mjs:73-77` (`engine`)
- Modify: `js/board/model.js:17` (`MODEL_VERSION` 5 → 6: the worklet URL carries it, so the browser loads the new worklet; the board is computed once again)
- Test: `test/engine.test.mjs`

**Interfaces:**
- Produces: `new PianoEngine(fs, rnd = Math.random)`; `this.rnd` replaces `mulberry32(0x5eed)`.
- Produces: `export { mulberry32 }` from `js/worklet.js`.
- Produces: `engine(cfg = {}, fs = FS, seed = 1)` in `test/util.mjs`, which passes `mulberry32(seed)`.
- Produces: `PIANO.vary = { speed: 0.03, felt: 0.05, share: 0.06, lag: 30e-6, feltNoise: 0.1, feltNoiseHz: 3000, knock: 0.2, knockLen: 0.2, knockNoise: 1 }`. All are ± half-ranges of a uniform draw, except `lag` (seconds, 0..lag), `feltNoiseHz` (corner of the one-pole lowpass) and `knockNoise` (noise against the pulse, Task 3). Comment: estimates set by ear; the recordings have one take per note and dynamic.
- Produces: `Voice.strike(v, hard, rnd)`.

- [ ] **Step 1: Write the failing tests** in `test/engine.test.mjs`

```js
test('no two strikes are the same; the same seed gives the same strike', () => {
  const strike = (seed) => { const e = engine({}, FS, seed); e.post({ type: 'n', t: 0.01, m: 60, v: 0.5 }); return render(e, 0.3); };
  const a = strike(1), b = strike(2), c = strike(1);
  const d = a.map((x, i) => x - b[i]);
  assert.ok(db(rms(d, 0.01, 0.3)) - db(rms(a, 0.01, 0.3)) > -40, 'two seeds differ by more than -40 dB');
  assert.deepEqual(a, c);
});

test('the variation leaves the mean level of a note where it was', () => {
  for (const m of [36, 60, 84]) {
    const level = (seed) => { const e = engine({}, FS, seed); e.post({ type: 'n', t: 0.01, m, v: 0.5 }); return rms(render(e, 0.5), 0.05, 0.5); };
    let s = 0; for (let k = 1; k <= 8; k++) s += level(k) ** 2;
    const still = withPiano({ vary: ZERO }, () => level(1));
    assert.ok(Math.abs(db(Math.sqrt(s / 8)) - db(still)) < 0.5, `key ${m}`);
  }
});

test('the detuning of a key does not depend on the strike', () => {
  // the strings' pitches are set once per key
  const e1 = engine({}, FS, 1), e2 = engine({}, FS, 2);
  assert.deepEqual(e1.voices[60].strings.map((s) => s.f), e2.voices[60].strings.map((s) => s.f));
});
```

`ZERO` is `Object.fromEntries(Object.keys(PIANO.vary).map((k) => [k, 0]))` (with `feltNoiseHz: 3000` kept). Use the file's `withPiano`; if `engine.test.mjs` has none, use the one from `test/sympathy.test.mjs`.

- [ ] **Step 2: Run, verify they fail**

Run: `node --test test/engine.test.mjs`
Expected: the file fails to load its tests (`PIANO.vary` is undefined); with a stub `vary` the first test fails (two seeds give the same output). The third passes already: it is a guard.

- [ ] **Step 3: Implement**
- `Voice.design`: keep both `rnd()` draws in the loop. Keep the per-key `share` as the base (`this.share0`).
- `Voice.strike(v, hard, rnd)`: draw, with `u = () => 2 * rnd() - 1`:
  - hammer speed `hammerSpeed(v) * (1 + vary.speed * u())`
  - felt stiffness factor `1 + vary.felt * u()`, multiplied into `this.hard`
  - per string: share `share0 * (1 + vary.share * u())`, normalized to mean 1 as in `design`
  - per string: `lag` in whole samples, `Math.round(rnd() * vary.lag * fs)`
- `Voice.hammerTick`: string `i` takes no hammer force while `this.hN < s.lag`.
- `PianoEngine.handle('n')`: `v.strike(ev.v, this.P.hard, this.rnd)`.

- [ ] **Step 4: Run the whole suite**

Run: `node --test "test/*.test.mjs"`
Expected: all pass. The felt noise is not in yet; the level test passes with it later too (Task 2).

- [ ] **Step 5: Commit**: `feat(sound): every strike varies the hammer, the felt and the strings`

---

### Task 2: Felt noise during hammer contact

**Files:**
- Modify: `js/worklet.js` (`Voice.strike`, `Voice.hammerTick`)
- Test: `test/engine.test.mjs`

**Interfaces:**
- Consumes: `this.rnd` reaches the voice through `strike(v, hard, rnd)`; keep it as `this.rnd`.
- Consumes: `PIANO.vary.feltNoise`, `PIANO.vary.feltNoiseHz`.

- [ ] **Step 1: Write the failing tests**

```js
test('with no variation, the random source changes nothing', () => {
  const strike = (seed) => withPiano({ vary: ZERO }, () => { const e = engine({ noise: 0 }, FS, seed); e.post({ type: 'n', t: 0.01, m: 72, v: 0.7 }); return render(e, 0.2); });
  assert.deepEqual(strike(1), strike(2));
});

test('the top key at full strength stays finite with the felt noise', () => {
  for (const seed of [1, 2, 3]) { const e = engine({}, FS, seed); e.post({ type: 'n', t: 0.01, m: 108, v: 1 }); const x = render(e, 0.2); assert.ok(x.every(Number.isFinite)); }
});
```

- [ ] **Step 2: Run, verify**

Run: `node --test test/engine.test.mjs`
Expected: both pass before the felt noise (they guard it). Confirm they fail on purpose by setting `feltNoise` to `NaN` once, then revert.

- [ ] **Step 3: Implement**
In `hammerTick`, before the bisection, multiply `K` by `1 + feltNoise * n`, where `n` is white noise `2 * rnd() - 1` through a one-pole lowpass at `feltNoiseHz` (state on the voice, reset in `strike`). Scale the lowpass output so its range stays within ±1 (`K` stays positive).

- [ ] **Step 4: Run the whole suite**

Run: `node --test "test/*.test.mjs"`
Expected: all pass, including the level test of Task 1 and `test/tone.test.mjs`.

- [ ] **Step 5: Commit**: `feat(sound): noise in the felt while the hammer is on the strings`

---

### Task 3: A noisy knock, matched again

**Files:**
- Modify: `js/worklet.js` (`PianoEngine.thump`, the knock loop in `render`, `PIANO.knock`)
- Test: `test/sympathy.test.mjs` (existing knock tests; no change)

**Interfaces:**
- Consumes: `this.rnd`, `PIANO.vary.knock`, `PIANO.vary.knockLen`, `PIANO.vary.knockNoise`.

- [ ] **Step 1: Measure the knock before the change**

With a scratch script (not committed), print `knockLevel(heardStereo(m, vFor(s), 1).L, m)` for `m` in 84, 96, 108 and `s` in 1.5, 4. Save the six numbers.

- [ ] **Step 2: Implement**
- `thump`: amplitude `amp * (1 + vary.knock * u())`, length `n * (1 + vary.knockLen * u())`, and a lowpass state for its noise.
- Knock loop: the envelope `0.5 - 0.5 cos x` multiplies `sin(x) + vary.knockNoise * noise`, where `noise` is `2 * rnd() - 1` through a one-pole lowpass at 1 kHz. All thumps (key down, key up, pedal) take this path.

- [ ] **Step 3: Match the level again**
Run the scratch script with seeds 1 to 8. Scale `PIANO.knock` so the mean over seeds of the six numbers is within 1 dB of Step 1. Scale `keyUp` and `pedalThump` by the same factor. Update the knock comment in `PIANO` with the new value and the reason.

- [ ] **Step 4: Run the whole suite**

Run: `node --test "test/*.test.mjs"`
Expected: all pass, the knock tests in `test/sympathy.test.mjs` unchanged.

- [ ] **Step 5: Commit**: `feat(sound): the knock of the action is noisy and varies`

---

### Task 4: README, listening check

**Files:**
- Modify: `README.md` (one entry in "How the sound is made", after the knock entries)

- [ ] **Step 1: README entry.** Content: every strike draws its hammer speed (±3 %), felt stiffness (±5 %), the share of each string and a lag of up to 30 µs between strings; the felt has a little noise while it touches the strings; the knock is noisy and varies ±20 % in size and length. Estimates set by ear: the recordings have one take per note. Every render differs, also WAV export.
- [ ] **Step 2: Run the whole suite.** `node --test "test/*.test.mjs"`: all pass.
- [ ] **Step 3: Listening check.** Start the page (`python3 -m http.server 8766`), click C4 five times at the same place: the strikes differ. Report what was heard; this is not a test.
- [ ] **Step 4: Commit**: `docs(readme): variation from strike to strike`, with the spec and this plan.
