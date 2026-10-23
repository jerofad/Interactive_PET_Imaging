/* Shared helpers taken from the original single-page notebook.

   Every controller looks up its elements by id. A page now shows only some sections, so
   `$` falls back to a detached copy of the original element when an id is not on the page.
   The copy keeps the original defaults (select options, slider ranges, checkbox state), which
   lets a controller run unchanged with only part of its interface visible. */
import registry from './registry.json';

const detached = new Map();

function fallback(id) {
  if (detached.has(id)) return detached.get(id);
  const spec = registry[id];
  if (!spec) return null;
  const [tag, attrs, options] = spec;
  const el = document.createElement(tag);
  for (const [name, value] of attrs) el.setAttribute(name, value);
  for (const [value, selected, text] of options) {
    const option = document.createElement('option');
    if (value !== null) option.value = value;
    option.textContent = text;
    option.selected = selected;
    el.append(option);
  }
  if (el instanceof HTMLInputElement && el.hasAttribute('value')) el.value = el.getAttribute('value');
  detached.set(id, el);
  return el;
}

/** Element by id: the real element when present, otherwise a detached default copy. */
export const $ = (id) => document.getElementById(id) || fallback(id);

/** True only when the element is really part of this page. */
export const onPage = (id) => !!document.getElementById(id);

/** Hero (count sweep) and tri-planar viewer state, shared across controllers. */
export const state = {
  x: 80,
  y: 72,
  z: 51,
  logN: 5,
  palette: 'inferno',
  crosshair: true,
  reference: false,
  playing: false,
};

const stops = [
  [0, 0, 4],
  [27, 12, 65],
  [74, 12, 107],
  [120, 28, 109],
  [165, 44, 96],
  [207, 68, 70],
  [237, 105, 37],
  [251, 155, 6],
  [247, 209, 61],
  [252, 255, 164],
];
/** Inferno-like 256-entry colour map, RGB triplets. */
export const colours = new Uint8Array(768);
for (let i = 0; i < 256; i++) {
  const f = (i / 255) * 9,
    j = Math.min(8, Math.floor(f)),
    t = f - j;
  for (let k = 0; k < 3; k++) colours[i * 3 + k] = Math.round(stops[j][k] * (1 - t) + stops[j + 1][k] * t);
}

export const idx = (x, y, z) => (z * 128 + y) * 128 + x;
export const mm = (i, n) => (i - (n - 1) / 2) * 2;
export const signed = (v) => (v >= 0 ? '+' : '') + v;

export function rng(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return (seed + 0.5) / 4294967296;
  };
}

export function poisson(l, r) {
  if (l <= 0) return 0;
  if (l < 30) {
    const lim = Math.exp(-l);
    let p = 1,
      k = 0;
    do {
      k++;
      p *= r();
    } while (p > lim);
    return k - 1;
  }
  const g = Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
  return Math.max(0, Math.round(l + Math.sqrt(l) * g));
}

/** Values on a 0–7 a.u. scale to an off-screen canvas. */
export function imageCanvas(values, w, h, palette) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ct = c.getContext('2d'),
    im = ct.createImageData(w, h);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round((values[i] / 7) * 255))),
      off = i * 4;
    for (let k = 0; k < 3; k++) im.data[off + k] = palette === 'gray' ? v : colours[v * 3 + k];
    im.data[off + 3] = 255;
  }
  ct.putImageData(im, 0, 0);
  return c;
}

/** Draws an image into a canvas with margins, optional crosshair and orientation labels. */
export function paint(canvas, values, w, h, palette, cross, labels) {
  const ct = canvas.getContext('2d');
  ct.fillStyle = '#06090f';
  ct.fillRect(0, 0, canvas.width, canvas.height);
  const margin = 24,
    scale = Math.min((canvas.width - margin * 2) / w, (canvas.height - margin * 2) / h),
    dw = w * scale,
    dh = h * scale,
    left = (canvas.width - dw) / 2,
    top = (canvas.height - dh) / 2;
  ct.imageSmoothingEnabled = true;
  ct.drawImage(imageCanvas(values, w, h, palette), left, top, dw, dh);
  canvas._bounds = { left, top, scale, w, h };
  if (cross && state.crosshair) {
    ct.strokeStyle = '#7bcfcb';
    ct.lineWidth = 1;
    ct.setLineDash([4, 4]);
    ct.beginPath();
    ct.moveTo(left + (cross[0] + 0.5) * scale, top);
    ct.lineTo(left + (cross[0] + 0.5) * scale, top + dh);
    ct.moveTo(left, top + (cross[1] + 0.5) * scale);
    ct.lineTo(left + dw, top + (cross[1] + 0.5) * scale);
    ct.stroke();
    ct.setLineDash([]);
  }
  if (labels) {
    ct.fillStyle = '#aabbd0';
    ct.font = '13px monospace';
    ct.textAlign = 'center';
    ct.fillText(labels[0], canvas.width / 2, 16);
    ct.fillText(labels[1], canvas.width / 2, canvas.height - 7);
    ct.fillText(labels[2], 11, canvas.height / 2);
    ct.fillText(labels[3], canvas.width - 11, canvas.height / 2);
  }
}

/** Stops the count sweep. */
export function stop() {
  state.playing = false;
  const play = $('play');
  if (play) play.textContent = 'Play count sweep';
}

/** Shows a page-level error in the alert region. */
export function showError(message) {
  const box = document.getElementById('error');
  if (box) {
    box.hidden = false;
    box.textContent = message;
  }
}
