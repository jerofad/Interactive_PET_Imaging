/* Matched 2D parallel-beam PET teaching engine. Distances in cm. */
export const PET = (() => {
  const sum = (a) => a.reduce((s, x) => s + x, 0),
    dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  function random(seed = 17) {
    return () => {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return (seed + 0.5) / 4294967296;
    };
  }
  const lf = new Float64Array(256);
  for (let i = 2; i < lf.length; i++) lf[i] = lf[i - 1] + Math.log(i);
  function logFactorial(k) {
    if (k < 256) return lf[k];
    const t = k + 1;
    return (t - 0.5) * Math.log(t) - t + 0.9189385332046727 + 1 / (12 * t) - 1 / (360 * t * t * t);
  }
  function poisson(l, r) {
    if (l <= 0) return 0;
    if (l < 10) {
      let p = 1,
        k = 0;
      const lim = Math.exp(-l);
      do {
        p *= r();
        k++;
      } while (p > lim);
      return k - 1;
    }
    // Hörmann PTRS transformed rejection; no Gaussian substitution at high counts.
    const b = 0.931 + 2.53 * Math.sqrt(l),
      a = -0.059 + 0.02483 * b,
      invAlpha = 1.1239 + 1.1328 / (b - 3.4),
      vr = 0.9277 - 3.6224 / (b - 2);
    for (;;) {
      const u = r() - 0.5,
        v = r(),
        us = 0.5 - Math.abs(u),
        k = Math.floor(((2 * a) / us + b) * u + l + 0.43);
      if (us >= 0.07 && v <= vr) return k;
      if (k < 0 || (us < 0.013 && v > us)) continue;
      if (Math.log((v * invAlpha) / (a / (us * us) + b)) <= -l + k * Math.log(l) - logFactorial(k)) return k;
    }
  }
  function ray(n, dx, s, phi) {
    const half = (n * dx) / 2,
      c = Math.cos(phi),
      si = Math.sin(phi),
      ox = s * c,
      oy = s * si,
      vx = -si,
      vy = c;
    let lo = -Infinity,
      hi = Infinity;
    for (const [o, v] of [
      [ox, vx],
      [oy, vy],
    ]) {
      if (Math.abs(v) < 1e-12) {
        if (o <= -half || o >= half) return { indices: [], lengths: [] };
        continue;
      }
      const a = (-half - o) / v,
        b = (half - o) / v;
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
    }
    if (hi <= lo) return { indices: [], lengths: [] };
    const cuts = [lo, hi];
    for (let i = 1; i < n; i++) {
      const boundary = -half + i * dx;
      if (Math.abs(vx) > 1e-12) {
        const t = (boundary - ox) / vx;
        if (t > lo && t < hi) cuts.push(t);
      }
      if (Math.abs(vy) > 1e-12) {
        const t = (boundary - oy) / vy;
        if (t > lo && t < hi) cuts.push(t);
      }
    }
    cuts.sort((a, b) => a - b);
    const indices = [],
      lengths = [];
    for (let k = 1; k < cuts.length; k++) {
      const len = cuts[k] - cuts[k - 1];
      if (len < 1e-9) continue;
      const mid = (cuts[k] + cuts[k - 1]) / 2,
        x = Math.floor((ox + mid * vx + half) / dx),
        y = Math.floor((oy + mid * vy + half) / dx);
      if (x >= 0 && x < n && y >= 0 && y < n) {
        indices.push(y * n + x);
        lengths.push(len);
      }
    }
    return { indices, lengths };
  }
  function geometry(n = 64, dx = 0.4, angles = 120, bins = 129, ds = 0.2) {
    const offsets = [0],
      indices = [],
      lengths = [];
    for (let a = 0; a < angles; a++)
      for (let b = 0; b < bins; b++) {
        const r = ray(n, dx, (b - (bins - 1) / 2) * ds, (a * Math.PI) / angles);
        for (let j = 0; j < r.indices.length; j++) {
          indices.push(r.indices[j]);
          lengths.push(r.lengths[j]);
        }
        offsets.push(indices.length);
      }
    return {
      n,
      dx,
      angles,
      bins,
      ds,
      rows: angles * bins,
      offsets: Uint32Array.from(offsets),
      indices: Uint16Array.from(indices),
      lengths: Float32Array.from(lengths),
    };
  }
  function forward(g, x) {
    const out = new Float64Array(g.rows),
      { offsets, indices, lengths } = g;
    for (let r = 0; r < g.rows; r++) {
      let v = 0;
      for (let k = offsets[r]; k < offsets[r + 1]; k++) v += x[indices[k]] * lengths[k];
      out[r] = v;
    }
    return out;
  }
  function back(g, y) {
    const out = new Float64Array(g.n * g.n),
      { offsets, indices, lengths } = g;
    for (let r = 0; r < g.rows; r++) {
      const v = y[r];
      for (let k = offsets[r]; k < offsets[r + 1]; k++) out[indices[k]] += v * lengths[k];
    }
    return out;
  }
  function mask(g) {
    return Float64Array.from({ length: g.n * g.n }, (_, i) => {
      const x = ((i % g.n) + 0.5 - g.n / 2) * g.dx,
        y = (Math.floor(i / g.n) + 0.5 - g.n / 2) * g.dx;
      return Math.hypot(x, y) < (g.n * g.dx) / 2 ? 1 : 0;
    });
  }
  function phantom(g, kind, activity, mu) {
    if (kind === 'brain') return { x: Float64Array.from(activity), mu: Float64Array.from(mu) };
    const x = new Float64Array(g.n * g.n),
      m = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const xx = ((i % g.n) + 0.5 - g.n / 2) * g.dx,
        yy = (Math.floor(i / g.n) + 0.5 - g.n / 2) * g.dx;
      if (Math.hypot(xx, yy) < 8) {
        m[i] = 0.096;
        if (kind === 'cylinder') x[i] = 1;
      }
    }
    if (kind === 'point') x[37 * g.n + 40] = 7;
    return { x, mu: m };
  }
  function acquire(g, p, N = 1e6, seed = 17, noise = true) {
    const projected = forward(g, p.x),
      path = forward(g, p.mu),
      norm = new Float64Array(g.rows),
      atten = new Float64Array(g.rows),
      t = new Float64Array(g.rows),
      s = new Float64Array(g.rows),
      r = new Float64Array(g.rows);
    for (let i = 0; i < g.rows; i++) {
      const a = Math.floor(i / g.bins),
        b = i % g.bins;
      norm[i] = 1 + 0.15 * Math.cos((a * 2 * Math.PI) / g.angles) + 0.05 * Math.sin((b * 2 * Math.PI) / g.bins);
      atten[i] = Math.exp(-path[i]);
      t[i] = norm[i] * atten[i] * projected[i];
      s[i] =
        Math.exp(-0.5 * Math.pow((b - (g.bins - 1) / 2) / 32, 2)) * (1 + 0.1 * Math.cos((a * 2 * Math.PI) / g.angles));
      r[i] = 1;
    }
    const tSum = sum(t),
      sSum = sum(s),
      rSum = sum(r),
      exposure = (0.65 * N) / tSum;
    for (let i = 0; i < g.rows; i++) {
      t[i] *= exposure;
      s[i] *= (0.25 * N) / sSum;
      r[i] *= (0.1 * N) / rSum;
    }
    const expected = Float64Array.from(t, (v, i) => v + s[i] + r[i]),
      rand = random(seed),
      y = Float64Array.from(expected, (v) => (noise ? poisson(v, rand) : v));
    return { y, expected, t, s, r, norm, atten, exposure, promptSum: sum(y), N, noise, seed };
  }
  function model(g, d, flags = { normalisation: true, attenuation: true, scatter: true, randoms: true }) {
    const weights = Float64Array.from(
        d.y,
        (_, i) => d.exposure * (flags.normalisation ? d.norm[i] : 1) * (flags.attenuation ? d.atten[i] : 1),
      ),
      add = Float64Array.from(d.y, (_, i) => (flags.scatter ? d.s[i] : 0) + (flags.randoms ? d.r[i] : 0));
    return { weights, add };
  }
  function predict(g, x, m) {
    return Float64Array.from(forward(g, x), (v, i) => v * m.weights[i] + m.add[i]);
  }
  function logLikelihood(y, q) {
    let v = 0;
    for (let i = 0; i < y.length; i++) v += y[i] * Math.log(Math.max(q[i], 1e-15)) - q[i];
    return v;
  }
  function deviance(y, q) {
    let v = 0;
    for (let i = 0; i < y.length; i++)
      v += 2 * (q[i] - y[i] + (y[i] > 0 ? y[i] * Math.log(y[i] / Math.max(q[i], 1e-15)) : 0));
    return v / y.length;
  }
  function prepareEM(g, d, m, subsets = 1) {
    const sens = Array.from({ length: subsets }, () => new Float64Array(g.n * g.n)),
      { offsets, indices, lengths } = g;
    for (let r = 0; r < g.rows; r++) {
      const s = Math.floor(r / g.bins) % subsets;
      for (let k = offsets[r]; k < offsets[r + 1]; k++) sens[s][indices[k]] += lengths[k] * m.weights[r];
    }
    const support = mask(g),
      signal = Math.max(1, sum(d.y) - sum(m.add)),
      unitPrediction = dot(forward(g, support), m.weights),
      start = signal / unitPrediction;
    return { x: Float64Array.from(support, (v) => v * start), sens, subsets, support };
  }
  function emStep(g, d, m, em, subset = 0) {
    const corr = new Float64Array(em.x.length),
      { offsets, indices, lengths } = g;
    for (let a = subset; a < g.angles; a += em.subsets)
      for (let b = 0; b < g.bins; b++) {
        const r = a * g.bins + b;
        let p = 0;
        for (let k = offsets[r]; k < offsets[r + 1]; k++) p += lengths[k] * em.x[indices[k]];
        const ratio = d.y[r] / Math.max(1e-15, m.weights[r] * p + m.add[r]);
        for (let k = offsets[r]; k < offsets[r + 1]; k++) corr[indices[k]] += lengths[k] * m.weights[r] * ratio;
      }
    for (let i = 0; i < em.x.length; i++)
      em.x[i] = em.sens[subset][i] > 0 ? (em.x[i] * corr[i]) / em.sens[subset][i] : 0;
    return em.x;
  }
  function fbp(g, d, m) {
    const corrected = Float64Array.from(d.y, (v, i) => (v - m.add[i]) / m.weights[i]),
      filtered = new Float64Array(g.rows),
      ds = g.ds;
    // Spatial Ram-Lak convolution, h[0]=1/(4 ds²), odd h[k]=-1/(π² k² ds²).
    for (let a = 0; a < g.angles; a++)
      for (let b = 0; b < g.bins; b++) {
        let q = corrected[a * g.bins + b] / (4 * ds * ds);
        for (let j = 0; j < g.bins; j++) {
          const k = b - j;
          if (k !== 0 && Math.abs(k) % 2 === 1) q -= corrected[a * g.bins + j] / (Math.PI * Math.PI * k * k * ds * ds);
        }
        filtered[a * g.bins + b] = q * ds;
      }
    const out = new Float64Array(g.n * g.n),
      support = mask(g);
    for (let a = 0; a < g.angles; a++) {
      const phi = (a * Math.PI) / g.angles,
        c = Math.cos(phi),
        s = Math.sin(phi);
      for (let i = 0; i < out.length; i++) {
        if (!support[i]) continue;
        const x = ((i % g.n) + 0.5 - g.n / 2) * g.dx,
          y = (Math.floor(i / g.n) + 0.5 - g.n / 2) * g.dx,
          u = (x * c + y * s) / ds + (g.bins - 1) / 2,
          b = Math.floor(u),
          f = u - b;
        if (b >= 0 && b < g.bins - 1)
          out[i] += ((filtered[a * g.bins + b] * (1 - f) + filtered[a * g.bins + b + 1] * f) * Math.PI) / g.angles;
      }
    }
    return out;
  }
  function smooth(x, n, fwhmMm, dxCm) {
    if (!fwhmMm) return Float64Array.from(x);
    const sigma = fwhmMm / (2 * Math.sqrt(2 * Math.log(2)) * dxCm * 10),
      rad = Math.ceil(3 * sigma),
      kernel = [];
    let norm = 0;
    for (let k = -rad; k <= rad; k++) {
      const v = Math.exp((-k * k) / (2 * sigma * sigma));
      kernel.push(v);
      norm += v;
    }
    const tmp = new Float64Array(x.length),
      out = new Float64Array(x.length);
    for (let y = 0; y < n; y++)
      for (let i = 0; i < n; i++)
        for (let k = -rad; k <= rad; k++) {
          const j = i + k;
          if (j >= 0 && j < n) tmp[y * n + i] += (x[y * n + j] * kernel[k + rad]) / norm;
        }
    for (let y = 0; y < n; y++)
      for (let i = 0; i < n; i++)
        for (let k = -rad; k <= rad; k++) {
          const j = y + k;
          if (j >= 0 && j < n) out[y * n + i] += (tmp[j * n + i] * kernel[k + rad]) / norm;
        }
    return out;
  }
  function metrics(x, truth) {
    let sq = 0,
      base = 0,
      neg = 0;
    for (let i = 0; i < x.length; i++) {
      sq += (x[i] - truth[i]) ** 2;
      base += truth[i] ** 2;
      if (x[i] < 0) neg++;
    }
    return { nrmse: Math.sqrt(sq / base), negative: neg, max: Math.max(...x), mean: sum(x) / x.length };
  }
  return {
    sum,
    dot,
    random,
    poisson,
    ray,
    geometry,
    forward,
    back,
    mask,
    phantom,
    acquire,
    model,
    predict,
    logLikelihood,
    deviance,
    prepareEM,
    emStep,
    fbp,
    smooth,
    metrics,
  };
})();
export default PET;
