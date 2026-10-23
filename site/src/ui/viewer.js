/* Linked tri-planar phantom viewer and whole-volume histogram. */
import { $, state, idx, mm, signed, paint } from '../core/common.js';

const TISSUES = [
  'Outside',
  'Grey matter',
  'White matter',
  'CSF',
  'Skull',
  'Scalp',
  '6 mm hot sphere',
  '12 mm hot sphere',
];

export function init({ meta, volume, tissue }) {
  function getSlice(axis) {
    const w = 128,
      h = axis === 'z' ? 128 : 96,
      v = new Float32Array(w * h);
    for (let row = 0; row < h; row++)
      for (let col = 0; col < w; col++) {
        const x = axis === 'x' ? state.x : 127 - col,
          y = axis === 'y' ? state.y : axis === 'z' ? 127 - row : col,
          z = axis === 'z' ? state.z : 95 - row;
        v[row * w + col] = volume[idx(x, y, z)] / 32;
      }
    return { v, w, h };
  }

  function renderViews() {
    for (const [axis, id, labels] of [
      ['z', 'axial', ['A', 'P', 'R', 'L']],
      ['y', 'coronal', ['S', 'I', 'R', 'L']],
      ['x', 'sagittal', ['S', 'I', 'P', 'A']],
    ]) {
      const a = getSlice(axis),
        cross =
          axis === 'z'
            ? [127 - state.x, 127 - state.y]
            : axis === 'y'
              ? [127 - state.x, 95 - state.z]
              : [state.y, 95 - state.z];
      paint($(id), a.v, a.w, a.h, state.palette, cross, labels);
      $(axis + 'Slider').value = state[axis];
      $(axis + 'Value').textContent =
        state[axis] +
        1 +
        ' / ' +
        (axis === 'z' ? 96 : 128) +
        ' · ' +
        signed(mm(state[axis], axis === 'z' ? 96 : 128)) +
        ' mm';
    }
    $('voxelReadout').textContent =
      'R ' +
      signed(mm(state.x, 128)) +
      ' · A ' +
      signed(mm(state.y, 128)) +
      ' · S ' +
      signed(mm(state.z, 96)) +
      ' mm | ' +
      TISSUES[tissue[idx(state.x, state.y, state.z)]] +
      ' | ' +
      (volume[idx(state.x, state.y, state.z)] / 32).toFixed(2) +
      ' a.u.';
    $('viewerRamp').style.background = state.palette === 'gray' ? 'linear-gradient(90deg,#000,#fff)' : '';
  }

  function histogram() {
    const c = $('histogram'),
      ctx = c.getContext('2d'),
      w = c.clientWidth || 640,
      h = c.clientHeight || 220,
      dpr = window.devicePixelRatio || 1,
      b = new Uint32Array(8);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const v of volume) if (v) b[Math.floor(v / 32)]++;
    const css = getComputedStyle(document.documentElement),
      fg = css.getPropertyValue('--muted').trim(),
      bar = css.getPropertyValue('--activity').trim(),
      L = 48,
      R = 14,
      U = 32,
      B = 44,
      pw = w - L - R,
      ph = h - U - B,
      max = Math.max(...b);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(L, U);
    ctx.lineTo(L, h - B);
    ctx.lineTo(w - R, h - B);
    ctx.stroke();
    ctx.font = '13px monospace';
    ctx.fillStyle = fg;
    ctx.textAlign = 'left';
    ctx.fillText('voxels (×10³)', L, 18);
    for (let j = 0; j <= 3; j++) {
      ctx.textAlign = 'right';
      ctx.fillText(((max * j) / 3000).toFixed(0), L - 7, h - B - (j * ph) / 3);
    }
    for (let i = 0; i < 8; i++) {
      const x = L + (i * pw) / 8 + pw / 80,
        hh = (b[i] / max) * ph;
      ctx.fillStyle = bar;
      ctx.fillRect(x, h - B - hh, pw / 10, hh);
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.fillText(String(i), L + ((i + 0.5) * pw) / 8, h - B + 18);
    }
    ctx.textAlign = 'center';
    ctx.fillText('activity (a.u.)', w / 2, h - 5);
  }

  function setPosition(pos) {
    for (const a of ['x', 'y', 'z'])
      if (pos[a] !== undefined) {
        const max = a === 'z' ? 95 : 127;
        if (!Number.isInteger(pos[a]) || pos[a] < 0 || pos[a] > max) throw Error('Invalid ' + a + ' slice');
      }
    Object.assign(state, pos);
    renderViews();
    return { x: state.x, y: state.y, z: state.z };
  }

  renderViews();
  histogram();
  for (const a of ['x', 'y', 'z']) $(a + 'Slider').oninput = (e) => setPosition({ [a]: +e.target.value });
  $('palette').onchange = (e) => {
    state.palette = e.target.value;
    renderViews();
  };
  $('crosshair').onchange = (e) => {
    state.crosshair = e.target.checked;
    renderViews();
  };
  $('centre').onclick = () => setPosition({ x: 64, y: 64, z: 48 });
  $('smallLesion').onclick = () => setPosition({ x: 80, y: 74, z: 51 });
  $('largeLesion').onclick = () => setPosition({ x: 47, y: 72, z: 51 });
  for (const [id, a] of [
    ['axial', 'z'],
    ['coronal', 'y'],
    ['sagittal', 'x'],
  ])
    $(id).addEventListener('pointerdown', (e) => {
      const c = $(id),
        b = c._bounds,
        rect = c.getBoundingClientRect(),
        col = Math.floor((((e.clientX - rect.left) * c.width) / rect.width - b.left) / b.scale),
        row = Math.floor((((e.clientY - rect.top) * c.height) / rect.height - b.top) / b.scale);
      if (col < 0 || col >= b.w || row < 0 || row >= b.h) return;
      if (a === 'z') setPosition({ x: 127 - col, y: 127 - row });
      if (a === 'y') setPosition({ x: 127 - col, z: 95 - row });
      if (a === 'x') setPosition({ y: col, z: 95 - row });
    });
  $('theme').addEventListener('change', histogram);
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change', histogram);
  let histogramResize;
  window.addEventListener('resize', () => {
    clearTimeout(histogramResize);
    histogramResize = setTimeout(histogram, 120);
  });
  window.petNotebook = { state, meta: { dimensions: meta.dimensions, units: meta.units }, setPosition };
  if (document.modelContext?.registerTool) {
    try {
      Promise.resolve(
        document.modelContext.registerTool({
          name: 'set_phantom_slices',
          title: 'Set phantom slice position',
          description: 'Move the three linked synthetic phantom slice views. Zero-based voxel indices.',
          inputSchema: {
            type: 'object',
            properties: {
              x: { type: 'integer', minimum: 0, maximum: 127 },
              y: { type: 'integer', minimum: 0, maximum: 127 },
              z: { type: 'integer', minimum: 0, maximum: 95 },
            },
            required: ['x', 'y', 'z'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: (input) => {
            if (
              !input ||
              Object.keys(input).some((k) => !['x', 'y', 'z'].includes(k)) ||
              !['x', 'y', 'z'].every((k) => Number.isInteger(input[k]))
            )
              throw Error('Provide integer x, y and z');
            return setPosition(input);
          },
        }),
      ).catch(() => {});
    } catch {}
  }
}
