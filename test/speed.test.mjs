// Speed: the engine must run well inside real time, in the browser's audio thread.
// The budget is at least twice what was measured when this test ran on its own (the other
// test files run at the same time and slow it down).
import test from 'node:test';
import assert from 'node:assert/strict';
import { engine, render } from './util.mjs';

test('40 notes ringing under the pedal: 10 s of sound in under 4 s', () => {
  const e = engine();
  e.post({ type: 'p', t: 0, v: 1 });
  // struck again every second, so that all of them keep ringing
  for (let r = 0; r < 10; r++) for (let i = 0; i < 40; i++) e.post({ type: 'n', t: r + 0.01 + 0.02 * i, m: 24 + 2 * i, v: 0.7 });
  const t0 = performance.now();
  render(e, 10);
  const secs = (performance.now() - t0) / 1000;
  assert.ok(e.live.length >= 38, `${e.live.length} notes ring at the end`);
  assert.ok(secs < 4, `10 s of 40 notes took ${secs.toFixed(2)} s`);
  console.log(`10 s of 40 ringing notes: ${secs.toFixed(2)} s`);
});
