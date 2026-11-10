// Builds the soundboard off the main thread.
// in:  { fs }        out: { ok: true, board } | { ok: false, error }

import { buildBoard } from './model.js';

self.onmessage = (e) => {
  try {
    const board = buildBoard(e.data.fs);
    self.postMessage({ ok: true, board }, board.irs.map((a) => a.buffer));
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
