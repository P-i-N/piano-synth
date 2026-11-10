// Demo songs: public-domain pieces (or their openings) and originals, each with one line
// about what it shows. All play in the same room, with Humanize on.
//
// Notation, one string for each voice: `name:length` separated by spaces.
//   name     c4 (middle C), f#3, bb5; a chord [c4 e4 g4]; a rest r
//   length   1 whole, 2 half, 4 quarter, 8, 16; a dot adds half (4.); t is a triplet (8t);
//            lengths joined by + are tied (2.+4)
//   v72      the loudness (1 .. 127) from here on
//   |        a bar line, for the reader only

import { PPQ, newSong, sortNotes, setReverbSpace } from './song.js';

const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
export function key(name) {
  const m = /^([a-g])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note "${name}"`);
  return 12 * (+m[3] + 1) + STEP[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const ticks = (len) => len.split('+').reduce((sum, l) => {
  const m = /^(\d+)(\.?)(t?)$/.exec(l);
  if (!m) throw new Error(`bad length "${l}"`);
  return sum + ((4 * PPQ) / +m[1]) * (m[2] ? 1.5 : 1) * (m[3] ? 2 / 3 : 1);
}, 0);

// One voice: returns its notes [{ t, d, m, v }]. hold: the share of its length a note is held.
export function voice(text, { t0 = 0, v = 72, hold = 1 } = {}) {
  const notes = [];
  let t = t0;
  for (const tok of text.replace(/\[([^\]]*)\]/g, (_, c) => '[' + c.trim().split(/\s+/).join(',') + ']').split(/\s+/)) {
    if (!tok || tok === '|') continue;
    if (/^v\d+$/.test(tok)) { v = +tok.slice(1); continue; }
    const [name, len] = tok.split(':');
    if (!len) throw new Error(`bad token "${tok}"`);
    const d = ticks(len);
    if (name !== 'r') for (const k of name[0] === '[' ? name.slice(1, -1).split(',') : [name]) notes.push({ t: Math.round(t), d: Math.max(1, Math.round(d * hold)), m: key(k), v });
    t += d;
  }
  return notes;
}

// the pedal down for each of the bars a .. b - 1 (or parts of them), up a sixteenth before the next
const pedalBars = (a, b, bar, parts = 1) => { const out = []; for (let i = a * parts; i < b * parts; i++) out.push([(i * bar) / parts, ((i + 1) * bar) / parts - PPQ / 4]); return out; };

function make({ title, bpm, bpb = 4, grid = 4 }, voices, pedal = []) {
  const s = newSong();
  Object.assign(s, { title, bpm, bpb, grid, notes: voices.flat(), pedal });
  sortNotes(s);
  setReverbSpace(s.fx, 'room');
  return s;
}
const rep = (text, n) => Array(n).fill(text).join(' ');

// Bach's prelude: each bar is five notes, played as 1 2 3 4 5 3 4 5, twice; the first two are held
const PRELUDE = ['c4 e4 g4 c5 e5', 'c4 d4 a4 d5 f5', 'b3 d4 g4 d5 f5', 'c4 e4 g4 c5 e5', 'c4 e4 a4 e5 a5', 'c4 d4 f#4 a4 d5', 'b3 d4 g4 d5 g5', 'b3 c4 e4 g4 c5', 'a3 c4 e4 g4 c5', 'd3 a3 d4 f#4 c5',
  'g3 b3 d4 g4 b4', 'g3 bb3 e4 g4 c#5', 'f3 a3 d4 a4 d5', 'f3 ab3 d4 f4 b4', 'e3 g3 c4 g4 c5', 'e3 f3 a3 c4 f4', 'd3 f3 a3 c4 f4', 'g2 d3 g3 b3 f4', 'c3 e3 g3 c4 e4'];
function prelude() {
  const notes = [];
  PRELUDE.forEach((bar, i) => {
    const [a, b, c, d, e] = bar.split(' ');
    for (const h of [0, 1]) {
      const t0 = (i * 4 + h * 2) * PPQ;
      notes.push(...voice(`${a}:2`, { t0, v: 60 }), ...voice(`r:16 ${b}:8.+4`, { t0, v: 54 }), ...voice(`r:8 ${c}:16 ${d}:16 ${e}:16 ${c}:16 ${d}:16 ${e}:16`, { t0, v: 58 }));
    }
  });
  notes.push(...voice('[c3 g3 c4 e4]:1', { t0: PRELUDE.length * 4 * PPQ, v: 56 }));
  return make({ title: 'Bach: Prelude in C', bpm: 70 }, [notes]);
}

export const DEMOS = [
  {
    name: 'Nocturne', about: 'A singing melody over broken chords under the pedal: the piano as it is meant to sound',
    make: () => make({ title: 'Nocturne', bpm: 63 }, [
      voice('v80 c5:2 eb5:4 ab5:4 | v84 g5:4. f5:8 f5:2 | v86 f5:4 ab5:4 db6:4. c6:8 | v80 bb5:2. r:4 | v88 c6:4 bb5:8 ab5:8 eb5:2 | v84 f5:4 ab5:4 c6:4. bb5:8 | v78 ab5:4 f5:4 g5:4 db5:4 | v70 c5:1'),
      voice(`v50 ${rep('ab2:8 eb3:8 c4:8 eb3:8', 2)} | ${rep('f2:8 c3:8 ab3:8 c3:8', 2)} | ${rep('db2:8 ab2:8 f3:8 ab2:8', 2)} | eb2:8 bb2:8 g3:8 bb2:8 eb2:8 bb2:8 db4:8 bb2:8 | ${rep('ab2:8 eb3:8 c4:8 eb3:8', 2)} | ${rep('f2:8 c3:8 ab3:8 c3:8', 2)} | bb2:8 f3:8 db4:8 f3:8 eb2:8 bb2:8 g3:8 db4:8 | v46 ab2:8 eb3:8 c4:8 eb3:8 ab3:2`),
    ], [...pedalBars(0, 6, 4 * PPQ), ...pedalBars(6, 7, 4 * PPQ, 2), ...pedalBars(7, 8, 4 * PPQ)]),
  },
  { name: 'Bach: Prelude in C', about: 'The Well-Tempered Clavier, book 1, bars 1 to 19: held notes ringing into each other without the pedal', make: prelude },
  {
    name: 'Beethoven: Für Elise', about: 'The opening: a soft touch, and the pedal catching the left hand',
    make: () => make({ title: 'Beethoven: Für Elise', bpm: 132, bpb: 3, grid: 2 }, [
      // one written sixteenth is an eighth here
      voice('v58 r:2 e5:8 d#5:8 | e5:8 d#5:8 e5:8 b4:8 d5:8 c5:8 | v62 a4:4 r:8 c4:8 e4:8 a4:8 | b4:4 r:8 e4:8 g#4:8 b4:8 | c5:4 r:8 e4:8 e5:8 d#5:8 | v58 e5:8 d#5:8 e5:8 b4:8 d5:8 c5:8 | v62 a4:4 r:8 c4:8 e4:8 a4:8 | b4:4 r:8 e4:8 c5:8 b4:8 | v56 a4:2.'),
      voice('v50 r:2. | r:2. | a2:8 e3:8 a3:8 r:4. | e2:8 e3:8 g#3:8 r:4. | a2:8 e3:8 a3:8 r:4. | r:2. | a2:8 e3:8 a3:8 r:4. | e2:8 e3:8 g#3:8 r:4. | a2:8 e3:8 a3:2'),
    ], [2, 3, 4, 6, 7, 8].map((b) => [b * 3 * PPQ, b * 3 * PPQ + 2 * PPQ])),
  },
  {
    name: 'Satie: Gymnopédie No. 1', about: 'The first twelve bars: slow, soft, and long notes dying away',
    make: () => make({ title: 'Satie: Gymnopédie No. 1', bpm: 70, bpb: 3 }, [
      // (the melody's last note, a long F sharp, is the top note of the chords under it)
      voice('v64 r:2.+2.+2.+2. | r:4 f#5:4 a5:4 | g5:4 f#5:4 c#5:4 | b4:4 c#5:4 d5:4 | a4:2.'),
      voice(`v46 ${rep('g2:2. | d2:2. |', 6)}`),
      voice(`v42 ${rep('r:4 [b3 d4 f#4]:2 | r:4 [a3 c#4 f#4]:2 |', 6)}`),
    ], pedalBars(0, 12, 3 * PPQ)),
  },
  {
    name: 'Canon in D', about: 'After Pachelbel: eight chords, four times, from long notes to running ones',
    make: () => {
      const bass = 'd3:2 a2:2 | b2:2 f#2:2 | g2:2 d2:2 | g2:2 a2:2 |', chords = '[f#3 a3 d4]:2 [e3 a3 c#4]:2 | [d3 f#3 b3]:2 [c#3 f#3 a3]:2 | [d3 g3 b3]:2 [d3 f#3 a3]:2 | [d3 g3 b3]:2 [e3 a3 c#4]:2 |';
      return make({ title: 'Canon in D', bpm: 58 }, [
        voice(`v56 ${rep(bass, 4)} [d2 d3]:1`),
        voice(`v44 ${rep(chords, 2)}`),
        voice(`v66 r:1+1+1+1 | f#5:2 e5:2 | d5:2 c#5:2 | b4:2 a4:2 | b4:2 c#5:2 | v72 d5:4 f#5:4 a5:4 g5:4 | f#5:4 d5:4 f#5:4 e5:4 | d5:4 b4:4 d5:4 a5:4 | g5:4 b5:4 a5:4 g5:4 | v78 d5:8 f#5:8 a5:8 f#5:8 c#5:8 e5:8 a5:8 e5:8 | b4:8 d5:8 f#5:8 d5:8 a4:8 c#5:8 f#5:8 c#5:8 | b4:8 d5:8 g5:8 d5:8 a4:8 d5:8 f#5:8 d5:8 | b4:8 d5:8 g5:8 d5:8 c#5:8 e5:8 a5:8 e5:8 | v70 [f#4 a4 d5]:1`),
        voice('v58 r:1+1+1+1+1+1+1+1 | d4:2 c#4:2 | b3:2 a3:2 | g3:2 f#3:2 | g3:2 e3:2 | f#4:2 e4:2 | d4:2 c#4:2 | b3:2 a3:2 | b3:2 c#4:2'),
      ], pedalBars(0, 17, 4 * PPQ, 2));
    },
  },
  {
    name: 'Minuet in G', about: 'From the notebook for Anna Magdalena Bach (Petzold): two hands, two lines, no pedal',
    make: () => make({ title: 'Minuet in G', bpm: 116, bpb: 3, grid: 2 }, [
      voice('v74 d5:4 g4:8 a4:8 b4:8 c5:8 | d5:4 g4:4 g4:4 | e5:4 c5:8 d5:8 e5:8 f#5:8 | g5:4 g4:4 g4:4 | c5:4 d5:8 c5:8 b4:8 a4:8 | b4:4 c5:8 b4:8 a4:8 g4:8 | f#4:4 g4:8 a4:8 b4:8 g4:8 | a4:2. | v78 d5:4 g4:8 a4:8 b4:8 c5:8 | d5:4 g4:4 g4:4 | e5:4 c5:8 d5:8 e5:8 f#5:8 | g5:4 g4:4 g4:4 | c5:4 d5:8 c5:8 b4:8 a4:8 | b4:4 c5:8 b4:8 a4:8 g4:8 | a4:4 b4:8 a4:8 g4:8 f#4:8 | g4:2.'),
      voice('v60 [g3 b3 d4]:2 a3:4 | b3:2. | c4:2. | b3:2. | a3:2. | g3:2. | d4:4 b3:4 g3:4 | d4:4 d3:8 c4:8 b3:8 a3:8 | b3:2 a3:4 | g3:4 b3:4 g3:4 | c4:2. | b3:4 c4:8 b3:8 a3:8 g3:8 | a3:2 f#3:4 | g3:2 b3:4 | c4:4 d4:4 d3:4 | g3:2 g2:4'),
    ]),
  },
  {
    name: 'Ode to Joy', about: 'Beethoven\'s tune as a chorale, soft and then loud in octaves: the top note is brought out',
    make: () => {
      const tune = 'e:4 e:4 f:4 g:4 | g:4 f:4 e:4 d:4 | c:4 c:4 d:4 e:4 | e:4. d:8 d:2 | e:4 e:4 f:4 g:4 | g:4 f:4 e:4 d:4 | c:4 c:4 d:4 e:4 | d:4. c:8 c:2 |';
      const at = (o) => tune.replace(/([a-g]):/g, `$1${o}:`);
      const low = '[c3 e3 g3]:2 [c3 e3 g3]:2 | [b2 d3 g3]:2 [g2 d3 g3]:2 | [c3 e3 g3]:2 [c3 e3 g3]:2 | [g2 d3 b3]:2 [g2 d3 b3]:2 | [c3 e3 g3]:2 [c3 e3 g3]:2 | [b2 d3 g3]:2 [g2 d3 g3]:2 | [c3 e3 g3]:2 [a2 e3 a3]:2 | [g2 f3 b3]:2 [c3 e3 g3]:2 |';
      return make({ title: 'Ode to Joy', bpm: 104 }, [
        voice(`v56 ${at(4)} v100 ${at(5)}`), voice(`r:1+1+1+1+1+1+1+1 v94 ${at(4)}`), voice(`v48 ${low} v88 ${low}`),
      ]);
    },
  },
  {
    name: 'Soft to loud', about: 'The same chord eight times, from the softest blow to the hardest: the tone changes, not only the loudness',
    make: () => make({ title: 'Soft to loud', bpm: 80 }, [
      [14, 28, 44, 60, 76, 92, 110, 127].flatMap((v, i) => voice('[c3 g3 e4 g4 c5]:2.', { t0: i * 4 * PPQ, v })),
      [14, 28, 44, 60, 76, 92, 110, 127].flatMap((v, i) => voice('c4:4', { t0: (32 + i) * PPQ, v })),
    ]),
  },
  {
    name: 'Under the pedal', about: 'Short notes without the pedal, then the same notes under it: the other strings ring along',
    make: () => {
      const run = 'c2:8 g2:8 c3:8 e3:8 g3:8 c4:8 e4:8 g4:8 c5:8 e5:8 g5:8 c6:8 e6:8 g6:8 c7:4';
      return make({ title: 'Under the pedal', bpm: 84 }, [voice(`v84 ${run}`, { hold: 0.4 }), voice(`v84 ${run}`, { t0: 12 * PPQ, hold: 0.4 })], [[12 * PPQ, 24 * PPQ]]);
    },
  },
  {
    name: 'Rolled tenths', about: 'Left-hand chords wider than a hand: the player rolls them from the bottom',
    make: () => make({ title: 'Rolled tenths', bpm: 66 }, [
      voice(`v78 ${rep('[g4 c5 e5]:2 [g4 c5 e5]:4 [e4 a4 c5]:4 | [e4 a4 c5]:2 [f4 a4 c5]:2 | [f4 a4 c5]:2 [d4 g4 b4]:2 | [d4 g4 b4]:2. r:4 |', 2)} [e4 g4 c5]:1`),
      voice(`v62 ${rep('[c2 g2 e3]:2. [a1 e2 c3]:4 | [a1 e2 c3]:2 [f1 c2 a2]:2 | [f1 c2 a2]:2 [g1 d2 b2]:2 | [g1 d2 b2]:2. r:4 |', 2)} [c2 g2 e3]:1`),
    ], pedalBars(0, 9, 4 * PPQ, 2)),
  },
  {
    name: 'Repeated notes', about: 'A fast toccata: the hammer strikes strings that are still ringing',
    make: () => make({ title: 'Repeated notes', bpm: 126 }, [
      voice(`v82 ${rep('d5:16', 8)} d5:16 e5:16 f5:16 g5:16 a5:16 g5:16 f5:16 e5:16 | ${rep('e5:16', 8)} e5:16 f5:16 g5:16 a5:16 bb5:16 a5:16 g5:16 f5:16 | v90 ${rep('f5:16', 8)} f5:16 g5:16 a5:16 bb5:16 c6:16 bb5:16 a5:16 g5:16 | v96 a5:16 g5:16 f5:16 e5:16 d5:16 c#5:16 d5:16 e5:16 f5:16 e5:16 d5:16 c#5:16 d5:4`, { hold: 0.8 }),
      voice('v76 [d2 d3]:4 r:4 [d2 d3]:4 r:4 | [a1 a2]:4 r:4 [a1 a2]:4 r:4 | [f2 f3]:4 r:4 [f2 f3]:4 r:4 | [a1 a2]:2 [d2 d3]:2', { hold: 0.9 }),
    ]),
  },
  {
    name: 'Low and high', about: 'The lowest strings, which ring for half a minute, and the highest, which have no dampers',
    make: () => make({ title: 'Low and high', bpm: 72 }, [
      voice('v84 [a0 a1]:1 | r:1 | [f1 f2]:1 | r:1 | [a0 a1 e2]:1+1'),
      voice('v70 r:1 | c7:8 e7:8 g7:8 c8:8 g7:8 e7:8 c7:4 | r:1 | a6:8 c7:8 f7:8 a7:8 f7:8 c7:8 a6:4 | r:1 | e7:8 a7:8 c8:8 a7:8 e7:2'),
    ]),
  },
];
