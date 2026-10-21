import { Scene, hsv, clamp, mix, smooth, lerpC, shade, addC, pack, ramp, noise, fbm, hash, rng } from './kit.mjs';
export const ART = {};
const C = (h) => parseInt(h.replace('#', ''), 16);
const W = 64, ROWS = 20;

// ───────────────────────── starry night ─────────────────────────
ART.starry = {
  meta: { name: 'starry-night', category: 'art', note: 'Van Gogh’s sky, swirling: the double gyre turns, stars pulse, the cypress sways over a lit village', cols: W, rows: ROWS, fps: 15 },
  make() {
    const sky = ramp([[0, C('#0b1d4d')], [0.35, C('#1c4a9a')], [0.6, C('#3d7fd0')], [0.8, C('#9fc3e8')], [1, C('#f3e9a0')]]);
    const stars = [[9, 6, 3.2], [20, 4, 2.4], [31, 9, 2.8], [46, 5, 2.6], [38, 14, 2], [16, 15, 1.8], [52, 20, 1.8]];
    const gy = [[26, 14, 11, 1], [44, 17, 8, -1]];
    return (t) => {
      const s = new Scene(W, ROWS);
      s.fill((X, Y) => {
        let wx = X, wy = Y;
        for (const [cx, cy, R, dir] of gy) {
          const dx = wx - cx, dy = wy - cy, d = Math.hypot(dx, dy), k = Math.exp(-(d * d) / (R * R * 1.6));
          const a = dir * (1.4 * k) + t * 0.12 * dir * k, c = Math.cos(a), sn = Math.sin(a);
          wx = cx + dx * c - dy * sn; wy = cy + dx * sn + dy * c;
        }
        const band = 0.5 + 0.5 * Math.sin(fbm(wx * 0.12, wy * 0.22, 3, 3) * 14 + wy * 0.5 + t * 0.5);
        const v = clamp(0.03 + band * 0.55 + (1 - clamp(Y / 40)) * 0.1 + fbm(wx * 0.08 + t * 0.03, wy * 0.1, 7, 3) * 0.35);
        return sky(v);
      });
      s.region(0, 28, W, 40, (x, y) => { const h = 33 + Math.sin(x * 0.18) * 1.5 + Math.sin(x * 0.07 + 1) * 2; return y > h ? lerpC(C('#1a2a44'), C('#0d1626'), clamp((y - h) / 6)) : null; });
      for (const [bx, bw, bh] of [[36, 5, 3], [42, 4, 4], [47, 6, 3], [53, 4, 4], [58, 5, 3]]) {
        s.region(bx, 38 - bh, bx + bw, 38, () => C('#0f1a2c'));
        if (hash(bx, 1) > 0.2) { s.set(bx + 1, 38 - bh + 1, C('#ffd45e')); if (bw > 4) s.set(bx + 3, 38 - bh + 1, C('#ffd45e')); }
      }
      s.line(44.5, 28, 44.5, 34, C('#101a2a'), 1.6);
      for (let y = 6; y < 40; y++) {
        const p = (y - 6) / 34, w = Math.sin(Math.PI * Math.pow(p, 0.7)) * 5.2 + 0.5, sway = Math.sin(t * 0.8 + y * 0.22) * (1.1 - p) * 0.9 + Math.sin(y * 0.4) * 0.7;
        for (let x = Math.floor(11 - w + sway); x <= 11 + w + sway; x++) s.set(x, y, lerpC(C('#06130b'), C('#1c3a22'), noise(x * 0.5, y * 0.6, 5) * 0.6 + (x < 11 + sway ? 0 : 0.15)));
      }
      const mx = 56, my = 7;
      for (let r = 5; r < 9; r++) for (let a = 0; a < 40; a++) { const th = a / 40 * 6.283; s.glow(mx + Math.cos(th) * r, my + Math.sin(th) * r * 0.9, C('#b9a85a'), (1 - (r - 5) / 4) * 0.12); }
      s.disc(mx, my, 4.5, C('#fff0a0'), 0.7); s.disc(mx + 2, my - 1, 4, sky(0.78), 0.7);
      for (const [sx, sy, sr] of stars) {
        const rr = sr * (0.75 + 0.25 * Math.sin(t * 2 + sx));
        for (let a = 0; a < 6.283; a += 0.18) for (const k of [1.4, 2.1]) s.glow(sx + Math.cos(a) * rr * k, sy + Math.sin(a) * rr * k * 0.9, C('#e8d56a'), k === 1.4 ? 0.45 : 0.25);
        s.disc(sx, sy, rr * 0.7, C('#fff7b8'), 0.6);
      }
      return s.frame();
    };
  },
};

// ───────────────────────── the great wave ─────────────────────────
ART.wave = {
  meta: { name: 'great-wave', category: 'art', note: 'Hokusai’s wave rising and curling, foam fingers reaching, Fuji small and still behind', cols: W, rows: ROWS, fps: 15 },
  make() {
    const blues = [C('#0b2a5a'), C('#16407f'), C('#2f67a8'), C('#6a9fcf')];
    return (t) => {
      const s = new Scene(W, ROWS), rise = Math.sin(t / 15 * Math.PI * 2 - 0.6) * 0.5 + 0.5;
      s.fill((x, y) => lerpC(C('#f6e9c3'), C('#e3c98f'), y / 40));
      for (let y = 2; y < 14; y += 3) for (let x = 0; x < W; x++) if (noise(x * 0.07 + y, y * 0.4, 2) > 0.6) s.blend(x, y, C('#d8b57a'), 0.5);
      for (let x = 0; x < W; x++) { const h = 27 - Math.max(0, 14 - Math.abs(x - 46) * 0.5); for (let y = Math.floor(h); y < 32; y++) s.set(x, y, y < h + 3 && Math.abs(x - 46) < 6 ? C('#f4f0e6') : C('#4a6a8c')); }
      for (let x = 0; x < W; x++) { const h = 32 + Math.sin(x * 0.4 + t * 1.2) * 0.8; for (let y = Math.floor(h); y < 40; y++) s.set(x, y, lerpC(C('#1c4a86'), C('#0b2a5a'), (y - 30) / 10)); }
      const cx = 27 + Math.sin(t * 0.4), cy = 14 - rise * 2.5, R1 = 6, R2 = 13.5;
      s.region(0, 0, W, 40, (x, y) => {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
        const face = x <= cx - 1 && y > cy + 3 + (cx - x) * 0.55;                    // the swell climbing up the left
        const hollow = d < R1 && th > -2.55 && th < 0.5 && x > cx - 4;                // the tube under the crest
        const crest = d < R2 && th < 0.35 && th > -Math.PI && !hollow;               // the thick, hooked crest
        const claw = x > cx && d < R2 + 1 && d > R1 && th >= 0.35 && th < 1.0 && y < cy + R2 * 0.8 + 3 && false;
        if (!(face || crest)) return null;
        const k = clamp((d - R1) / (R2 - R1)), n = fbm(x * 0.3, y * 0.45, 9, 3);
        let c = lerpC(blues[1], blues[0], clamp((y - cy) / 26 + (1 - k) * 0.5));
        if (crest && k > 0.62 + n * 0.25) c = lerpC(blues[2], blues[3], clamp((k - 0.62) * 2));   // sunlit back of the crest
        else if ((x + y * 1.6 + t * 2) % 7 < 0.9 && !crest) c = blues[2];                         // streaks on the face
        return c;
      });
      s.region(0, 0, W, 40, (x, y) => { const d = Math.hypot(x - cx, y - cy), th = Math.atan2(y - cy, x - cx); return d < R1 && th > -2.55 && th < 0.5 && x > cx - 4 ? lerpC(C('#cfe0ea'), C('#f3e9c9'), clamp((cy + R1 - y) / (2 * R1)) * 0.3) : null; });
      for (let i = 0; i < 25; i++) {
        const th = -3.0 + i * 0.14, wob = Math.sin(t * 3 + i * 1.7) * 0.5, rr = R2 + 0.3 + wob, fx = cx + Math.cos(th) * rr, fy = cy + Math.sin(th) * rr;
        s.disc(fx, fy, 0.9 + (i % 3) * 0.35, C('#fbf7ee')); s.set(fx + Math.cos(th) * 1.5, fy + Math.sin(th) * 1.5 + 0.5 * wob, C('#fbf7ee'));
      }
      const r = rng(4);
      for (let i = 0; i < 36; i++) { const a = -2.4 + r() * 2.2, d0 = R2 + 1 + r() * 6, ph = (t * 0.8 + i * 0.37) % 1; s.set(cx + Math.cos(a) * (d0 + ph * 6), cy + Math.sin(a) * (d0 + ph * 6) + ph * ph * 8, C('#fbf7ee')); }
      for (const bx of [44, 56]) { const by = 36 + Math.sin(t * 1.3 + bx) * 0.8; s.line(bx - 3, by, bx + 3, by, C('#a8672d'), 1.2); s.line(bx - 3, by, bx - 4, by - 1.2, C('#a8672d')); }
      return s.frame();
    };
  },
};

// ───────────────────────── the scream ─────────────────────────
ART.scream = {
  meta: { name: 'the-scream', category: 'art', note: 'Munch’s blood-orange sky undulating, the bridge, the figure holding its face', cols: W, rows: ROWS, fps: 15 },
  make() {
    const sk = ramp([[0, C('#e24a1c')], [0.25, C('#f08a24')], [0.45, C('#f7c35a')], [0.6, C('#c8503a')], [0.8, C('#2c4a78')], [1, C('#14284a')]]);
    return (t) => {
      const s = new Scene(W, ROWS);
      s.fill((x, y) => {
        const w = Math.sin(x * 0.17 + y * 0.35 - t * 1.6) * 2.5 + Math.sin(x * 0.07 - y * 0.2 + t * 0.9) * 3, band = Math.sin((y + w) * 0.55) * 0.5 + 0.5;
        return lerpC(sk((y + w) / 40), band > 0.5 ? C('#ffd37a') : C('#b8301c'), 0.18 + 0.1 * Math.sin(x * 0.3 + y * 0.5 + t));
      });
      s.region(0, 24, W, 40, (x, y) => (y > 27 + Math.sin(x * 0.2 + t * 0.8) * 1.5 + Math.sin(x * 0.45) * 0.6 ? lerpC(C('#274a7c'), C('#1a2e55'), (y - 27) / 13) : null));
      for (let x = 0; x < W; x++) s.line(x, 18 + x * 0.42 + Math.sin(x * 0.3 + t * 1.2) * 0.4, x + 1, 18.4 + x * 0.42, C('#2a1810'), 1.4);
      for (let x = 6; x < W; x += 7) s.line(x, 18 + x * 0.42, x, 25 + x * 0.42, C('#2a1810'), 1.2);
      s.region(0, 33, W, 40, (x, y) => (y > 33 + x * 0.05 ? C('#3a2415') : null));
      for (const px of [10, 14]) { const b = 18 + px * 0.42; s.line(px, b - 5, px, b, C('#0e0a18'), 1.4); s.disc(px, b - 6, 1, C('#0e0a18')); }
      const fx = 40 + Math.sin(t * 1.1) * 0.6, top = 11, sway = Math.sin(t * 1.5) * 0.8;
      for (let y = 22; y < 40; y++) { const k = (y - 22) / 18, w = 2.4 + k * 2.4, c = lerpC(C('#2d2142'), C('#0f0b1d'), k); for (let x = Math.floor(fx - w + sway * k); x <= fx + w + sway * k; x++) s.set(x, y, c); }
      s.disc(fx, top + 4, 4.2, C('#e9d3a0'), 0.6);
      for (let y = top + 8; y < top + 15; y++) for (let x = fx - 3; x <= fx + 3; x++) if (Math.hypot((x - fx) / 3.6, (y - (top + 8)) / 6.5) < 1) s.set(x, y, C('#e9d3a0'));
      s.disc(fx - 1.6, top + 3.5, 0.9, C('#1a1020')); s.disc(fx + 1.6, top + 3.5, 0.9, C('#1a1020'));
      const mo = 1.6 + Math.sin(t * 5) * 0.4;
      for (let y = top + 7; y < top + 7 + mo * 2.4; y++) for (let x = fx - 1; x <= fx + 1; x++) s.set(x, y, C('#2b1219'));
      for (const d of [-1, 1]) { s.line(fx + d * 4, top + 8, fx + d * 3.2, top + 5, C('#e9d3a0'), 1.4); s.disc(fx + d * 2.8, top + 5, 1.2, C('#e9d3a0')); }
      for (let k = 0; k < 8; k++) { const a = -0.6 + k * 0.17, r0 = 6 + ((t * 8 + k * 3) % 14); s.glow(fx + Math.cos(Math.PI + a) * r0, top + 6 + Math.sin(a) * r0 * 0.7, C('#ffe4a0'), 0.35 * (1 - r0 / 20)); }
      return s.frame();
    };
  },
};

// ───────────────────────── the persistence of memory ─────────────────────────
ART.memory = {
  meta: { name: 'persistence-of-memory', category: 'art', note: 'Dalí’s melting clocks sag over the dead tree and the golden dream-shore', cols: W, rows: ROWS, fps: 15 },
  make() {
    return (t) => {
      const s = new Scene(W, ROWS);
      s.fill((x, y) => (y < 26 ? lerpC(C('#7fa6c8'), C('#f6c98a'), smooth(0, 26, y)) : C('#b5632a')));
      s.region(44, 18, W, 40, (x, y) => (y > 18 + Math.sin(x * 0.3) * 0.5 ? lerpC(C('#9b5a2a'), C('#5a2e18'), (y - 18) / 20) : null));
      s.region(26, 24, 46, 28, (x, y) => lerpC(C('#2b4f7a'), C('#5c8fb8'), (y - 24) / 4 + Math.sin(x + t) * 0.05));
      s.region(0, 27, W, 40, (x, y) => lerpC(C('#d6893a'), C('#8a4a1e'), (y - 27) / 13 + 0.08 * Math.sin(x * 0.4 + y * 0.9)));
      s.line(8, 40, 9, 22, C('#2b1a10'), 3); s.line(9, 22, 20, 19, C('#2b1a10'), 2); s.line(9, 24, 2, 20, C('#2b1a10'), 1.6);
      const clock = (cx, cy, rx, ry, drip, ph, drape) => {
        for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
          const u = (x - cx) / rx; if (Math.abs(u) > 1) continue;
          const e = Math.sqrt(1 - u * u), top = drape ? cy - ry * 0.6 + (1 - e) * 2 : cy - ry * e;
          const bot = drape ? cy + ry * (0.9 + Math.max(0, u) * 2.3 * (0.8 + 0.2 * Math.sin(t * 0.8 + ph))) : cy + ry * e + drip * ry * (0.5 + 0.5 * Math.sin(u * 3 + ph + t * 0.6)) * (u > 0 ? 1 : 0.4);
          for (let y = Math.floor(top); y <= Math.ceil(bot); y++) {
            const rim = y - top < 1.1 || bot - y < 1.1 || Math.abs(u) > 0.9; s.set(x, y, rim ? C('#8a5a1c') : lerpC(C('#fbeeba'), C('#dcae4c'), clamp(0.5 * ((y - top) / (bot - top + 0.001)) + 0.3 * Math.abs(u))));
          }
        }
        for (let h = 0; h < 12; h++) { const a = h / 12 * 6.283; s.set(cx + Math.cos(a) * rx * 0.72, cy + (drape ? 1.5 : 0) + Math.sin(a) * ry * 0.62, C('#3a2410')); }
        const hy = cy + (drape ? 1.5 : 0), a1 = t * 0.3 + ph, a2 = t * 3.6 + ph;
        s.line(cx, hy, cx + Math.cos(a1) * rx * 0.45, hy + Math.sin(a1) * ry * 0.45, C('#2b1a10'), 1.2); s.line(cx, hy, cx + Math.cos(a2) * rx * 0.68, hy + Math.sin(a2) * ry * 0.6, C('#2b1a10'), 1);
      };
      clock(18, 21, 7, 4.2, 0, 0.5, true);
      clock(33, 32, 8.5, 4.4, 0.55, 1.2, false);
      clock(55, 36, 6, 3.4, 0.4, 2.4, false);
      s.disc(44, 34, 3.4, C('#d65a2a')); for (let i = 0; i < 6; i++) s.set(44 + Math.cos(i * 1.05) * 2.2, 34 + Math.sin(i * 1.05) * 2.2, C('#2b1a10'));
      const k = 0.5 + 0.5 * Math.sin(t * 0.4);
      for (let x = 24; x < 40; x++) for (let y = 33; y < 38; y++) if (Math.hypot((x - 31) / 8, (y - 36) / 2.8) < 1) s.blend(x, y, C('#e6a86a'), 0.45 + 0.25 * k);
      return s.frame();
    };
  },
};
export const SET = ART;
