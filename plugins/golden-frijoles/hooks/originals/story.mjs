import { Scene, hsv, clamp, mix, smooth, lerpC, shade, addC, ramp, noise, fbm, hash, rng } from './kit.mjs';
export const STORY = {};
const C = (h) => parseInt(h.replace('#', ''), 16);
const W = 64, ROWS = 20, H = 40;

/** A little person: feet at (x, y), `h` tall. arm: [-1..1] raise of the near arm. */
function person(s, x, y, h, body, skin, arm = 0, step = 0) {
  s.line(x - 0.8 + step, y, x, y - h * 0.45, body, 1.4); s.line(x + 0.8 - step, y, x, y - h * 0.45, body, 1.4);
  s.line(x, y - h * 0.45, x, y - h * 0.8, body, 2);
  s.line(x, y - h * 0.75, x + 2.2, y - h * 0.75 - arm * h * 0.3, body, 1.2);
  s.line(x, y - h * 0.75, x - 2, y - h * 0.55, body, 1.2);
  s.disc(x, y - h * 0.92, h * 0.14 + 0.4, skin);
}

// ───────────────────────── jack: the beanstalk grows ─────────────────────────
STORY.beanstalk = {
  meta: { name: 'beanstalk', category: 'story', note: 'Jack and the Beanstalk: the bean cracks, the stalk climbs through the clouds, Jack follows it up to the castle', cols: W, rows: ROWS, fps: 15 },
  make() {
    const stars = Array.from({ length: 46 }, (_, i) => [hash(i, 1, 5) * W, hash(i, 2, 5) * 22, hash(i, 3, 5) * 6.28]);
    const path = (y, t) => 34 + Math.sin(y * 0.2 + 1) * 4 + Math.sin(y * 0.5) * 0.7 + Math.sin(t * 0.9 + y * 0.12) * 0.5;
    return (t) => {
      const s = new Scene(W, ROWS), ph = t % 30, grow = ph < 16 ? smooth(0, 16, ph) : ph < 26 ? 1 : 1 - smooth(26, 29.5, ph), topY = 37 - grow * 29;
      s.fill((x, y) => lerpC(C('#090d2b'), C('#4a2f7a'), clamp(y / 34)));
      for (const [x, y, p] of stars) { const k = 0.5 + 0.5 * Math.sin(t * 2.2 + p); s.set(x, y, lerpC(C('#1a1f4a'), C('#ffffff'), k * (y < 18 ? 1 : 0.4))); }
      s.disc(10, 7, 5.5, C('#fff4c8'), 0.7); for (const [dx, dy, r] of [[-1.5, -1, 1.3], [1.5, 1.5, 1], [0.5, -2, 0.8]]) s.disc(10 + dx, 7 + dy, r, C('#e3d49a'), 0.5);
      for (let r = 6; r < 12; r++) for (let a = 0; a < 50; a++) s.glow(10 + Math.cos(a / 50 * 6.28) * r, 7 + Math.sin(a / 50 * 6.28) * r * 0.9, C('#6a6aa8'), 0.06 * (1 - (r - 6) / 6));
      const cloud = (y0, amp, sp, light) => s.region(0, y0 - amp, W, y0 + amp + 4, (x, y) => { const n = fbm(x * 0.09 + t * sp, y * 0.25, 4, 3) * 1.4 - 0.2 + (y0 - y) * 0.05; return n > 0.6 ? lerpC(C('#6b5aa8'), light, clamp((n - 0.6) * 3)) : null; });
      cloud(11, 3, 0.04, C('#d9c6f2')); cloud(15, 2, 0.07, C('#b49ad8'));
      // the castle in the clouds, once the stalk arrives
      const ck = smooth(14, 18, ph) * (1 - smooth(26, 29, ph));
      if (ck > 0.02) { const col = lerpC(C('#25194a'), C('#150d30'), 0.3); for (const [x0, w, y0] of [[40, 5, 2], [45, 8, 4], [53, 5, 1], [58, 4, 4]]) { s.region(x0, y0 + 2, x0 + w, 11, () => lerpC(s.get(x0, y0 + 3), col, ck)); for (let b = x0; b < x0 + w; b += 2) s.set(b, y0 + 1.5, lerpC(s.get(b, y0 + 1), col, ck)); } for (const [wx, wy] of [[42, 6], [47, 7], [50, 7], [55, 4], [59, 7]]) s.set(wx, wy, lerpC(s.get(wx, wy), C('#ffd45e'), ck * (0.7 + 0.3 * Math.sin(t * 3 + wx)))); }
      // ground, hills, cottage
      s.region(0, 33, W, H, (x, y) => (y > 34 + Math.sin(x * 0.16) * 1.4 ? lerpC(C('#17381f'), C('#0a1a10'), (y - 34) / 6) : null));
      s.region(6, 30, 17, 37, () => C('#5a3b2a')); for (let i = 0; i < 6; i++) s.line(5 + i, 30 - i, 17 - i, 30 - i, C('#3b1f1c'), 1);
      s.region(9, 33, 12, 36, () => lerpC(C('#ffcf5a'), C('#ff9a3a'), 0.5 + 0.5 * Math.sin(t * 7)));
      // bean
      if (grow < 0.06) { const p = 0.5 + 0.5 * Math.sin(t * 6); s.disc(34, 36.5, 1, C('#e8c15a')); for (let a = 0; a < 12; a++) s.glow(34 + Math.cos(a) * 3, 36.5 + Math.sin(a) * 2, C('#44ff88'), 0.25 * p); }
      // the stalk
      for (let y = 37; y >= topY; y -= 0.5) {
        const x = path(y, t), w = 1.7 - (37 - y) * 0.01, n = noise(x * 0.4, y * 0.5, 2);
        s.disc(x, y, w, lerpC(C('#1f7a30'), C('#7ed957'), n * 0.7), 0.5); s.set(x + w * 0.5, y, C('#b4f27a'));
      }
      for (let y = 36; y > topY + 2; y -= 4.5) { const x = path(y, t), d = ((y * 7) | 0) % 2 ? 1 : -1, len = 5 - (37 - y) * 0.03, flap = Math.sin(t * 1.6 + y) * 0.7; s.line(x, y, x + d * len, y - 1.5 + flap, C('#2f9a3c'), 1.3); s.disc(x + d * len, y - 1.5 + flap, 1.6, C('#59c24a'), 0.5); }
      if (grow > 0.02 && grow < 0.98) { const tx = path(topY, t); for (let a = 0; a < 16; a++) s.glow(tx + Math.cos(a * 0.4 + t * 3) * 3, topY + Math.sin(a * 0.4 + t * 3) * 2, C('#9affaa'), 0.4); s.disc(tx, topY - 1, 1.2, C('#d6ffb0')); }
      for (let i = 0; i < 18; i++) { const u = (t * 0.25 + i / 18) % 1, y = 37 - u * (37 - topY), x = path(y, t) + Math.sin(i * 3 + t * 2) * 4; s.glow(x, y, i % 2 ? C('#ffe27a') : C('#80ffb0'), 0.5 * (1 - u * 0.5)); }
      // Jack climbs (red cap, blue tunic)
      const jy = clamp(topY + 5, 11, 36), jx = path(jy, t) + 2.5, bob = Math.sin(t * 5) * 0.5;
      if (grow > 0.08) { s.line(jx, jy, jx, jy - 3, C('#2f58c8'), 1.6); s.disc(jx, jy - 4.2, 1.1, C('#f2c7a0')); s.set(jx, jy - 5.4, C('#d63030')); s.line(jx, jy - 3, jx - 1.2, jy - 5 + bob, C('#f2c7a0'), 1); s.line(jx, jy - 3, jx + 1.2, jy - 1 - bob, C('#f2c7a0'), 1); }
      return s.frame();
    };
  },
};

// ───────────────────────── jack: the giant's castle ─────────────────────────
STORY.giant = {
  meta: { name: 'giants-castle', category: 'story', note: 'Jack and the Beanstalk: above the clouds, the giant stomps through the storm and the castle keeps its gold lit — fee, fi, fo, fum', cols: W, rows: ROWS, fps: 15 },
  make() {
    const words = ['FEE', 'FI', 'FO', 'FUM!'];
    return (t) => {
      const s = new Scene(W, ROWS), beat = (t * 0.5) % 1, stomp = beat < 0.5 ? 0 : 1, impact = beat > 0.5 && beat < 0.58, flash = (t % 7.5) < 0.2 ? 1 : 0;
      s.fill((x, y) => lerpC(C('#1b0f3a'), C('#e0603a'), smooth(0, 30, y) * 0.9) );
      if (flash) s.fill((x, y) => lerpC(s.get(x, y), C('#ffffff'), 0.55));
      for (let i = 0; i < 24; i++) s.set(hash(i, 1, 8) * W, hash(i, 2, 8) * 16, C('#d8cfff'));
      // castle (right)
      const cas = C('#170a28');
      for (const [x0, w, y0] of [[40, 6, 8], [47, 9, 12], [57, 6, 7]]) { s.region(x0, y0 + 2, x0 + w, 31, () => cas); for (let b = x0; b <= x0 + w; b += 2) s.region(b, y0, b, y0 + 2, () => cas); s.line(x0 + w / 2, y0 - 4, x0 + w / 2, y0, cas, 1); for (let k = 0; k < 3; k++) s.set(x0 + w / 2 + 1 + k * 0.5, y0 - 3 + k * 0.6, C('#e0305a')); }
      for (const [wx, wy] of [[42, 14], [43, 22], [50, 18], [53, 18], [50, 25], [59, 12], [59, 20], [48, 15]]) { const f = 0.7 + 0.3 * Math.sin(t * 4 + wx * 2); s.region(wx, wy, wx + 1, wy + 2, () => lerpC(C('#ff9a2a'), C('#ffe27a'), f)); for (let a = 0; a < 6; a++) s.glow(wx + Math.cos(a) * 2.4, wy + 1 + Math.sin(a) * 2.4, C('#ff9a2a'), 0.18); }
      // the giant (left): silhouette with rim light
      const gx = 20, base = 31, body = C('#2a1038'), rim = C('#ff8a4a'), sw = Math.sin(t * 1.2) * 0.5;
      const leg = (x, lift) => { s.line(x, base - lift, x, base - 11 - lift * 0.3, body, 5); s.region(x - 3, base - 1 - lift, x + 3, base - lift, () => body); };
      leg(gx - 4, stomp ? 3.5 : 0); leg(gx + 4, stomp ? 0 : 3.5);
      for (let y = 10; y < 21; y++) { const w = 5 + (y - 10) * 0.6 + sw * 0.2; for (let x = Math.floor(gx - w); x <= gx + w; x++) s.set(x, y, x > gx + w - 1.5 ? rim : body); }
      const hx = gx + sw, hy = 6; s.disc(hx, hy, 4.4, C('#7a3a4c'), 0.6); s.region(hx - 4, hy - 5, hx + 4, hy - 2, () => C('#3a1a28'));
      for (let y = hy + 2; y < hy + 7; y++) for (let x = hx - 3.5 + (y - hy) * 0.15; x <= hx + 3.5 - (y - hy) * 0.15; x++) s.set(x, y, noise(x, y * 2, 1) > 0.4 ? C('#4a2230') : C('#2c1220')); // beard
      s.disc(hx - 1.6, hy, 0.8, C('#ffee66')); s.disc(hx + 1.6, hy, 0.8, C('#ffee66'));
      const mo = 0.5 + 0.5 * Math.sin(t * 4.5); s.region(hx - 1, hy + 2, hx + 1, hy + 2 + mo * 2, () => C('#12060c'));
      const ang = -1.2 + Math.sin(t * 2.2) * 0.5; // club arm
      s.line(gx + 5, 11, gx + 5 + Math.cos(ang) * 8, 11 + Math.sin(ang) * 8, body, 2.6); const cx = gx + 5 + Math.cos(ang) * 8, cy = 11 + Math.sin(ang) * 8; s.line(cx, cy, cx + Math.cos(ang - 0.5) * 10, cy + Math.sin(ang - 0.5) * 10, C('#4b2a14'), 3.4);
      s.line(gx - 5, 11, gx - 9, 19, body, 2.6);
      // cloud sea, in front
      for (let y = 30; y < H; y++) for (let x = 0; x < W; x++) { const n = fbm(x * 0.07 + t * 0.06 * (1 + (y - 30) * 0.1), y * 0.3, 11, 3), top = y - 30 < n * 8 + 0.5; s.set(x, y, lerpC(top ? C('#ffb36a') : C('#d8668a'), C('#4a2a68'), clamp((y - 30) / 9 + (1 - n) * 0.3))); }
      if (impact) { for (let i = 0; i < 12; i++) s.glow(gx - 4 + (i - 6) * 3.5, 30, C('#ffcf9a'), 0.6); }
      if (flash) { let x = 28, y = 0; while (y < 28) { const nx = x + (hash(y | 0, 3, (t * 3) | 0) - 0.5) * 5, ny = y + 3; s.line(x, y, nx, ny, C('#f4f0ff'), 1.2); x = nx; y = ny; } }
      // shake on impact
      if (impact) { for (let y = H - 1; y > 0; y--) for (let x = 0; x < W; x++) s.px[y * W + x] = s.px[(y - 1) * W + x]; }
      const w = words[Math.floor((t % 6) / 1.5)], col = Math.floor(t * 2) % 2 ? C('#ffe27a') : C('#ff7a3a');
      [...w].forEach((c, i) => s.glyph(Math.floor(gx - w.length / 2 + i), 1, c, col));
      return s.frame();
    };
  },
};

// ───────────────────────── jack: the golden harp & goose ─────────────────────────
STORY.harp = {
  meta: { name: 'golden-harp', category: 'story', note: 'Jack and the Beanstalk: the singing harp, its strings alight, notes floating up — and the goose laying golden eggs', cols: W, rows: ROWS, fps: 15 },
  make() {
    const gold = C('#ffc94a');
    return (t) => {
      const s = new Scene(W, ROWS);
      s.fill((x, y) => { const f = 0.5 + 0.5 * Math.sin(x * 0.9 + noise(x * 0.1, 1, 3) * 3), glow = Math.exp(-(((x - 20) ** 2) / 260 + ((y - 20) ** 2) / 300)); return lerpC(lerpC(C('#2a0612'), C('#7a1328'), f * (1 - y / 60)), C('#e0a040'), glow * 0.35); });
      s.region(0, 36, W, H, (x, y) => lerpC(C('#3a2412'), C('#1a0f08'), (y - 36) / 4));
      // the harp: pillar, soundbox, neck, strings
      const pillar = 29, neckY = (x) => 7 + Math.pow((pillar - x) / 17, 2) * 7;
      s.line(pillar, 7, pillar, 37, gold, 2.4); s.line(pillar - 2, 37, pillar + 3, 37, gold, 2.8);
      for (let x = 12; x <= pillar; x += 0.5) s.disc(x, neckY(x), 1.5, gold);
      s.line(12, 14, 14, 36, gold, 3.2); s.line(14, 36.5, pillar, 36.5, gold, 2);
      for (let y = 15; y < 36; y += 3) s.disc(13 + (y - 14) * 0.09, y, 1.8, lerpC(C('#c88a20'), C('#fff0b0'), 0.5 + 0.5 * Math.sin(t * 2 + y)));
      const N = 9;
      for (let i = 0; i < N; i++) {
        const sx = 17 + i * (pillar - 19) / (N - 1), ny = neckY(sx) + 1, by = 35, pl = (t * 1.4 - i * 0.16) % 1, pluck = Math.max(0, 1 - pl * 4), amp = pluck * 1.6;
        for (let k = 0; k <= 1.001; k += 0.02) { const x = sx + Math.sin(k * Math.PI) * Math.sin(t * 26 + i) * amp, y = mix(ny, by, k); s.set(x, y, lerpC(C('#fff0b0'), C('#ffd060'), k)); if (pluck > 0.3 && k % 0.1 < 0.02) s.glow(x - 1, y, C('#ff9a20'), 0.3 * pluck); }
        if (pluck > 0.92) s.glyph(Math.floor(sx), Math.max(0, Math.floor(ny / 2) - 1), '♪♫♬♩'[i % 4], hsv(0.1 + i * 0.05, 0.6, 1));
      }
      for (let i = 0; i < 7; i++) { const u = (t * 0.22 + i / 7) % 1, x = 14 + i * 3 + Math.sin(t * 2 + i) * 3, y = 28 - u * 28; s.glyph(Math.floor(x), Math.floor(y / 2), '♪♫♬♩'[i % 4], hsv(0.08 + u * 0.6, 0.55, 1 - u * 0.5)); }
      // the goose, laying
      const gx = 49, gy = 31, bob = Math.sin(t * 2) * 0.4;
      for (let y = gy - 5; y <= gy + 4; y++) for (let x = gx - 9; x <= gx + 8; x++) { const d = Math.hypot((x - gx) / 8, (y - (gy - 0.5 + bob)) / 4.6); if (d < 1) s.set(x, y, lerpC(C('#fffaf0'), C('#c8c0b0'), clamp(d * 0.7 + (y - gy) * 0.05))); }
      s.line(gx + 6, gy - 3, gx + 9, gy - 9 + bob, C('#f4eee0'), 2.4); s.disc(gx + 10, gy - 10 + bob, 1.8, C('#fffaf0')); s.line(gx + 11, gy - 10 + bob, gx + 13.5, gy - 9.4 + bob, C('#ff9a2a'), 1.4); s.set(gx + 10, gy - 10.8 + bob, C('#101010'));
      s.line(gx - 8, gy - 2, gx - 11, gy - 5, C('#e8e0d0'), 2); s.line(gx - 3, gy - 1, gx + 3, gy - 2.5 + Math.sin(t * 3) * 0.4, C('#d8d0c0'), 1.8); s.line(gx - 2, gy + 4, gx - 2, gy + 6, C('#ff9a2a'), 1.2); s.line(gx + 3, gy + 4, gx + 3, gy + 6, C('#ff9a2a'), 1.2);
      const per = 5, k = (t % per) / per, n = Math.floor(t / per) % 6;
      for (let e = 0; e < n; e++) { const ex = 40 + (e % 3) * 5 + Math.floor(e / 3) * 2, ey = 37.5 - Math.floor(e / 3) * 2.6; s.disc(ex, ey, 2, gold, 0.4); s.set(ex - 0.8, ey - 0.8, C('#fff6c0')); }
      const ex = 44 - Math.pow(k, 1.5) * 4 - (n % 3) * -5 + (n < 3 ? 0 : 2), ey = k < 0.2 ? mix(32, 36.5, k / 0.2) : 36.5 - Math.floor(n / 3) * 2.6, rr = k < 0.2 ? k / 0.2 * 2 : 2;
      s.disc(ex, ey, rr, gold, 0.4); s.set(ex - 0.8, ey - 0.8, C('#fff6c0'));
      for (let a = 0; a < 10; a++) s.glow(ex + Math.cos(a * 0.63 + t * 4) * 4, ey + Math.sin(a * 0.63 + t * 4) * 3, C('#ffd24a'), 0.4 * (1 - k * 0.6));
      for (let i = 0; i < 8; i++) { const u = (t * 0.6 + i * 0.37) % 1; s.glyph(Math.floor(40 + hash(i, 4, 4) * 20), Math.floor((10 + hash(i, 5, 4) * 16 + u * 4) / 2), '✦', lerpC(C('#fff0a0'), C('#ff9a2a'), u)); }
      return s.frame();
    };
  },
};

// ───────────────────────── the bridge of khazad-dûm ─────────────────────────
STORY.balrog = {
  meta: { name: 'balrog-bridge', category: 'story', note: 'A grey wizard, a staff of white light and a shadow wrapped in fire on a bridge over the deep — you shall not pass', cols: W, rows: ROWS, fps: 15 },
  make() {
    const rand = rng(11), heat = new Float32Array(W * H), mask = new Uint8Array(W * H);
    const pal = ramp([[0, C('#07030a')], [0.12, C('#3a0700')], [0.35, C('#c01c00')], [0.6, C('#ff7a00')], [0.82, C('#ffd24a')], [1, C('#fff6c8')]]);
    const px = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);
    const blob = (cx, cy, rx, ry) => { for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) { const i = px(x, y); if (i >= 0) mask[i] = 1; } };
    const tri = (a, b, c) => { const minx = Math.min(a[0], b[0], c[0]), maxx = Math.max(a[0], b[0], c[0]), miny = Math.min(a[1], b[1], c[1]), maxy = Math.max(a[1], b[1], c[1]); for (let y = Math.floor(miny); y <= maxy; y++) for (let x = Math.floor(minx); x <= maxx; x++) { const d1 = (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]), d2 = (x - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (y - c[1]), d3 = (x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1]); if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) { const i = px(x, y); if (i >= 0) mask[i] = 1; } } };
    const thick = (x0, y0, x1, y1, w) => { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2); for (let i = 0; i <= n; i++) blob(mix(x0, x1, i / n), mix(y0, y1, i / n), w, w); };
    let last = -1;
    return (t) => {
      const s = new Scene(W, ROWS), sway = Math.sin(t * 1.3);
      mask.fill(0);
      const steps = last < 0 ? 1 : Math.max(1, Math.round((t - last) * 15)); last = t;
      const bx = 45, by = 28;
      blob(bx, 15 + sway * 0.3, 5.5, 8); blob(bx, 5.5, 3.2, 3.6);                                      // torso, head
      thick(bx - 2, 22, bx - 3, by, 2.4); thick(bx + 2, 22, bx + 3, by, 2.4);                           // legs
      tri([bx - 3, 5], [bx - 8, 0], [bx - 5.5, 3]); tri([bx + 3, 5], [bx + 8, 0], [bx + 5.5, 3]);       // horns
      const flap = Math.sin(t * 1.6) * 2.5;
      tri([bx - 4, 10], [bx - 22, 1 + flap], [bx - 13, 18]); tri([bx + 4, 10], [bx + 19, 0 + flap], [bx + 15, 16]); // wings
      thick(bx - 5, 11, bx - 12, 17 + sway * 1.5, 1.5);                                                  // whip arm
      thick(bx + 5, 11, bx + 11, 7 + sway * 2, 1.6); thick(bx + 11, 7 + sway * 2, bx + 14, 1.5 + sway * 2, 1.0); // sword arm
      const hand = [bx - 12, 17 + sway * 1.5];
      for (let n = 0; n < steps; n++) { // heat: sources along the whole silhouette and the whip, then the fire climbs
      for (let i = 0; i < W * H; i++) if (mask[i]) heat[i] = Math.max(heat[i], 0.78 + rand() * 0.22);
      for (let k = 0; k <= 1.001; k += 0.012) { const wx = hand[0] - k * 26, wy = hand[1] + Math.sin(k * 9 - t * 7) * (1.5 + k * 3.5) * (0.5 + 0.5 * Math.sin(t * 1.1)) - k * 3; const i = px(Math.round(wx), Math.round(wy)); if (i >= 0) heat[i] = Math.max(heat[i], 0.95 - k * 0.3); }
      for (let x = 0; x < W; x++) heat[(H - 1) * W + x] = 0.35 + rand() * 0.35; // the deep
      for (let y = 0; y < H - 1; y++) for (let x = 0; x < W; x++) { const sx = Math.min(W - 1, Math.max(0, x + Math.floor(rand() * 3) - 1)), v = heat[(y + 1) * W + sx] - rand() * 0.09 - 0.02; heat[y * W + x] = Math.max(0, v); }
      }
      s.fill((x, y) => lerpC(C('#05030a'), C('#150a1c'), y / H));
      for (const [cx, w] of [[3, 5], [59, 5], [30, 3]]) s.region(cx - w / 2, 0, cx + w / 2, 34, (x, y) => lerpC(C('#1b1224'), C('#0a0610'), noise(x, y * 0.2, 2) * 0.6));
      s.region(0, 34, W, H, () => C('#0a0610'));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const h = heat[y * W + x]; if (h > 0.04) s.set(x, y, addC(s.get(x, y), pal(h), 1)); }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) s.set(x, y, lerpC(C('#0a0407'), C('#1d0a0a'), noise(x * 0.4, y * 0.3, 1)));
      s.disc(bx - 1.3, 5.2, 0.7, C('#ffd24a')); s.disc(bx + 1.3, 5.2, 0.7, C('#ffd24a'));
      // the bridge
      s.region(0, 28, W, 30, (x, y) => lerpC(C('#4a3946'), C('#2a1e2a'), (y - 28) / 2 + noise(x * 0.3, 1, 1) * 0.3)); s.region(0, 30, W, 31, () => C('#150c16'));
      for (let x = 0; x < W; x += 6) s.set(x, 29, C('#6a5668'));
      // gandalf
      const gx = 16, gy = 28, lit = 0.8 + 0.2 * Math.sin(t * 5);
      for (let r = 4; r < 13; r++) for (let a = 0; a < 70; a++) { const th = a / 70 * 6.283; s.glow(gx + 4.5 + Math.cos(th) * r, 13 + Math.sin(th) * r * 0.95, C('#7fa8ff'), 0.045 * lit * (1 - (r - 4) / 9)); }
      for (let y = 14; y <= gy; y++) { const w = 1.4 + (y - 14) * 0.26; for (let x = Math.floor(gx - w); x <= gx + w; x++) s.set(x, y, lerpC(C('#c7ccd6'), C('#7a808c'), (y - 14) / 14 + noise(x, y, 4) * 0.2)); }
      s.disc(gx, 12.3, 1.3, C('#f0d2b4')); s.line(gx, 13.5, gx, 18, C('#ffffff'), 1.8);
      for (let y = 6; y < 11; y++) { const w = (y - 5.5) * 0.45; for (let x = Math.floor(gx - w - 0.5); x <= gx + w + 0.5; x++) s.set(x, y, C('#8a909c')); } s.region(gx - 3, 11, gx + 3, 11.6, () => C('#8a909c'));
      s.line(gx + 1, 15, gx + 4, 12, C('#c7ccd6'), 1.2); s.line(gx + 4.5, 7, gx + 4.5, gy, C('#d8c8a0'), 1.2);
      s.disc(gx + 4.5, 6.2, 1.6 * lit, C('#ffffff'), 0.5); for (let a = 0; a < 10; a++) s.glow(gx + 4.5 + Math.cos(a * 0.63 + t * 3) * 3.4, 6.2 + Math.sin(a * 0.63 + t * 3) * 3, C('#c8e0ff'), 0.5);
      for (let i = 0; i < 40; i++) { const u = (t * 0.7 + hash(i, 1, 2)) % 1; s.glow(8 + hash(i, 2, 2) * 52, 34 - u * 34, C('#ff7a20'), 0.7 * (1 - u)); }
      const f = s.frame();
      const msg = 'YOU SHALL NOT PASS!', on = (t % 10) > 5.5 ? (t % 10) - 5.5 : 0;
      if (on > 0) { const n = Math.min(msg.length, Math.floor(on * 8)); for (let i = 0; i < n; i++) { const c = 22 + i, idx = 18 * W + c; f.ch[18] = f.ch[18].slice(0, c) + msg[i] + f.ch[18].slice(c + 1); f.fg[idx] = 0xfff3c4; } }
      return f;
    };
  },
};

// ───────────────────────── disco ─────────────────────────
STORY.disco = {
  meta: { name: 'disco-fever', category: 'story', note: 'A mirror ball turns over a lit dance floor, beams sweep the room, the whole floor pulsing in waves', cols: W, rows: ROWS, fps: 15 },
  make() {
    return (t) => {
      const s = new Scene(W, ROWS);
      s.fill((x, y) => lerpC(C('#0d0418'), C('#1c0830'), y / 30));
      // floor: perspective tiles, colour cycling in waves
      for (let y = 27; y < H; y++) for (let x = 0; x < W; x++) {
        const z = y - 25.6, sx = (x - 32) / z * 1.5, sz = 16 / z, tx = Math.floor(sx), tz = Math.floor(sz + t * 0.0), wave = Math.sin(tx * 0.7 + tz * 0.9 - t * 3) * 0.5 + 0.5, grout = (sx - tx < 0.05 || sz - tz < 0.05);
        s.set(x, y, grout ? C('#08020e') : hsv((tx * 0.11 + tz * 0.07 + t * 0.15) % 1, 0.85, 0.3 + 0.7 * wave * (0.55 + (y - 27) * 0.03)));
      }
      // beams
      const bcx = 32, bcy = 8;
      for (let i = 0; i < 8; i++) {
        const a = t * 0.55 + i * 0.79, dx = Math.cos(a) * 38, dy = 4 + Math.abs(Math.sin(a * 1.0 + i)) * 28, hue = (i / 8 + t * 0.08) % 1, col = hsv(hue, 0.9, 1);
        for (let k = 0.08; k < 1; k += 0.015) s.glow(bcx + dx * k, bcy + dy * k, col, 0.07);
        const ex = bcx + dx, ey = bcy + dy; if (ex > 1 && ex < W - 1) { for (let r = 3; r > 0; r -= 0.5) s.disc(ex, Math.min(H - 1, ey), r, lerpC(s.get(Math.round(ex), Math.round(Math.min(H - 1, ey))), col, 0.4), 0.8); s.glyph(Math.floor(ex), Math.min(ROWS - 1, Math.floor(ey / 2)), '✦', 0xffffff); }
      }
      // ball
      s.line(32, 0, 32, 2, C('#8888a0'), 1);
      const R = 6.5, rot = t * 0.9;
      for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++) {
        const nx = x / R, ny = y / R, d2 = nx * nx + ny * ny; if (d2 > 1) continue; const nz = Math.sqrt(1 - d2), lon = Math.atan2(nx, nz) + rot, lat = Math.asin(ny), tu = lon / (Math.PI / 7), tv = lat / (Math.PI / 7), iu = Math.floor(tu), iv = Math.floor(tv), h = hash(iu, iv, 5);
        const grout = tu - iu < 0.1 || tv - iv < 0.1, spark = Math.pow(Math.max(0, Math.sin(t * 4 + h * 40)), 10), base = 0.25 + 0.5 * h * nz;
        s.set(bcx + x, bcy + y, grout ? C('#333344') : lerpC(lerpC(C('#5a5a78'), C('#d8d8f0'), base), C('#ffffff'), spark));
      }
      for (let a = 0; a < 14; a++) s.glow(bcx + Math.cos(a * 0.45 + t) * 9, bcy + Math.sin(a * 0.45 + t) * 8, C('#b0b0ff'), 0.18);
      // dancers
      const dancer = (x, hue, ph) => {
        const bob = Math.abs(Math.sin(t * 6 + ph)) * 0.8, y = 38, sw = Math.sin(t * 3 + ph), col = C('#0a0410'), rim = hsv(hue, 0.7, 1);
        const body = (dx0, dy0, dx1, dy1, w) => { s.line(x + dx0 + 0.6, y + dy0, x + dx1 + 0.6, y + dy1, rim, w + 0.8); s.line(x + dx0, y + dy0, x + dx1, y + dy1, col, w); };
        body(-1, 0, sw * 1.2 - 1, -7 - bob, 1.6); body(1.5, 0, 4 + sw, -7 - bob, 1.6);            // legs
        body(sw * 0.8, -7 - bob, sw * 0.8 + 0.5, -13 - bob, 2.8);                                 // torso
        body(sw * 0.8 + 0.5, -12 - bob, sw * 0.8 + 6, -19 - bob, 1.3);                            // the pointing arm (up and out)
        body(sw * 0.8 + 0.5, -12 - bob, sw * 0.8 - 3, -8 - bob, 1.3);
        s.disc(x + sw * 0.8 + 0.5, y - 15.5 - bob, 1.6, col); s.disc(x + sw * 0.8 + 1.1, y - 15.5 - bob, 0.7, rim, 0.5);
      };

      return s.frame();
    };
  },
};
export const SET = STORY;
