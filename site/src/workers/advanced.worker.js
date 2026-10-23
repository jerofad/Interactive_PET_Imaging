import { PET } from '../models/pet.js';
import { Advanced } from '../models/advanced.js';

const jobs = {},
  geometries = {};
let volume3d;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const geom = (n) => geometries[n] || (geometries[n] = n === 32 ? PET.geometry(32, 0.8, 60, 65, 0.4) : PET.geometry());
const send = (m, data) => self.postMessage({ channel: m.channel, id: m.id, ...data });
const active = (m) => jobs[m.channel] === m.id;
async function iterate(m, g, d, model, steps, subsets = 1, blur = 0) {
  const em = PET.prepareEM(g, d, model, subsets);
  let sensitivity;
  if (blur) sensitivity = PET.smooth(PET.back(g, model.weights), g.n, blur, g.dx);
  for (let k = 0; k < steps; k++) {
    if (!active(m)) return null;
    if (blur) {
      const predicted = PET.predict(g, PET.smooth(em.x, g.n, blur, g.dx), model),
        ratio = Float64Array.from(d.y, (v, i) => (model.weights[i] * v) / Math.max(1e-15, predicted[i])),
        back = PET.smooth(PET.back(g, ratio), g.n, blur, g.dx);
      for (let i = 0; i < em.x.length; i++) em.x[i] = sensitivity[i] > 0 ? (em.x[i] * back[i]) / sensitivity[i] : 0;
    } else for (let s = 0; s < subsets; s++) PET.emStep(g, d, model, em, s);
    await pause();
  }
  return em.x;
}
async function ensemble(m) {
  const g = geom(32),
    p = { x: Float64Array.from(m.activity), mu: Float64Array.from(m.mu) },
    R = 8,
    K = 30,
    means = Array.from({ length: K }, () => new Float64Array(p.x.length)),
    squares = means.map((x) => new Float64Array(x.length)),
    first = [];
  for (let r = 0; r < R; r++) {
    const d = PET.acquire(g, p, m.counts, 301 + r, true),
      model = PET.model(g, d),
      em = PET.prepareEM(g, d, model, 1);
    for (let k = 0; k < K; k++) {
      if (!active(m)) return;
      PET.emStep(g, d, model, em);
      const x = PET.smooth(em.x, g.n, m.filter, g.dx);
      for (let i = 0; i < x.length; i++) {
        means[k][i] += x[i] / R;
        squares[k][i] += (x[i] * x[i]) / R;
      }
      if (!r) first.push(Float32Array.from(x));
      if (k % 5 === 0) await pause();
    }
    send(m, { type: 'progress', message: 'Poisson realisation ' + (r + 1) + ' / ' + R });
    await pause();
  }
  const base = PET.dot(p.x, p.x),
    curves = means.map((x, k) => {
      let b = 0,
        v = 0;
      for (let i = 0; i < x.length; i++) {
        b += (x[i] - p.x[i]) ** 2;
        v += Math.max(0, squares[k][i] - x[i] * x[i]);
      }
      return {
        iteration: k + 1,
        bias: Math.sqrt(b / base),
        spread: Math.sqrt(v / base),
        rmse: Math.sqrt((b + v) / base),
      };
    });
  send(m, {
    type: 'result',
    curves,
    means: means.map((x) => Float32Array.from(x)),
    first,
    n: g.n,
    realisations: R,
    counts: m.counts,
    filter: m.filter,
  });
}
async function counts(m) {
  const g = geom(64),
    p = { x: m.activity, mu: m.mu },
    images = [],
    fractions = [0.1, 0.25, 0.5, 1];
  for (let i = 0; i < 4; i++) {
    const d = PET.acquire(g, p, m.counts * fractions[i], 811 + i, true),
      model = PET.model(g, d),
      x = await iterate(m, g, d, model, 3, 20);
    if (!x) return;
    images.push({ image: Float32Array.from(PET.smooth(x, 64, 4, 0.4)), fraction: fractions[i], prompts: d.promptSum });
    send(m, { type: 'progress', message: 'Reconstructed ' + Math.round(fractions[i] * 100) + '% counts' });
  }
  send(m, { type: 'result', images, counts: m.counts });
}
async function artifact(m) {
  const g = geom(64),
    p = { x: Float64Array.from(m.activity), mu: Float64Array.from(m.mu) },
    q = m.severity / 100,
    kind = m.kind;
  const trueBlur = kind === 'psf' ? 4 : 0,
    truthForData = trueBlur ? PET.smooth(p.x, 64, trueBlur, 0.4) : p.x,
    d = PET.acquire(g, { x: truthForData, mu: p.mu }, 1e6, 17, false),
    correct = PET.model(g, d),
    wrong = { weights: Float64Array.from(correct.weights), add: Float64Array.from(correct.add) },
    changed = { ...d, y: Float64Array.from(d.y) };
  let usedMu = Float64Array.from(p.mu),
    modelBlur = trueBlur;
  if (kind === 'head' || kind === 'resp') {
    const shifts =
        kind === 'head' ? [0, 12 * q] : Array.from({ length: 12 }, (_, i) => 12 * q * Math.sin((2 * Math.PI * i) / 12)),
      y = new Float64Array(d.y.length);
    for (const mm of shifts) {
      const dx = kind === 'head' ? mm / 4 : 0,
        dy = kind === 'resp' ? mm / 4 : 0,
        x = Advanced.shift(p.x, 64, dx, dy),
        mu = Advanced.shift(p.mu, 64, dx, dy),
        px = PET.forward(g, x),
        pm = PET.forward(g, mu);
      for (let i = 0; i < y.length; i++) y[i] += (d.exposure * d.norm[i] * Math.exp(-pm[i]) * px[i]) / shifts.length;
    }
    changed.y = Float64Array.from(y, (v, i) => v + d.s[i] + d.r[i]);
  } else if (kind === 'misreg') usedMu = Advanced.shift(p.mu, 64, (12 * q) / 4, 0);
  else if (kind === 'truncation') {
    for (let i = 0; i < usedMu.length; i++) {
      const x = ((i % 64) + 0.5 - 32) * 4;
      if (Math.abs(x) > 128 - 65 * q) usedMu[i] = 0;
    }
  } else if (kind === 'metal') {
    for (let i = 0; i < usedMu.length; i++) {
      const x = ((i % 64) + 0.5 - 32) * 4,
        y = (Math.floor(i / 64) + 0.5 - 32) * 4;
      if (p.mu[i] && Math.abs(y - 35 - 0.25 * x) < 5) usedMu[i] += 0.18 * q;
    }
  } else if (kind === 'void') {
    for (let i = 0; i < usedMu.length; i++) {
      const x = ((i % 64) + 0.5 - 32) * 4,
        y = (Math.floor(i / 64) + 0.5 - 32) * 4;
      if (((x - 20) / 28) ** 2 + ((y - 45) / 20) ** 2 < 1) usedMu[i] *= 1 - q;
    }
  } else if (kind === 'scatter') wrong.add = Float64Array.from(d.s, (v, i) => v * (1 + 1.5 * q) + d.r[i]);
  else if (kind === 'psf') modelBlur = 4 + 8 * q;
  if (['misreg', 'truncation', 'metal', 'void'].includes(kind)) {
    const path = PET.forward(g, usedMu);
    wrong.weights = Float64Array.from(correct.weights, (_, i) => d.exposure * d.norm[i] * Math.exp(-path[i]));
  }
  const baseline = await iterate(m, g, d, correct, 30, 1, trueBlur);
  if (!baseline) return;
  send(m, { type: 'progress', message: 'Reference complete; reconstructing the changed model…' });
  const result = await iterate(m, g, changed, wrong, 30, 1, modelBlur);
  if (!result) return;
  let error = 0,
    edge = { value: 0, reference: 0, row: 36 };
  for (let i = 0; i < result.length; i++) {
    error += (result[i] - baseline[i]) ** 2;
    if (kind === 'psf' && p.x[i] === 4) {
      let isolated = true;
      const x = i % 64,
        y = Math.floor(i / 64);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx >= 0 && xx < 64 && yy >= 0 && yy < 64 && p.x[yy * 64 + xx] > 4) isolated = false;
        }
      if (isolated && result[i] > edge.value) edge = { value: result[i], reference: baseline[i], row: y };
    }
  }
  send(m, {
    type: 'result',
    baseline: Float32Array.from(baseline),
    changed: Float32Array.from(result),
    truth: Float32Array.from(p.x),
    mu: Float32Array.from(usedMu),
    difference: Math.sqrt(error / PET.dot(baseline, baseline)),
    baselineMax: Math.max(...baseline),
    changedMax: Math.max(...result),
    edge,
    kind,
    severity: m.severity,
  });
}
self.onmessage = async ({ data: m }) => {
  if (m.type === 'cancel') {
    jobs[m.channel] = m.id;
    return;
  }
  jobs[m.channel] = m.id;
  try {
    if (m.channel === 'ensemble') await ensemble(m);
    else if (m.channel === 'counts') await counts(m);
    else if (m.channel === 'artifact') await artifact(m);
    else if (m.channel === 'mip') {
      if (m.volume) volume3d = m.volume;
      if (!volume3d) throw Error('Missing embedded volume');
      send(m, { type: 'result', image: Advanced.mip(volume3d, 64, 48, m.angle), angle: m.angle });
    }
  } catch (e) {
    if (active(m)) send(m, { type: 'error', message: e.message });
  }
};
