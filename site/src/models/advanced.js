/* Resolution, recovery, quantification, motion and MIP teaching models. All resolution distances are mm. */
import { Physics } from './physics.js';
export const Advanced = (() => {
  const P = Physics;
  function resolution({ crystal = 4, ring = 800, radial = 0, doi = false, isotope = 'F18', depth = 20 } = {}) {
    const detector = crystal / 2,
      range = P.isotopes[isotope].blur,
      noncol = P.noncol(ring),
      decoding = 2;
    // Uniform depth uncertainty, converted to a Gaussian-equivalent FWHM.
    const parallax = ((P.fwhmSigma * (doi ? 3 : depth)) / Math.sqrt(12)) * Math.sin(Math.atan(radial / (ring / 2)));
    return {
      detector,
      range,
      noncol,
      decoding,
      parallax,
      fwhm: 1.25 * Math.hypot(detector, range, noncol, decoding, parallax),
    };
  }
  function recovery(diameter, fwhm, distance = 0) {
    const r = diameter / 2,
      s = fwhm / P.fwhmSigma,
      u = Math.abs(distance);
    if (!(r > 0)) return 0;
    if (!(s > 0)) return u < r ? 1 : 0;
    const root = Math.SQRT2 * s;
    const v =
      u < 1e-5 * s
        ? P.erf(r / root) - ((Math.sqrt(2 / Math.PI) * r) / s) * Math.exp((-r * r) / (2 * s * s))
        : 0.5 * (P.erf((r + u) / root) + P.erf((r - u) / root)) +
          (s / (Math.sqrt(2 * Math.PI) * u)) *
            (Math.exp(-((r + u) ** 2) / (2 * s * s)) - Math.exp(-((r - u) ** 2) / (2 * s * s)));
    return Math.max(0, Math.min(1, v));
  }
  function quantify(mean, max, reference, dose, weight) {
    if (
      ![mean, max, reference, dose, weight].every(Number.isFinite) ||
      mean < 0 ||
      max < mean ||
      reference <= 0 ||
      dose <= 0 ||
      weight <= 0
    )
      return null;
    return { mean: (mean * weight) / dose, max: (max * weight) / dose, suvr: mean / reference };
  }
  function shift(x, n, sx, sy) {
    const out = new Float64Array(x.length);
    for (let y = 0; y < n; y++)
      for (let xx = 0; xx < n; xx++) {
        const px = xx - sx,
          py = y - sy,
          x0 = Math.floor(px),
          y0 = Math.floor(py),
          fx = px - x0,
          fy = py - y0;
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 2; i++) {
            const a = x0 + i,
              b = y0 + j;
            if (a >= 0 && a < n && b >= 0 && b < n)
              out[y * n + xx] += x[b * n + a] * (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
          }
      }
    return out;
  }
  function mip(v, n, nz, angle, w = 96) {
    const out = new Float32Array(w * nz),
      a = (angle * Math.PI) / 180,
      c = Math.cos(a),
      s = Math.sin(a),
      half = n / 2;
    for (let row = 0; row < nz; row++)
      for (let col = 0; col < w; col++) {
        const u = (w - 1) / 2 - col;
        let max = 0;
        for (let d = -w / 2; d <= w / 2; d += 0.5) {
          const x = Math.floor(c * u - s * d + half),
            y = Math.floor(s * u + c * d + half);
          if (x >= 0 && x < n && y >= 0 && y < n) max = Math.max(max, v[((nz - 1 - row) * n + y) * n + x] / 32);
        }
        out[row * w + col] = max;
      }
    return out;
  }
  return { resolution, recovery, quantify, shift, mip };
})();
export default Advanced;
