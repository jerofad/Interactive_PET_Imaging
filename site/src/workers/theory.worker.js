import { PET } from '../models/pet.js';
import { Physics } from '../models/physics.js';

let theoryJob = 0;
const pauseTheory = () => new Promise((r) => setTimeout(r, 0));
function tofGeometry(base, ps) {
  if (!ps) return base;
  const bins = 21,
    step = 2,
    sigma = (Physics.c * ps) / 2 / 10 / Physics.fwhmSigma,
    offs = [0],
    indices = [],
    lengths = [];
  for (let row = 0; row < base.rows; row++) {
    const phi = (Math.floor(row / base.bins) * Math.PI) / base.angles,
      co = Math.cos(phi),
      si = Math.sin(phi),
      parts = Array.from({ length: bins }, () => []);
    for (let k = base.offsets[row]; k < base.offsets[row + 1]; k++) {
      const i = base.indices[k],
        x = ((i % base.n) + 0.5 - base.n / 2) * base.dx,
        y = (Math.floor(i / base.n) + 0.5 - base.n / 2) * base.dx,
        t = -si * x + co * y;
      let prior = 0;
      for (let b = 0; b < bins; b++) {
        const next = b === bins - 1 ? 1 : Physics.cdf(((b - (bins - 1) / 2 + 0.5) * step - t) / sigma),
          p = Math.max(0, next - prior);
        prior = next;
        if (p > 1e-14) parts[b].push([i, base.lengths[k] * p]);
      }
    }
    for (const entries of parts) {
      for (const [i, w] of entries) {
        indices.push(i);
        lengths.push(w);
      }
      offs.push(indices.length);
    }
  }
  return {
    ...base,
    angles: base.angles,
    bins: base.bins * bins,
    rows: base.rows * bins,
    offsets: Uint32Array.from(offs),
    indices: Uint16Array.from(indices),
    lengths: Float32Array.from(lengths),
  };
}
self.onmessage = async (e) => {
  const req = e.data,
    job = ++theoryJob;
  if (req.type === 'cancel') return;
  try {
    if (req.type === 'attenuation') {
      const g = PET.geometry(),
        p = { x: Float64Array.from(req.activity), mu: Float64Array.from(req.mu) },
        d = PET.acquire(g, p, 1e6, 17, false),
        m1 = PET.model(g, d),
        m0 = PET.model(g, d, { normalisation: true, attenuation: false, scatter: true, randoms: true }),
        e1 = PET.prepareEM(g, d, m1),
        e0 = PET.prepareEM(g, d, m0);
      for (let i = 0; i < 30; i++) {
        if (job !== theoryJob) return;
        PET.emStep(g, d, m1, e1);
        PET.emStep(g, d, m0, e0);
        await pauseTheory();
      }
      self.postMessage({ id: req.id, type: 'attenuation', corrected: e1.x, uncorrected: e0.x });
      return;
    }
    if (req.type === 'tof') {
      const g = PET.geometry(32, 0.8, 40, 65, 0.4),
        gt = tofGeometry(g, req.ps),
        truth = Float64Array.from(req.activity),
        make = (gg) => {
          const y = PET.forward(gg, truth),
            d = { y },
            m = { weights: new Float64Array(gg.rows).fill(1), add: new Float64Array(gg.rows) },
            em = PET.prepareEM(gg, d, m);
          return { g: gg, d, m, em };
        },
        plain = make(g),
        timed = make(gt),
        a = [],
        b = [];
      const metric = (o) => PET.metrics(o.em.x, truth).nrmse;
      a.push(metric(plain));
      b.push(metric(timed));
      for (let i = 0; i < 20; i++) {
        if (job !== theoryJob) return;
        PET.emStep(plain.g, plain.d, plain.m, plain.em);
        PET.emStep(timed.g, timed.d, timed.m, timed.em);
        a.push(metric(plain));
        b.push(metric(timed));
        await pauseTheory();
      }
      self.postMessage({
        id: req.id,
        type: 'tof',
        plain: a,
        timed: b,
        ps: req.ps,
        conservation: Math.abs(PET.sum(plain.d.y) - PET.sum(timed.d.y)) / PET.sum(plain.d.y),
      });
      return;
    }
  } catch (err) {
    self.postMessage({ id: req.id, type: 'error', message: err.message });
  }
};
