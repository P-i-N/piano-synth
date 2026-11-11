// LZMA for links: what goes in comes out, and broken data is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compress, decompress } from '../js/lzma.js';

function rng(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test('bytes survive compression', () => {
  const rnd = rng(9);
  const cases = [
    new Uint8Array(0), Uint8Array.of(0), Uint8Array.of(255, 255),
    new Uint8Array(70000),
    Uint8Array.from({ length: 5000 }, () => (rnd() * 256) | 0),
    Uint8Array.from({ length: 5000 }, () => (rnd() * 3) | 0),
    Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) % 251),
    readFileSync(new URL('../js/worklet.js', import.meta.url)),
  ];
  for (const data of cases) assert.deepEqual(decompress(compress(data)), Uint8Array.from(data), `${data.length} bytes`);
});

test('repeated data becomes small', () => {
  // a match is at most 273 bytes long: 257 of them
  assert.ok(compress(new Uint8Array(70000)).length < 70);
  const tune = new TextEncoder().encode('e d c d e e e '.repeat(200));
  assert.ok(compress(tune).length < 40);
});

test('random data grows by a few bytes at most', () => {
  const rnd = rng(4), data = Uint8Array.from({ length: 4000 }, () => (rnd() * 256) | 0);
  assert.ok(compress(data).length < 4000 * 1.02);
});

test('broken data is refused, not run without end', () => {
  const rnd = rng(1);
  const good = compress(new TextEncoder().encode('do re mi fa sol la si do '.repeat(20)));
  let refused = 0;
  for (let k = 0; k < 200; k++) {
    const bad = Uint8Array.from(good);
    bad[1 + Math.floor(rnd() * (bad.length - 1))] ^= 1 << Math.floor(rnd() * 8);
    try { decompress(bad); } catch (e) { refused++; }
  }
  assert.ok(refused > 0);
  assert.throws(() => decompress(Uint8Array.of(0xFF, 0xFF, 0xFF, 0xFF, 0x7F)), /too large/);
  assert.throws(() => decompress(Uint8Array.of(0x80)), /size/);
});
