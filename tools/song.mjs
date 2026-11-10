// A song as the microphones hear it, for measuring: the engine and the soundboard, without
// reverb, delay or the master stage.
//
//   node tools/song.mjs <demo name or number> [reference file]
//
// prints the long-term third-octave spectrum of the demo, and its difference to a recording.

import { fileURLToPath } from 'node:url';
import { DEMOS } from '../js/demos.js';
import { perform } from '../js/player.js';
import { compile, eventsBetween, songEnd, tickSecs, humanOf } from '../js/song.js';
import { engine, throughBoard, cachedBoard } from '../test/util.mjs';
import { ltas, decode, BANDS } from './ltas.mjs';

// the two microphones mixed to one; seconds: how much of the song (0: all of it and 3 s more)
export function heardSong(song, seconds = 0, board = cachedBoard()) {
  const h = humanOf(song.inst), list = h > 0 ? perform(song, { seed: 1, human: h }) : compile(song);
  const e = engine({ hard: song.inst.hard, noise: song.inst.noise });
  const secs = seconds || songEnd(song) * tickSecs(song) + 3;
  for (const ev of eventsBetween(song, list, 0, secs / tickSecs(song), 0.05)) e.post(ev);
  const { L, R } = throughBoard(e, secs, board), out = new Float32Array(L.length);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (L[i] + R[i]);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const which = process.argv[2] || '0', demo = DEMOS[+which] || DEMOS.find((d) => d.name.toLowerCase().includes(which.toLowerCase()));
  if (!demo) { console.error('no such demo'); process.exit(1); }
  const a = ltas(heardSong(demo.make())), b = process.argv[3] ? ltas(decode(process.argv[3])) : null;
  console.log(`${demo.name}${b ? ' against ' + process.argv[3] : ''}\n   band     model${b ? '  recording   model - recording' : ''}`);
  BANDS.forEach((f, i) => console.log(`${f.toFixed(0).padStart(7)}   ${a.bands[i].toFixed(1).padStart(6)}${b ? `   ${b.bands[i].toFixed(1).padStart(6)}      ${(a.bands[i] - b.bands[i]).toFixed(1).padStart(6)}` : ''}`));
}
