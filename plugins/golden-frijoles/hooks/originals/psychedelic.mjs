import { Grid, Dots, hsv, clamp, rng, noise, pack, shade } from './kit.mjs';
export const PSY = {};

// ───────────────────────── lorenz ─────────────────────────
PSY.lorenz = {
  meta: { name: 'lorenz', category: 'generative', note: 'two Lorenz butterflies, a hair apart at the start, drift into different worlds — braille dots, hue along the path', cols: 64, rows: 20, fps: 20 },
  make() {
    const N = 7000, run = (e) => { let x = 1 + e, y = 1, z = 1; const p = []; for (let i = 0; i < N + 1500; i++) { const dx = 10 * (y - x), dy = x * (28 - z) - y, dz = x * y - (8 / 3) * z; x += dx * 0.005; y += dy * 0.005; z += dz * 0.005; if (i >= 1500) p.push([x, y, z]); } return p; };
    const A = run(0), B = run(0.0002), cols = 64, rows = 20, W = cols * 2, H = rows * 4, S = H / 54;
    return (t) => {
      const g = new Grid(cols, rows), d = new Dots(cols, rows), phase = (t / 30) % 1, head = Math.floor(phase * (N - 1)), len = Math.floor(1400 * Math.sqrt(Math.sin(Math.PI * phase)));
      const a = t * 0.28, ca = Math.cos(a), sa = Math.sin(a), at = (p) => [W / 2 + (p[0] * ca - p[1] * sa) * S, H - 2 - p[2] * S];
      for (const [P, h0] of [[B, 0.55], [A, 0.02]]) {
        for (let i = Math.max(0, head - len); i <= head; i++) { const [x, y] = at(P[i]), age = (head - i) / (len || 1); d.dot(x, y, hsv(h0 + i / 2600 + t / 30, 0.85 - 0.3 * (1 - age), 1)); }
        if (len > 0) { const [hx, hy] = at(P[head]); for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) d.dot(hx + ox, hy + oy, 0xffffff); }
      }
      d.into(g); return g.frame();
    };
  },
};

// ───────────────────────── spark ─────────────────────────
PSY.spark = {
  meta: { name: 'spark', category: 'generative', note: 'a spiral bloom of spinner glyphs, hue wheeling with the turn, a pulse swelling outward', cols: 64, rows: 20, fps: 20 },
  make() {
    const G = [' ', '·', '✢', '✳', '✶', '✻', '✽'], cols = 64, rows = 20, n = 340, R = rows / 2 - 0.6;
    return (t) => {
      const lv = new Array(cols * rows).fill(0), hu = new Array(cols * rows).fill(0), spin = t * (Math.PI * 2) / 30 * 2;
      for (let i = 1; i < n; i++) {
        const f = Math.sqrt(i / n), th = i * 2.39996323 + spin, x = Math.round(cols / 2 + Math.cos(th) * f * R * 2.15 - 0.5), y = Math.round(rows / 2 + Math.sin(th) * f * R - 0.5);
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const wave = 0.5 + 0.5 * Math.sin(f * 8 - t * 2.4 * (Math.PI / 2)), l = Math.min(6, Math.max(1, Math.round(1 + wave * (2.2 + 3.8 * (1 - f * 0.55))))), k = y * cols + x;
        if (l >= lv[k]) { lv[k] = l; hu[k] = th / (Math.PI * 2) + f * 0.6 + t * 0.03; }
      }
      const g = new Grid(cols, rows); for (let k = 0; k < lv.length; k++) if (lv[k]) g.put(k % cols, (k / cols) | 0, G[lv[k]], hsv(hu[k], 0.75 - lv[k] * 0.04, 0.45 + lv[k] * 0.092));
      return g.frame();
    };
  },
};

// ───────────────────────── ripples ─────────────────────────
PSY.ripples = {
  meta: { name: 'ripples', category: 'physics', note: 'drops on a pool of liquid light — rings interfere, the height picks the colour', cols: 64, rows: 20, fps: 20 },
  make() {
    const RAMP = ' ·:-=+*xX#@', cols = 64, rows = 20, P = 1.5, K = 20, h = (k, s) => noise(k * 7.1, s * 3.3, 4);
    const drops = Array.from({ length: K }, (_, k) => ({ t0: k * P, x: 4 + (noise(k * 1.7, 1, 9) * 0.5 + noise(k * 4.1, 2, 9) * 0.5) * (cols - 8), y: 2 + (noise(k * 2.3, 5, 3) * 0.5 + noise(k * 5.9, 7, 3) * 0.5) * (rows - 4) }));
    return (t) => {
      const g = new Grid(cols, rows);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        let v = 0, ph = 0;
        for (const d of drops) for (const w of [0, 30]) { const a = t - d.t0 + w; if (a < 0 || a > 7) continue; const dist = Math.hypot((c - d.x) / 2.1, r - d.y), front = a * 5.5, env = Math.exp(-a * 0.55) * clamp((front - dist) / 1.5 + 0.5) / (1 + dist * 0.25); const q = Math.cos(dist * 2.1 - a * 11) * env * 1.9; v += q; ph += dist * 0.05; }
        const b = clamp(0.5 + 0.5 * v), k = clamp((b - 0.4) / 0.6);
        if (k > 0.04) g.put(c, r, RAMP[Math.round(k * (RAMP.length - 1))], hsv(0.78 - b * 0.9 + t / 30, 0.9 - k * 0.4, 0.35 + k * 0.65));
      }
      return g.frame();
    };
  },
};

// ───────────────────────── flow ─────────────────────────
PSY.flow = {
  meta: { name: 'flow', category: 'generative', note: 'streaks of light riding a shifting current, hue = heading', cols: 64, rows: 20, fps: 20 },
  make() {
    const cols = 64, rows = 20, rand = rng(7), N = 170, DIR = ['─', '╲', '│', '╱'];
    const Pt = Array.from({ length: N }, () => ({ x: rand() * cols, y: rand() * rows, life: rand() * 60 }));
    const heat = new Float32Array(cols * rows), dir = new Uint8Array(cols * rows), hue = new Float32Array(cols * rows);
    const ang = (x, y, t) => 1.7 * (Math.sin(x * 0.085 + t * 0.35) + Math.cos(y * 0.2 - t * 0.27) + Math.sin((x * 0.5 + y) * 0.09 + t * 0.2));
    let last = -1;
    return (t) => {
      const steps = last < 0 ? 1 : Math.max(1, Math.round((t - last) * 20));
      if (t !== last) { last = t; for (let n = 0; n < steps; n++) { for (let i = 0; i < heat.length; i++) heat[i] *= 0.9;
        for (const p of Pt) { const a = ang(p.x, p.y * 2, t), dx = Math.cos(a) * 1.1, dy = Math.sin(a) * 0.55; p.x += dx; p.y += dy; p.life--;
          if (p.life <= 0 || p.x < 0 || p.y < 0 || p.x >= cols || p.y >= rows) { p.x = rand() * cols; p.y = rand() * rows; p.life = 30 + rand() * 50; continue; }
          const i = Math.floor(p.y) * cols + Math.floor(p.x); heat[i] = 1; dir[i] = Math.round(((Math.atan2(dy * 2, dx) / Math.PI) * 4 + 8) % 4) % 4; hue[i] = a / (Math.PI * 2) + t / 30; } } }
      const g = new Grid(cols, rows);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const k = r * cols + c, h = heat[k]; if (h > 0.18) g.put(c, r, h > 0.5 ? DIR[dir[k]] : '·', hsv(hue[k], 0.8, 0.35 + 0.65 * h)); }
      return g.frame();
    };
  },
};
export const SET = PSY;
