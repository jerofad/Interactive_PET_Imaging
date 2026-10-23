/* Regression tests for the matched 2D PET engine, ported from the notebook's "Engine verification" claims. */
import { describe, expect, it } from 'vitest';
import { PET } from '../../site/src/models/pet.js';

const g = PET.geometry();
const ALL = { normalisation: true, attenuation: true, scatter: true, randoms: true };

function reconstruct(d, flags, algorithm, iterations = 3, subsets = 1) {
  const m = PET.model(g, d, flags);
  if (algorithm === 'FBP') return PET.fbp(g, d, m);
  const em = PET.prepareEM(g, d, m, subsets);
  for (let i = 0; i < iterations; i++) for (let s = 0; s < subsets; s++) PET.emStep(g, d, m, em, s);
  return em.x;
}

/** Mean inside a disc of radius r (cm) about the image centre. */
function centralMean(x, r = 3) {
  let s = 0,
    n = 0;
  for (let i = 0; i < x.length; i++) {
    const xx = ((i % g.n) + 0.5 - g.n / 2) * g.dx,
      yy = (Math.floor(i / g.n) + 0.5 - g.n / 2) * g.dx;
    if (Math.hypot(xx, yy) < r) {
      s += x[i];
      n++;
    }
  }
  return s / n;
}

describe('Siddon ray tracing', () => {
  it('gives the full chord length through the image for a central ray', () => {
    const r = PET.ray(64, 0.4, 0, 0);
    expect(r.lengths.reduce((a, b) => a + b, 0)).toBeCloseTo(25.6, 9);
  });
  it('gives chord lengths that match the square geometry at an oblique angle', () => {
    const r = PET.ray(64, 0.4, 0, Math.PI / 4);
    expect(r.lengths.reduce((a, b) => a + b, 0)).toBeCloseTo(25.6 * Math.SQRT2, 6);
  });
  it('misses the grid entirely outside it', () => {
    expect(PET.ray(64, 0.4, 20, 0).indices).toHaveLength(0);
  });
});

describe('projector', () => {
  it('has an exactly matched transpose (adjoint test)', () => {
    const r = PET.random(5),
      x = Float64Array.from({ length: g.n * g.n }, r),
      y = Float64Array.from({ length: g.rows }, r);
    const lhs = PET.dot(PET.forward(g, x), y),
      rhs = PET.dot(x, PET.back(g, y));
    expect(Math.abs(lhs - rhs) / Math.abs(lhs)).toBeLessThan(1e-12);
  });
  it('places a point source on its sinusoid within 1 mm', () => {
    const p = PET.phantom(g, 'point'),
      sino = PET.forward(g, p.x),
      // Voxel (40, 37) centre in cm, image x right and y down as in the engine.
      x0 = (40 + 0.5 - 32) * 0.4,
      y0 = (37 + 0.5 - 32) * 0.4;
    let worst = 0;
    for (let a = 0; a < g.angles; a++) {
      const phi = (a * Math.PI) / g.angles;
      let w = 0,
        ws = 0;
      for (let b = 0; b < g.bins; b++) {
        const v = sino[a * g.bins + b];
        w += v;
        ws += v * (b - (g.bins - 1) / 2) * g.ds;
      }
      const expected = x0 * Math.cos(phi) + y0 * Math.sin(phi);
      worst = Math.max(worst, Math.abs(ws / w - expected) * 10);
    }
    // The original notebook reports a centroid error ≤ 1.00 mm; allow floating-point rounding.
    expect(worst).toBeLessThanOrEqual(1.0 + 1e-9);
  });
});

describe('noiseless cylinder reconstructions', () => {
  const p = PET.phantom(g, 'cylinder'),
    d = PET.acquire(g, p, 1e6, 17, false);
  it('recovers the assigned 1 a.u. with MLEM, OSEM and FBP', () => {
    expect(centralMean(reconstruct(d, ALL, 'MLEM', 30))).toBeCloseTo(0.998, 2);
    expect(centralMean(reconstruct(d, ALL, 'OSEM', 3, 20))).toBeCloseTo(0.9995, 3);
    expect(centralMean(reconstruct(d, ALL, 'FBP'))).toBeCloseTo(0.9996, 3);
  });
  it('underestimates the centre severely without attenuation correction', () => {
    const v = centralMean(reconstruct(d, { ...ALL, attenuation: false }, 'MLEM', 30));
    expect(v).toBeGreaterThan(0.1);
    expect(v).toBeLessThan(0.14);
  });
  it('keeps MLEM non-negative and FBP linear', () => {
    expect(Math.min(...reconstruct(d, ALL, 'MLEM', 5))).toBeGreaterThanOrEqual(0);
    const m = PET.model(g, d, ALL),
      half = { ...d, y: d.y.map((v, i) => (v - m.add[i]) / 2 + m.add[i]) },
      a = PET.fbp(g, d, m),
      b = PET.fbp(g, half, m);
    for (let i = 0; i < a.length; i += 97) expect(b[i]).toBeCloseTo(a[i] / 2, 9);
  });
});

describe('acquisition model', () => {
  const p = PET.phantom(g, 'cylinder');
  it('splits expected prompts into the prescribed true, scatter and random fractions', () => {
    const d = PET.acquire(g, p, 1e6, 17, false);
    expect(PET.sum(d.t)).toBeCloseTo(6.5e5, 0);
    expect(PET.sum(d.s)).toBeCloseTo(2.5e5, 0);
    expect(PET.sum(d.r)).toBeCloseTo(1e5, 0);
  });
  it('is reproducible for a fixed seed', () => {
    const a = PET.acquire(g, p, 1e5, 17, true),
      b = PET.acquire(g, p, 1e5, 17, true);
    expect(a.promptSum).toBe(b.promptSum);
  });
});

describe('Poisson sampler', () => {
  for (const lambda of [0.7, 4, 25, 400]) {
    it(`has mean and variance close to λ = ${lambda}`, () => {
      const r = PET.random(11),
        n = 40000;
      let s = 0,
        s2 = 0;
      for (let i = 0; i < n; i++) {
        const k = PET.poisson(lambda, r);
        s += k;
        s2 += k * k;
      }
      const mean = s / n,
        variance = s2 / n - mean * mean;
      expect(Math.abs(mean - lambda)).toBeLessThan(5 * Math.sqrt(lambda / n) + 1e-3);
      expect(Math.abs(variance / lambda - 1)).toBeLessThan(0.05);
    });
  }
});
