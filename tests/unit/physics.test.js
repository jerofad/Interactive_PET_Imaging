/* Tests for the analytic teaching models against textbook values and the cited sources. */
import { describe, expect, it } from 'vitest';
import { Physics } from '../../site/src/models/physics.js';
import { Advanced } from '../../site/src/models/advanced.js';
import { ScenePhysics, UNTIMED_JITTER_PS } from '../../site/src/models/scene.js';

describe('isotopes', () => {
  it('uses the cited positron fractions (Conti & Eriksson 2016)', () => {
    const br = Object.fromEntries(Object.entries(Physics.isotopes).map(([k, v]) => [k, v.br]));
    expect(br).toEqual({ F18: 0.969, C11: 0.998, Ga68: 0.889, O15: 0.999, Rb82: 0.949 });
  });
  it('halves activity after one half-life', () => {
    for (const iso of Object.values(Physics.isotopes))
      expect(Physics.decay(100, iso.half, iso.half)).toBeCloseTo(50, 10);
  });
  it('integrates decays in a window analytically', () => {
    const half = 110,
      lambda = Math.LN2 / half;
    let numeric = 0;
    for (let k = 0; k < 10000; k++) numeric += Physics.decay(200, 30 + (k + 0.5) * 0.001, half) * 1e6 * 60 * 0.001;
    expect(Physics.windowDecays(200, 30, 10, half) / numeric).toBeCloseTo(1, 6);
    expect(lambda).toBeGreaterThan(0);
  });
});

describe('emission and detection constants', () => {
  it('gives non-collinearity blur of 0.0022·D', () => {
    expect(Physics.noncol(800)).toBeCloseTo(1.76, 2);
  });
  it('places the Compton edge at 341 keV and backscatter at 170 keV', () => {
    const s = Physics.spectrum(12);
    expect(s.edge).toBeCloseTo(340.67, 2);
    expect(s.back).toBeCloseTo(170.33, 2);
  });
  it('accepts more photopeak with a wider window', () => {
    expect(Physics.spectrum(12, 400).photoAcceptance).toBeGreaterThan(Physics.spectrum(12, 480).photoAcceptance);
  });
  it('uses material-specific 511 keV attenuation (Gonzalez-Montoro et al. 2022)', () => {
    expect(Physics.materials.LYSO.mu).toBe(0.086);
    expect(Physics.materials.BGO.mu).toBe(0.095);
    expect(Physics.materials.LaBr3.mu).toBe(0.0476);
  });
});

describe('count rates', () => {
  const energy = Physics.spectrum(12, 435);
  it('makes randoms grow with the square of activity at low rates', () => {
    // 1 → 2 MBq keeps dead-time losses negligible.
    const a = Physics.rates(1, 4, energy),
      b = Physics.rates(2, 4, energy);
    expect(b.R / a.R).toBeCloseTo(4, 1);
  });
  it('computes NECR = T² / (T + S + 2R)', () => {
    const r = Physics.rates(300, 4, energy);
    expect(r.necr).toBeCloseTo((r.T * r.T) / (r.T + r.S + 2 * r.R), 6);
  });
});

describe('attenuation and TOF', () => {
  it('makes pair survival independent of the annihilation position', () => {
    const L = 20,
      mu = 0.096;
    for (const p of [0.1, 0.5, 0.9])
      expect(Math.exp(-mu * p * L) * Math.exp(-mu * (1 - p) * L)).toBeCloseTo(Physics.attenuation(mu, L).survival, 12);
  });
  it('maps water to 0.096 cm⁻¹ and air to 0', () => {
    expect(Physics.huToMu(0)).toBe(0.096);
    expect(Physics.huToMu(-1000)).toBe(0);
    expect(Physics.huToMu(1000, 1000)).toBeCloseTo(0.172, 12);
  });
  it('gives about 30 mm localisation for a 200 ps CTR', () => {
    expect(Physics.tof(200, 200).width).toBeCloseTo(29.98, 2);
    expect(Physics.tof(200, 200).gain).toBeCloseTo(200 / 29.979, 2);
  });
});

describe('resolution and quantification', () => {
  it('matches a numerical centre recovery for a blurred sphere', () => {
    const d = 10,
      fwhm = 6,
      s = fwhm / Physics.fwhmSigma,
      h = 0.1;
    // Fraction of an isotropic 3D Gaussian inside a ball of radius d/2, by radial integration.
    let inside = 0;
    for (let r = h / 2; r < d / 2; r += h) inside += 4 * Math.PI * r * r * Math.exp((-r * r) / (2 * s * s)) * h;
    inside /= (2 * Math.PI * s * s) ** 1.5;
    expect(Advanced.recovery(d, fwhm)).toBeCloseTo(inside, 3);
  });
  it('computes SUV with kBq/mL, kg and MBq', () => {
    const v = Advanced.quantify(5, 8, 2, 350, 70);
    expect(v.mean).toBeCloseTo(1, 12);
    expect(v.suvr).toBeCloseTo(2.5, 12);
    expect(Advanced.quantify(5, 4, 2, 350, 70)).toBeNull();
  });
});

describe('scanner scene', () => {
  const S = ScenePhysics.defaults;
  it('scales true rates with the positron fraction', () => {
    const f18 = ScenePhysics.rates({ ...S, isotope: 'F18', uptake: 0 }),
      c11 = ScenePhysics.rates({ ...S, isotope: 'C11', uptake: 0 });
    // Same activity at scan time, so only the positron fraction differs (low-rate regime ratio ≈ br ratio).
    expect(c11.T / f18.T).toBeGreaterThan(1);
    expect(c11.T / f18.T).toBeLessThan(0.998 / 0.969 + 0.002);
  });
  it('leaves the LYSO 20 mm reference unchanged and penalises LaBr₃ capture', () => {
    const lyso = ScenePhysics.rates({ ...S, material: 'LYSO' }),
      labr = ScenePhysics.rates({ ...S, material: 'LaBr3' });
    expect(labr.T).toBeLessThan(lyso.T);
  });
  it('counts valid ring pairs in the Michelogram', () => {
    expect(ScenePhysics.michelogram(9, 8, 1).pairs).toBe(81);
    expect(ScenePhysics.michelogram(9, 0, 1).pairs).toBe(9);
  });
  it('documents the untimed jitter assumption', () => {
    expect(UNTIMED_JITTER_PS).toBe(600);
  });
});
