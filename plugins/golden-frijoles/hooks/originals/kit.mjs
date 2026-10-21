// kit.mjs — shared helpers for colour pieces. A frame is { cols, rows, ch: string[], fg: number[], bg: number[] }
// (fg/bg are packed 0xRRGGBB per cell, -1 = the terminal's own).
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const pack = (r, g, b) => (clamp(r, 0, 255) << 16 | clamp(g, 0, 255) << 8 | clamp(b, 0, 255)) | 0;
export const rgb = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
export function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1; const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), u = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, u, p], [q, v, p], [p, v, u], [p, q, v], [u, p, v], [v, p, q]][i % 6];
  return pack(r * 255, g * 255, b * 255);
}
export const lerpC = (a, b, t) => { const x = rgb(a), y = rgb(b); return pack(mix(x[0], y[0], t), mix(x[1], y[1], t), mix(x[2], y[2], t)); };
export const shade = (c, k) => { const x = rgb(c); return pack(x[0] * k, x[1] * k, x[2] * k); };
export const addC = (a, b, k = 1) => { const x = rgb(a), y = rgb(b); return pack(x[0] + y[0] * k, x[1] + y[1] * k, x[2] + y[2] * k); };
/** A palette from stops [[pos, 0xRRGGBB], …] sampled at t in 0..1. */
export const ramp = (stops) => (t) => {
  t = clamp(t); for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) return lerpC(stops[i - 1][1], stops[i][1], (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0] || 1));
  return stops[stops.length - 1][1];
};
export const rng = (a) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
export const hash = (x, y, s = 0) => { let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1); h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const ease = (t) => t * t * (3 - 2 * t);
export function noise(x, y, s = 0) { const i = Math.floor(x), j = Math.floor(y), u = ease(x - i), v = ease(y - j); const a = hash(i, j, s), b = hash(i + 1, j, s), c = hash(i, j + 1, s), d = hash(i + 1, j + 1, s); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
export function fbm(x, y, s = 0, o = 4) { let a = 0.5, f = 1, t = 0; for (let i = 0; i < o; i++) { t += a * noise(x * f, y * f, s + i); f *= 2; a *= 0.5; } return t; }

/** Glyph grid: put(x, y, ch, fg, bg). */
export class Grid {
  constructor(cols, rows) { this.cols = cols; this.rows = rows; this.ch = new Array(cols * rows).fill(' '); this.fg = new Int32Array(cols * rows).fill(-1); this.bg = new Int32Array(cols * rows).fill(-1); }
  put(x, y, ch, fg = -1, bg = -1) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return; const i = y * this.cols + x; this.ch[i] = ch; this.fg[i] = fg; if (bg !== -2) this.bg[i] = bg; }
  text(x, y, s, fg) { [...s].forEach((c, k) => this.put(x + k, y, c, fg)); }
  frame() { const o = []; for (let r = 0; r < this.rows; r++) o.push(this.ch.slice(r * this.cols, (r + 1) * this.cols).join('')); return { cols: this.cols, rows: this.rows, ch: o, fg: Array.from(this.fg), bg: Array.from(this.bg) }; }
}

/** Half-block pixels: W = cols, H = rows × 2. Glyphs can be laid over it. */
export class Scene extends Grid {
  constructor(cols, rows) { super(cols, rows); this.W = cols; this.H = rows * 2; this.px = new Int32Array(this.W * this.H).fill(0); this.over = new Array(cols * rows).fill(null); }
  fill(fn) { for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) this.px[y * this.W + x] = fn(x, y); }
  get(x, y) { return this.px[y * this.W + x]; }
  set(x, y, c) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.W || y >= this.H) return; this.px[y * this.W + x] = c; }
  blend(x, y, c, a) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.W || y >= this.H) return; const i = y * this.W + x; this.px[i] = lerpC(this.px[i], c, a); }
  glow(x, y, c, k) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.W || y >= this.H) return; const i = y * this.W + x; this.px[i] = addC(this.px[i], c, k); }
  /** Pixels are square-ish; this paints with `fn(dx, dy) → colour | null` over a box. */
  region(x0, y0, x1, y1, fn) { for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(this.H - 1, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(this.W - 1, Math.ceil(x1)); x++) { const c = fn(x, y); if (c != null) this.px[y * this.W + x] = c; } }
  disc(cx, cy, r, c, soft = 0) { this.region(cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1, (x, y) => { const d = Math.hypot(x - cx, y - cy); if (d > r + soft) return null; return soft ? lerpC(c, this.get(x, y), smooth(r - soft, r + soft, d)) : c; }); }
  line(x0, y0, x1, y1, c, w = 1) { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1; for (let i = 0; i <= n; i++) { const t = i / n; const x = mix(x0, x1, t), y = mix(y0, y1, t); if (w <= 1) this.set(x, y, c); else this.disc(x, y, w / 2, c); } }
  glyph(x, y, ch, fg) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return; this.over[y * this.cols + x] = [ch, fg]; }
  frame() {
    const o = [], fg = [], bg = [];
    for (let r = 0; r < this.rows; r++) { let s = ''; for (let c = 0; c < this.cols; c++) {
      const i = r * this.cols + c, top = this.px[(2 * r) * this.W + c], bot = this.px[(2 * r + 1) * this.W + c], ov = this.over[i] || (this.ch[i] !== ' ' ? [this.ch[i], this.fg[i]] : null);
      if (ov) { s += ov[0]; fg.push(ov[1]); bg.push(lerpC(top, bot, 0.5)); this.over[i] = null; } else { s += '▀'; fg.push(top); bg.push(bot); }
    } o.push(s); }
    this.ch.fill(' ');
    return { cols: this.cols, rows: this.rows, ch: o, fg, bg };
  }
}

/** Braille layer on a Grid: 2×4 dots per cell, one colour per cell (the latest wins). */
export class Dots {
  static BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
  constructor(cols, rows) { this.cols = cols; this.rows = rows; this.W = cols * 2; this.H = rows * 4; this.m = new Uint8Array(cols * rows); this.c = new Int32Array(cols * rows).fill(-1); }
  dot(x, y, c) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.W || y >= this.H) return; const i = (y >> 2) * this.cols + (x >> 1); this.m[i] |= Dots.BIT[y & 3][x & 1]; this.c[i] = c; }
  into(g) { for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) { const i = r * this.cols + c; if (this.m[i]) g.put(c, r, String.fromCharCode(0x2800 + this.m[i]), this.c[i]); } }
}
