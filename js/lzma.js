// LZMA for short links: the algorithm of Igor Pavlov's public-domain LZMA SDK, cut down for
// inputs of a few to a hundred kilobytes.
//
//   * lc = lp = pb = 0: the literal coder has no context. Measured best on the song format,
//     whose bytes are columns of numbers, not text.
//   * no header and no end marker: the stream starts with the uncompressed size as a varint
//   * the range coder's first byte (always 0) is not stored, and the last value is chosen to
//     end in zero bytes, which are not stored either: the decoder reads zeros past the end
//   * the encoder finds the cheapest sequence of literals and matches in windows of CHUNK
//     bytes, with the prices of the model as it is at the start of each window (the SDK's
//     optimal parse, simplified)

const MIN_LEN = 2, MAX_LEN = 273;
const TOP = 2 ** 24;
const CHUNK = 256;      // bytes parsed together with one set of prices
const NICE = 48;        // a match longer than this is only tried at its full length
const DEPTH = 64;       // candidates looked at in the hash chain

const nextLit = (s) => (s < 4 ? 0 : s < 10 ? s - 3 : s - 6);
const nextMatch = (s) => (s < 7 ? 7 : 10);
const nextRep = (s) => (s < 7 ? 8 : 11);
const nextShortRep = (s) => (s < 7 ? 9 : 11);
const LIT = 0, MATCH = 1, REP = 2, SHORT_REP = 3;

function posSlot(d) {
  if (d < 4) return d;
  const n = 31 - Math.clz32(d);
  return (n << 1) | ((d >>> (n - 1)) & 1);
}

function model() {
  const p = (n) => new Uint16Array(n).fill(1024);
  const len = () => ({ choice: p(2), low: p(8), mid: p(8), high: p(256) });
  return {
    isMatch: p(12), isRep: p(12), g0: p(12), g1: p(12), g2: p(12), long0: p(12),
    lit: p(0x300), slot: p(4 * 64), special: p(114), align: p(16), len: len(), repLen: len(),
  };
}

////////////////////////////////////////////////////////////////////////////////////////////
// coders: the encoder, and a counter of the bits the encoder would write

class RangeEncoder {
  constructor() { this.low = 0; this.range = 0xFFFFFFFF; this.cache = 0; this.cacheSize = 1; this.out = []; }
  bit(probs, i, b) {
    const p = probs[i], bound = (this.range >>> 11) * p;
    if (b) { this.low += bound; this.range -= bound; probs[i] = p - (p >> 5); }
    else { this.range = bound; probs[i] = p + ((2048 - p) >> 5); }
    while (this.range < TOP) { this.range *= 256; this.shiftLow(); }
  }
  direct(v, n) {
    while (n--) {
      this.range = this.range >>> 1;
      if ((v >>> n) & 1) this.low += this.range;
      while (this.range < TOP) { this.range *= 256; this.shiftLow(); }
    }
  }
  shiftLow() {
    if (this.low < 0xFF000000 || this.low >= 2 ** 32) {
      const carry = this.low >= 2 ** 32 ? 1 : 0;
      let c = this.cache;
      do { this.out.push((c + carry) & 0xFF); c = 0xFF; } while (--this.cacheSize);
      this.cache = (this.low >>> 24) & 0xFF;
    }
    this.cacheSize++;
    this.low = (this.low & 0xFFFFFF) * 256;
  }
  finish() {
    // any value in [low, low + range) decodes the same: take the one with most trailing zeros
    for (let k = 32; k > 0; k--) {
      const m = 2 ** k, v = Math.ceil(this.low / m) * m;
      if (v < this.low + this.range) { this.low = v; break; }
    }
    for (let i = 0; i < 5; i++) this.shiftLow();
    let end = this.out.length;
    while (end > 1 && this.out[end - 1] === 0) end--;
    return this.out.slice(1, end);
  }
}

// cost of a bit in bits, by probability of a 0 (of 2048)
const COST = new Float64Array(2049);
for (let p = 1; p <= 2048; p++) COST[p] = -Math.log2(p / 2048);

class PriceCounter {
  constructor() { this.total = 0; }
  bit(probs, i, b) { this.total += COST[b ? 2048 - probs[i] : probs[i]]; }
  direct(v, n) { this.total += n; }
}
const bitPrice = (probs, i, b) => COST[b ? 2048 - probs[i] : probs[i]];

////////////////////////////////////////////////////////////////////////////////////////////
// the parts of a packet, written to an encoder or a price counter

function encTree(c, probs, off, bits, sym) {
  let m = 1;
  for (let i = bits - 1; i >= 0; i--) { const b = (sym >>> i) & 1; c.bit(probs, off + m, b); m = (m << 1) | b; }
}
function encRev(c, probs, off, bits, sym) {
  let m = 1;
  for (let i = 0; i < bits; i++) { const b = sym & 1; sym >>>= 1; c.bit(probs, off + m, b); m = (m << 1) | b; }
}
// match: the byte at rep0 when the packet before was a match, else -1
function encLiteral(c, probs, sym, match) {
  sym |= 0x100;
  if (match < 0) {
    do { c.bit(probs, sym >>> 8, (sym >>> 7) & 1); sym <<= 1; } while (sym < 0x10000);
    return;
  }
  let offs = 0x100;
  do {
    match <<= 1;
    c.bit(probs, offs + (match & offs) + (sym >>> 8), (sym >>> 7) & 1);
    sym <<= 1;
    offs &= ~(match ^ sym);
  } while (sym < 0x10000);
}
function encLen(c, L, l) {
  if (l < 8) { c.bit(L.choice, 0, 0); encTree(c, L.low, 0, 3, l); return; }
  c.bit(L.choice, 0, 1);
  if (l < 16) { c.bit(L.choice, 1, 0); encTree(c, L.mid, 0, 3, l - 8); return; }
  c.bit(L.choice, 1, 1);
  encTree(c, L.high, 0, 8, l - 16);
}
function encDist(c, M, d, len) {
  const slot = posSlot(d);
  encTree(c, M.slot, Math.min(len - MIN_LEN, 3) * 64, 6, slot);
  if (slot < 4) return;
  const bits = (slot >>> 1) - 1, base = (2 | (slot & 1)) << bits, red = d - base;
  if (slot < 14) { encRev(c, M.special, base - slot - 1, bits, red); return; }
  c.direct(red >>> 4, bits - 4);
  encRev(c, M.align, 0, 4, red & 15);
}
// the flags that say which of the four rep distances a rep match uses
function encRepFlags(c, M, s, k) {
  c.bit(M.isMatch, s, 1); c.bit(M.isRep, s, 1);
  if (k === 0) { c.bit(M.g0, s, 0); c.bit(M.long0, s, 1); return; }
  c.bit(M.g0, s, 1);
  if (k === 1) { c.bit(M.g1, s, 0); return; }
  c.bit(M.g1, s, 1); c.bit(M.g2, s, k - 2);
}

////////////////////////////////////////////////////////////////////////////////////////////
// match finder: hash chains over three bytes, and the last place of each pair of bytes

function matchFinder(data) {
  const n = data.length, head2 = new Int32Array(1 << 16).fill(-1), head3 = new Int32Array(1 << 16).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const same = (j, i, limit) => { let l = 0; while (l < limit && data[j + l] === data[i + l]) l++; return l; };
  // fills `out` with pairs (length, distance - 1), longer ones later; call once for each i, in order
  return (i, out) => {
    out.length = 0;
    if (i + 1 >= n) return;
    const limit = Math.min(MAX_LEN, n - i), k2 = (data[i] << 8) | data[i + 1];
    let best = 1;
    const j2 = head2[k2];
    head2[k2] = i;
    if (j2 >= 0) { best = same(j2, i, limit); out.push(best, i - j2 - 1); }
    if (i + 2 >= n) return;
    const k3 = Math.imul((k2 << 8) | data[i + 2], 0x9E3779B1) >>> 16;
    let j = head3[k3];
    prev[i] = j;
    head3[k3] = i;
    for (let depth = DEPTH; j >= 0 && depth > 0 && best < limit; depth--, j = prev[j]) {
      if (data[j + best] !== data[i + best]) continue;
      const l = same(j, i, limit);
      if (l > best) { best = l; out.push(l, i - j - 1); }
    }
  };
}

////////////////////////////////////////////////////////////////////////////////////////////
// compress

function writeVarint(out, x) {
  while (x >= 128) { out.push((x & 127) | 128); x = Math.floor(x / 128); }
  out.push(x);
}

// bytes (Uint8Array) -> Uint8Array: the size as a varint, then the LZMA stream
export function compress(data) {
  const head = [];
  writeVarint(head, data.length);
  if (!data.length) return Uint8Array.from(head);

  const n = data.length, M = model(), rc = new RangeEncoder(), find = matchFinder(data), cand = [];
  let state = 0;
  const reps = [0, 0, 0, 0];

  // one node for each position of a window: the cheapest way there and the coder's state on it
  const price = new Float64Array(CHUNK + 1), from = new Int32Array(CHUNK + 1), kind = new Uint8Array(CHUNK + 1);
  const arg = new Int32Array(CHUNK + 1), len = new Int32Array(CHUNK + 1), st = new Uint8Array(CHUNK + 1);
  const rp = new Int32Array(4 * (CHUNK + 1));
  const lenPrice = new Float64Array(MAX_LEN + 1), repLenPrice = new Float64Array(MAX_LEN + 1);
  const pc = new PriceCounter();
  const priceOf = (fn) => { pc.total = 0; fn(pc); return pc.total; };
  const distPrice = new Float64Array(4);

  for (let p0 = 0; p0 < n;) {
    const end = Math.min(n, p0 + CHUNK), size = end - p0;
    for (let l = MIN_LEN; l <= MAX_LEN; l++) {
      lenPrice[l] = priceOf((c) => encLen(c, M.len, l - MIN_LEN));
      repLenPrice[l] = priceOf((c) => encLen(c, M.repLen, l - MIN_LEN));
    }
    price.fill(Infinity, 0, size + 1);
    price[0] = 0; st[0] = state;
    for (let k = 0; k < 4; k++) rp[k] = reps[k];
    const relax = (j, t, p, kd, a, l) => {
      if (p >= price[t]) return;
      price[t] = p; from[t] = j; kind[t] = kd; arg[t] = a; len[t] = l;
    };

    for (let j = 0; j < size; j++) {
      const i = p0 + j;
      find(i, cand);
      if (j > 0) {
        // the state and the rep distances on this node, from the step that reached it
        const f = from[j], s0 = st[f], r = 4 * j, q = 4 * f;
        if (kind[j] === LIT) { st[j] = nextLit(s0); for (let k = 0; k < 4; k++) rp[r + k] = rp[q + k]; }
        else if (kind[j] === SHORT_REP) { st[j] = nextShortRep(s0); for (let k = 0; k < 4; k++) rp[r + k] = rp[q + k]; }
        else if (kind[j] === MATCH) { st[j] = nextMatch(s0); rp[r] = arg[j]; for (let k = 1; k < 4; k++) rp[r + k] = rp[q + k - 1]; }
        else {
          const a = arg[j];
          st[j] = nextRep(s0); rp[r] = rp[q + a];
          for (let k = 1, m = 0; k < 4; k++, m++) { if (m === a) m++; rp[r + k] = rp[q + m]; }
        }
      }
      const s = st[j], r = 4 * j, base = price[j], limit = Math.min(MAX_LEN, end - i);

      const match = s < 7 ? -1 : data[i - rp[r] - 1];
      relax(j, j + 1, base + bitPrice(M.isMatch, s, 0) + priceOf((c) => encLiteral(c, M.lit, data[i], match)), LIT, 0, 1);

      for (let k = 0; k < 4; k++) {
        const src = i - rp[r + k] - 1;
        if (src < 0) continue;
        let l = 0;
        while (l < limit && data[src + l] === data[i + l]) l++;
        if (k === 0 && l >= 1) {
          const p = base + bitPrice(M.isMatch, s, 1) + bitPrice(M.isRep, s, 1) + bitPrice(M.g0, s, 0) + bitPrice(M.long0, s, 0);
          relax(j, j + 1, p, SHORT_REP, 0, 1);
        }
        if (l < MIN_LEN) continue;
        const flags = base + priceOf((c) => encRepFlags(c, M, s, k));
        for (let m = MIN_LEN; m <= l; m++) {
          if (m > NICE && m < l) m = l;
          relax(j, j + m, flags + repLenPrice[m], REP, k, m);
        }
      }

      const flags = base + bitPrice(M.isMatch, s, 1) + bitPrice(M.isRep, s, 0);
      let done = 1;
      for (let c = 0; c < cand.length; c += 2) {
        const l = Math.min(cand[c], limit), d = cand[c + 1];
        if (l <= done) continue;
        for (let ls = 0; ls < 4; ls++) distPrice[ls] = priceOf((pcc) => encDist(pcc, M, d, ls + MIN_LEN));
        for (let m = done + 1; m <= l; m++) {
          if (m > NICE && m < l) m = l;
          relax(j, j + m, flags + lenPrice[m] + distPrice[Math.min(m - MIN_LEN, 3)], MATCH, d, m);
        }
        done = l;
      }
    }

    // walk back from the end of the window, then write the packets in order
    const path = [];
    for (let t = size; t > 0; t = from[t]) path.push(t);
    for (let x = path.length - 1; x >= 0; x--) {
      const t = path[x], i = p0 + from[t];
      if (kind[t] === LIT) {
        rc.bit(M.isMatch, state, 0);
        encLiteral(rc, M.lit, data[i], state < 7 ? -1 : data[i - reps[0] - 1]);
        state = nextLit(state);
      } else if (kind[t] === SHORT_REP) {
        rc.bit(M.isMatch, state, 1); rc.bit(M.isRep, state, 1); rc.bit(M.g0, state, 0); rc.bit(M.long0, state, 0);
        state = nextShortRep(state);
      } else if (kind[t] === REP) {
        const k = arg[t], d = reps[k];
        encRepFlags(rc, M, state, k);
        encLen(rc, M.repLen, len[t] - MIN_LEN);
        reps.splice(k, 1); reps.unshift(d);
        state = nextRep(state);
      } else {
        rc.bit(M.isMatch, state, 1); rc.bit(M.isRep, state, 0);
        encLen(rc, M.len, len[t] - MIN_LEN);
        encDist(rc, M, arg[t], len[t]);
        reps.pop(); reps.unshift(arg[t]);
        state = nextMatch(state);
      }
    }
    p0 = end;
  }
  const body = rc.finish(), out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

////////////////////////////////////////////////////////////////////////////////////////////
// decompress

class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf; this.pos = pos; this.range = 0xFFFFFFFF; this.code = 0;
    for (let i = 0; i < 4; i++) this.code = this.code * 256 + this.byte();
  }
  byte() { return this.pos < this.buf.length ? this.buf[this.pos++] : 0; }
  normalize() {
    if (this.range >= TOP) return;
    this.range *= 256;
    this.code = (this.code * 256 + this.byte()) % 2 ** 32;
  }
  bit(probs, i) {
    const p = probs[i], bound = (this.range >>> 11) * p;
    let b = 0;
    if (this.code < bound) { this.range = bound; probs[i] = p + ((2048 - p) >> 5); }
    else { this.code -= bound; this.range -= bound; probs[i] = p - (p >> 5); b = 1; }
    this.normalize();
    return b;
  }
  direct(n) {
    let v = 0;
    while (n--) {
      this.range = this.range >>> 1;
      let b = 0;
      if (this.code >= this.range) { this.code -= this.range; b = 1; }
      v = v * 2 + b;
      this.normalize();
    }
    return v;
  }
}

function decTree(rd, probs, off, bits) {
  let m = 1;
  for (let i = 0; i < bits; i++) m = (m << 1) | rd.bit(probs, off + m);
  return m - (1 << bits);
}
function decRev(rd, probs, off, bits) {
  let m = 1, sym = 0;
  for (let i = 0; i < bits; i++) { const b = rd.bit(probs, off + m); m = (m << 1) | b; sym |= b << i; }
  return sym;
}
function decLiteral(rd, probs, match) {
  let sym = 1;
  if (match < 0) {
    while (sym < 0x100) sym = (sym << 1) | rd.bit(probs, sym);
    return sym & 0xFF;
  }
  let offs = 0x100;
  while (sym < 0x100) {
    match <<= 1;
    const mb = match & offs, b = rd.bit(probs, offs + mb + sym);
    sym = (sym << 1) | b;
    offs &= b ? mb : ~mb;
  }
  return sym & 0xFF;
}
function decLen(rd, L) {
  if (!rd.bit(L.choice, 0)) return decTree(rd, L.low, 0, 3);
  if (!rd.bit(L.choice, 1)) return 8 + decTree(rd, L.mid, 0, 3);
  return 16 + decTree(rd, L.high, 0, 8);
}
function decDist(rd, M, len) {
  const slot = decTree(rd, M.slot, Math.min(len - MIN_LEN, 3) * 64, 6);
  if (slot < 4) return slot;
  const bits = (slot >>> 1) - 1, base = (2 | (slot & 1)) * 2 ** bits;
  if (slot < 14) return base + decRev(rd, M.special, base - slot - 1, bits);
  return base + rd.direct(bits - 4) * 16 + decRev(rd, M.align, 0, 4);
}

// what compress() made -> the bytes. Throws on a size above maxSize and on a broken stream.
export function decompress(src, maxSize = 1 << 24) {
  let size = 0, pos = 0;
  for (let mul = 1; ; mul *= 128) {
    if (pos >= src.length || mul > 2 ** 35) throw new Error('bad LZMA size');
    const b = src[pos++];
    size += (b & 127) * mul;
    if (b < 128) break;
  }
  if (size > maxSize) throw new Error('LZMA data too large');
  const out = new Uint8Array(size);
  if (!size) return out;

  const rd = new RangeDecoder(src, pos), M = model(), reps = [0, 0, 0, 0];
  let s = 0, o = 0;
  while (o < size) {
    if (!rd.bit(M.isMatch, s)) {
      out[o] = decLiteral(rd, M.lit, s < 7 ? -1 : out[o - reps[0] - 1]);
      o++; s = nextLit(s);
      continue;
    }
    let len;
    if (rd.bit(M.isRep, s)) {
      if (o === 0) throw new Error('broken LZMA data');
      if (!rd.bit(M.g0, s)) {
        if (!rd.bit(M.long0, s)) { out[o] = out[o - reps[0] - 1]; o++; s = nextShortRep(s); continue; }
      } else {
        let d;
        if (!rd.bit(M.g1, s)) d = reps[1];
        else if (!rd.bit(M.g2, s)) { d = reps[2]; reps[2] = reps[1]; }
        else { d = reps[3]; reps[3] = reps[2]; reps[2] = reps[1]; }
        reps[1] = reps[0]; reps[0] = d;
      }
      len = decLen(rd, M.repLen) + MIN_LEN; s = nextRep(s);
    } else {
      reps[3] = reps[2]; reps[2] = reps[1]; reps[1] = reps[0];
      len = decLen(rd, M.len) + MIN_LEN; s = nextMatch(s);
      reps[0] = decDist(rd, M, len);
    }
    if (reps[0] >= o) throw new Error('broken LZMA data');
    for (const e = Math.min(size, o + len); o < e; o++) out[o] = out[o - reps[0] - 1];
  }
  return out;
}
