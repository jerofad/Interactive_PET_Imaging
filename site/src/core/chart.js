/* Shared canvas line chart used by every analytic figure. Colours come from the CSS tokens,
   so charts follow the light and dark themes. */
import { $ } from './common.js';

export const color = (name) =>
  getComputedStyle(document.documentElement)
    .getPropertyValue('--' + name)
    .trim();

export function format(v) {
  const a = Math.abs(v);
  return a >= 10 ? v.toFixed(0) : a >= 1 ? v.toFixed(1) : a === 0 ? '0' : a < 0.01 ? v.toExponential(1) : v.toFixed(2);
}

export function chart(
  id,
  { xmin = 0, xmax = 1, ymin = 0, ymax = 1, xlabel = '', ylabel = '', curves = [], shade, marker, point },
) {
  const c = $(id),
    ctx = c.getContext('2d'),
    w = c.clientWidth || c.width,
    h = c.clientHeight || c.height,
    ratio = window.devicePixelRatio || 1;
  if (c.clientWidth) {
    c.width = Math.round(w * ratio);
    c.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  ctx.font = '13px monospace';
  const lines = (text, max) => {
      const out = [];
      let line = '';
      for (const word of text.split(' ')) {
        const next = line ? line + ' ' + word : word;
        if (line && ctx.measureText(next).width > max) {
          out.push(line);
          line = word;
        } else line = next;
      }
      if (line) out.push(line);
      return out;
    },
    xl = lines(xlabel, w - 20),
    yl = lines(ylabel, w - 20),
    L = w < 400 ? 52 : 62,
    R = w < 400 ? 16 : 24,
    U = 20 + yl.length * 16,
    B = 30 + xl.length * 16,
    pw = w - L - R,
    ph = h - U - B,
    X = (x) => L + ((x - xmin) / (xmax - xmin)) * pw,
    Y = (y) => U + ((ymax - y) / (ymax - ymin)) * ph;
  ctx.clearRect(0, 0, w, h);
  ctx.font = '13px monospace';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.textAlign = 'right';
  ctx.fillStyle = color('muted');
  ctx.strokeStyle = color('line');
  for (let j = 0; j <= 4; j++) {
    const yy = ymin + ((ymax - ymin) * j) / 4,
      y = Y(yy);
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(w - R, y);
    ctx.stroke();
    ctx.fillText(format(yy), L - 10, y + 4);
  }
  ctx.textAlign = 'center';
  for (let j = 0; j <= 4; j++) {
    const x = xmin + ((xmax - xmin) * j) / 4;
    ctx.fillText(format(x), X(x), h - B + 23);
  }
  xl.forEach((line, i) => ctx.fillText(line, w / 2, h - 8 - (xl.length - 1 - i) * 16, w - 16));
  ctx.textAlign = 'left';
  yl.forEach((line, i) => ctx.fillText(line, 10, 16 + i * 16, w - 20));
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, U, pw, ph);
  ctx.clip();
  if (shade) {
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = color(shade.color || 'detector');
    ctx.fillRect(X(shade.from), U, X(shade.to) - X(shade.from), ph);
    ctx.globalAlpha = 1;
  }
  for (const curve of curves) {
    ctx.strokeStyle = color(curve.color || 'activity');
    ctx.lineWidth = curve.width || 2.5;
    ctx.setLineDash(curve.dash || []);
    ctx.beginPath();
    let active = false;
    for (const [x, y] of curve.data) {
      if (!Number.isFinite(y)) {
        active = false;
        continue;
      }
      if (active) ctx.lineTo(X(x), Y(y));
      else {
        ctx.moveTo(X(x), Y(y));
        active = true;
      }
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (marker !== undefined) {
    ctx.strokeStyle = color('muted');
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(X(marker), U);
    ctx.lineTo(X(marker), U + ph);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (point) {
    ctx.fillStyle = color(point.color || 'detector');
    ctx.beginPath();
    ctx.arc(X(point.x), Y(point.y), 4, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
  return { X, Y, ctx };
}
