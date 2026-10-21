import { Scene, Grid, hsv, clamp, mix, smooth, lerpC, shade, addC, ramp, noise, fbm, hash, rng, pack } from './kit.mjs';
export const OWN = {};
const W = 64, ROWS = 20, H = 40;

// ───────────────────────── jellyfish bloom ─────────────────────────
OWN.jelly = {
  meta: { name: 'jellyfish', category: 'creatures', note: 'a bloom of bioluminescent jellyfish pulsing up through the deep, trailing slow tentacles, marine snow falling past', cols: W, rows: ROWS, fps: 15 },
  make() {
    const J = Array.from({ length: 6 }, (_, i) => ({ x: 6 + i * 10.5 + hash(i, 1, 3) * 4, y0: hash(i, 2, 3) * 60, r: 4.5 + hash(i, 3, 3) * 4, hue: 0.45 + i * 0.13, sp: 2 + (i % 3), ph: hash(i, 4, 3) * 6.28 }));
    return (t) => {
      const s = new Scene(W, ROWS);
      s.fill((x, y) => lerpC(C('#021a2e'), C('#010512'), y / H));
      for (let i = 0; i < 40; i++) { const u = (t * 0.03 * (1 + hash(i, 1, 9)) + hash(i, 2, 9)) % 1, x = hash(i, 3, 9) * W + Math.sin(t * 0.5 + i) * 1.2, y = u * H; s.glow(x, y, C('#4a7a9a'), 0.5); }
      for (const j of J.sort((a, b) => a.r - b.r)) {
        const y = ((j.y0 - t * j.sp * 2) % 60 + 60) % 60 - 12, pulse = 0.5 + 0.5 * Math.sin(t * 2.2 + j.ph), r = j.r * (0.9 + 0.2 * pulse), x = j.x + Math.sin(t * 0.6 + j.ph) * 2.5, hue = (j.hue + t * 0.01) % 1;
        for (let dy = -r - 1; dy <= r * 0.5 + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) {
          const e = Math.hypot(dx / r, dy / (r * 0.85)); if (e > 1 || dy > r * 0.15 + (Math.abs(dx) / r) ** 2 * r * 0.35) continue;
          const rib = 0.5 + 0.5 * Math.cos(Math.atan2(dy, dx) * 7), a = (0.18 + 0.55 * Math.pow(e, 3) + 0.14 * rib) * (0.8 + 0.2 * pulse);
          s.glow(x + dx, y + dy, hsv(hue, 0.65, 1), a);
        }
        for (let k = 0; k < 4; k++) s.glow(x + (k - 1.5) * r * 0.25, y - r * 0.1, hsv(hue + 0.08, 0.3, 1), 0.5);
        for (let k = 0; k < 9; k++) { const bx = x + (k - 4) * r * 0.22, len = r * (2.4 + 1.2 * hash(k, j.ph * 7 | 0, 4)); for (let u = 0; u < 1; u += 0.04) s.glow(bx + Math.sin(u * 6 + t * 1.6 + k + j.ph) * (1 + u * 2.2) * 0.9, y + r * 0.15 + u * len + pulse * 0.6, hsv(hue + 0.05 * u, 0.7, 1), 0.38 * (1 - u));  }
        for (let a = 0; a < 16; a++) { const th = a / 16 * 6.283; s.glow(x + Math.cos(th) * r * 1.9, y + Math.sin(th) * r * 1.4, hsv(hue, 0.7, 1), 0.04); }
      }
      return s.frame();
    };
  },
};
const C = (h) => parseInt(h.replace('#', ''), 16);

// ───────────────────────── wormhole ─────────────────────────
OWN.wormhole = {
  meta: { name: 'wormhole', category: 'generative', note: 'falling down a twisting tunnel: rings and spokes in shifting hue, glyphs thickening as the walls rush past', cols: W, rows: ROWS, fps: 20 },
  make() {
    const RAMP = ' ·:+*#%@@', cols = W, rows = ROWS;
    return (t) => {
      const g = new Grid(cols, rows), tw = Math.sin(t * 0.3) * 1.2;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) / (cols / 2) * 1.8, y = (r - (rows - 1) / 2) / (rows / 2) * 0.95, d = Math.hypot(x, y) + 0.001, a = Math.atan2(y, x) + tw * (1 / (d + 0.3)) * 0.4 + t * 0.2;
        const depth = 1 / d, v = depth * 1.1 + t * 1.6, u = a / Math.PI * 5, chk = (Math.floor(u) + Math.floor(v)) & 1, edge = Math.min(u - Math.floor(u), v - Math.floor(v)) < 0.1;
        const lum = clamp(clamp(d * 0.95) * (chk ? 0.95 : 0.22) + (edge ? 0.3 : 0));
        const ch = RAMP[Math.min(RAMP.length - 1, Math.floor(lum * RAMP.length))];
        if (ch !== ' ') g.put(c, r, ch, hsv(depth * 0.06 + a / 6.283 + t * 0.05 + (chk ? 0.5 : 0), 0.85 - (edge ? 0.35 : 0), 0.35 + 0.65 * lum));
      }
      g.put(31, 9, '✺', 0xffffff); g.put(32, 9, '✺', 0xffffff); g.put(31, 10, '·', 0xffe0ff); g.put(32, 10, '·', 0xffe0ff);
      return g.frame();
    };
  },
};
export const SET = OWN;
