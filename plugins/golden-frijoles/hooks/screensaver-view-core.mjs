// screensaver-view-core.mjs — the Client module's whole logic, with the pieces passed in so node:test can drive it
// with fake ones (the real catalog is TypeScript; CI's Node 20 does not read it). screensaver-view.mjs binds the real one.
//
// A Client module runs on the drawing thread: no `$`, no store, no fs. Everything it needs arrives as props from the
// hook — `fits` (the pieces that fit the band right now, each with the rows to show and the side to keep:
// screensaver.mjs fitPieces), `rotateS`, `seed` (where in the list this run starts), `hint` (an optional caption tail).
// It owns only a clock, and draws one frame of one piece, centred, with a dim caption. It takes no keys and no
// pointer on purpose: the hook wakes it from the engine's own events, and a region that never asks for input never
// holds the focus (screensaver D4).
// No imports: this module runs on the drawing thread, and nothing the hooks module loads belongs there.
export const TICK_MS = 50; // 20 a second: the pieces ask for 10–30, and a visible pane redraws at 30 at most

/** The rows of a frame to show: all of them, or `rows` of them kept from the anchored side (screensaver D3). */
export function cropLines(lines, rows, anchor = 'middle') {
  if (!Number.isFinite(rows) || rows >= lines.length) return lines;
  const keep = Math.max(1, rows);
  const cut = lines.length - keep;
  const from = anchor === 'top' ? 0 : anchor === 'bottom' ? cut : Math.floor(cut / 2);
  return lines.slice(from, from + keep);
}

export function createSaverView(pieces, { tickMs = TICK_MS } = {}) {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  // One record per instance, keyed by the surface the engine hands back (the same surface on every call).
  const instances = new WeakMap();

  return function SaverView(props, surface) {
    const { Box, Text } = surface.elements;
    const fits = (Array.isArray(props?.fits) ? props.fits : []).filter((f) => f && byId.has(f.id));
    const ids = fits.map((f) => f.id);
    // Nothing fits: draw nothing, not a blank row.
    if (!ids.length) return Box({ height: 0 });
    const rotateS = Number.isFinite(props.rotateS) && props.rotateS > 0 ? props.rotateS : 45;

    let inst = instances.get(surface);
    if (!inst) {
      const seed = Number.isFinite(props.seed) ? Math.abs(Math.trunc(props.seed)) : 0;
      inst = { i: seed % ids.length, t: 0, n: 0, id: null, frame: null, ids, rotateS, failed: null };
      instances.set(surface, inst);
      surface.every(tickMs, () => {
        inst.t += tickMs / 1000;
        if (inst.t >= inst.rotateS) {
          inst.i = (inst.i + 1) % inst.ids.length;
          inst.t = 0;
        }
        surface.setState(++inst.n); // the state is only a counter: setting it is what redraws
      });
    }
    // The terminal may have been resized: the hook sends a new list, and the position follows it.
    inst.ids = ids;
    inst.rotateS = rotateS;
    if (inst.i >= ids.length) inst.i = 0;

    const piece = byId.get(ids[inst.i]);
    const fit = fits[inst.i];
    if (inst.id !== piece.id) {
      // A new piece starts from its beginning: its Frame is built fresh, and is the only thing that holds its state.
      inst.id = piece.id;
      inst.t = 0;
      inst.failed = null;
      try {
        inst.frame = piece.make();
      } catch (err) {
        inst.frame = null;
        inst.failed = String(err?.message ?? err);
      }
    }

    let lines;
    try {
      if (!inst.frame) throw new Error(inst.failed ?? 'no frame');
      lines = cropLines(inst.frame(inst.t, { paper: false }).split('\n'), fit.rows, fit.anchor);
    } catch (err) {
      lines = [`screensaver: ${piece.id} failed — ${String(err?.message ?? err)}`];
    }

    // Centre in the region. The hook only sends pieces that fit the width; this just pads (surface.columns is 0
    // before the first layout, and then the picture is drawn at the left for one frame).
    const width = surface.columns;
    if (width > 0) {
      lines = lines.map((l) => {
        const cells = [...l];
        if (cells.length > width) return cells.slice(0, width).join('');
        return ' '.repeat(Math.floor((width - cells.length) / 2)) + l;
      });
    }

    return Box({
      flexDirection: 'column',
      children: [
        ...lines.map((l) => Text({ dimColor: true, wrap: 'truncate', children: [l] })),
        Text({
          dimColor: true,
          wrap: 'truncate',
          children: [`  ascii.rest · ${piece.meta.name} — type to wake${typeof props.hint === 'string' && props.hint ? ` · ${props.hint}` : ''}`],
        }),
      ],
    });
  };
}
