/* Teaching models for decay, range, detection, count rates, attenuation and TOF.
   Constants and assumptions are cited in the pages. */
export const Physics = (() => {
  const c = 0.299792458,
    fwhmSigma = 2 * Math.sqrt(2 * Math.log(2)); // mm/ps
  // half: physical half-life (min). mean: mean positron range in water (mm). blur: effective range-blur FWHM (mm).
  // br: positron (β⁺) fraction per decay, Conti & Eriksson (2016) Tables 1–2; for Ga-68 and Rb-82 the sum of the
  // two listed branches.
  const isotopes = {
    F18: { label: 'F-18', half: 110, mean: 0.6, blur: 0.54, br: 0.969 },
    C11: { label: 'C-11', half: 20.4, mean: 1.2, blur: 0.92, br: 0.998 },
    Ga68: { label: 'Ga-68', half: 67.8, mean: 3.5, blur: 2.83, br: 0.889 },
    O15: { label: 'O-15', half: 122.24 / 60, mean: 3, blur: 2.48, br: 0.999 },
    Rb82: { label: 'Rb-82', half: 75.45 / 60, mean: 7.1, blur: 6.14, br: 0.949 },
  };
  // resolution: energy FWHM at 511 keV (%). decay: light-decay time (ns). light: photons/MeV (IAEA 2009, Table 2).
  // mu: linear attenuation coefficient at 511 keV (mm⁻¹), Gonzalez-Montoro et al. (2022) Table 1; LSO value for LYSO.
  const materials = {
    LYSO: { resolution: 12, decay: 40, light: 32000, mu: 0.086 },
    BGO: { resolution: 20, decay: 300, light: 9000, mu: 0.095 },
    LaBr3: { resolution: 10, decay: 25, light: 60000, mu: 0.0476 },
  };
  function decay(a0, t, half) {
    return a0 * 2 ** (-t / half);
  }
  function windowDecays(a0, start, duration, half) {
    const lambda = Math.LN2 / half;
    return (a0 * 1e6 * 60 * Math.exp(-lambda * start) * -Math.expm1(-lambda * duration)) / lambda;
  }
  function gaussian(x, sd) {
    return Math.exp((-x * x) / (2 * sd * sd)) / (Math.sqrt(2 * Math.PI) * sd);
  }
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    return (
      sign *
      (1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
          t *
          Math.exp(-x * x))
    );
  }
  const cdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  const pairAngleFwhm = 0.0088; // rad, approximately 0.50 degrees in each transverse projection
  const noncol = (d) => (pairAngleFwhm * d) / 4;
  function rangeKernel(x, fwhm) {
    const b = fwhm / (2 * Math.LN2);
    return Math.exp(-Math.abs(x) / b) / (2 * b);
  } // Laplace proxy, matched quoted effective FWHM, not mean range.
  function spectrum(resolution, lower = 435, upper = 650) {
    const peak = [],
      scatter = [],
      compton = [],
      combined = [];
    let photoAcceptance = 0,
      scatterAcceptance = 0,
      totalAcceptance = 0;
    const edge = (511 * 2) / 3,
      back = 511 / 3,
      sd = (511 * resolution) / 100 / fwhmSigma;
    for (let e = 0; e <= 700; e++) {
      const p = gaussian(e - 511, sd),
        s = e >= back && e <= 511 ? (2 * (e - back)) / (511 - back) ** 2 : 0,
        k = e >= 0 && e <= edge ? (2 * (0.4 + (0.6 * e) / edge)) / (1.4 * edge) : 0,
        m = 0.6 * p + 0.25 * s + 0.15 * k;
      peak.push(p);
      scatter.push(s);
      compton.push(k);
      combined.push(m);
      if (e >= lower && e <= upper) {
        photoAcceptance += p;
        scatterAcceptance += s;
        totalAcceptance += m;
      }
    }
    return {
      peak,
      scatter,
      compton,
      combined,
      photoAcceptance: Math.min(1, photoAcceptance),
      scatterAcceptance: Math.min(1, scatterAcceptance),
      totalAcceptance: Math.min(1, totalAcceptance),
      edge,
      back,
      sd,
    };
  }
  function rates(activity, widthNs, energy) {
    const p = energy.photoAcceptance,
      q = energy.scatterAcceptance,
      eff = 0.65 * p + 0.35 * q,
      inputSingles = 30000 * activity * eff,
      live = Math.exp(-40e-9 * inputSingles),
      single = inputSingles * live,
      T = 1500 * activity * p * p * live * live,
      S = 2000 * activity * p * q * live * live,
      R = widthNs * 1e-9 * single * single,
      den = T + S + 2 * R;
    return { T, S, R, single, live, necr: den ? (T * T) / den : 0, sf: T + S ? S / (T + S) : 0 };
  }
  function attenuation(mu, length) {
    return { survival: Math.exp(-mu * length), acf: Math.exp(mu * length) };
  }
  function huToMu(hu, boneHU = 1000) {
    return hu <= 0 ? 0.096 * Math.max(0, 1 + hu / 1000) : 0.096 + ((0.172 - 0.096) * hu) / boneHU;
  }
  function tof(ps, diameterMm, dt = 0) {
    const width = ps ? (c * ps) / 2 : Infinity,
      gain = ps ? Math.max(1, diameterMm / width) : 1;
    return { width, gain, snr: Math.sqrt(gain), position: (c * dt) / 2 };
  }
  return {
    c,
    fwhmSigma,
    pairAngleFwhm,
    isotopes,
    materials,
    decay,
    windowDecays,
    gaussian,
    erf,
    cdf,
    noncol,
    rangeKernel,
    spectrum,
    rates,
    attenuation,
    huToMu,
    tof,
  };
})();
export default Physics;
