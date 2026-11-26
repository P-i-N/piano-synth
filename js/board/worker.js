// Builds the soundboard off the main thread, streaming progress (0 .. 1).
// in:  { id, fs, cfg }
// out: { type: 'progress', id, p } ... { type: 'done', id, ok: true, board } | { type: 'done', id, ok: false, error }

import { BOARD, buildBoard } from './model.js';

self.onmessage = (e) => {
  const { id = 0, fs, cfg } = e.data || {};
  try {
    let last = -1;
    const board = buildBoard(fs, cfg || BOARD, (p) => {
      if (p === 0 || p === 1 || p - last >= 0.015) {
        last = p;
        self.postMessage({ type: 'progress', id, p });
      }
    });
    self.postMessage({ type: 'done', id, ok: true, board }, board.irs.map((a) => a.buffer));
  } catch (err) {
    self.postMessage({ type: 'done', id, ok: false, error: String((err && err.message) || err) });
  }
};
