/* 3D scene physics. Coordinates [R,A,S] in mm; timestamps in ns. Explicit toy assumptions in the pages. */
import { Physics } from './physics.js';
import { Advanced } from './advanced.js';
// With TOF off, the coincidence test still sees timing jitter; this assumed value applies to every material.
export const UNTIMED_JITTER_PS = 600;

export const ScenePhysics = (() => {
  const F = Physics,
    A = Advanced,
    c = 299.792458;
  const defaults = {
    isotope: 'F18',
    activity: 200,
    uptake: 60,
    duration: 120,
    ring: 800,
    fov: 200,
    crystal: 4,
    depth: 20,
    doi: false,
    material: 'LYSO',
    lower: 435,
    window: 4,
    tof: 200,
    mode: '3D',
    algorithm: 'OSEM',
    iterations: 3,
    subsets: 20,
    filter: 4,
    psf: false,
    normalisation: true,
    attenuation: true,
    scatter: true,
    randoms: true,
    decay: true,
  };
  const add = (a, b, k = 1) => a.map((v, i) => v + k * b[i]),
    dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0),
    norm = (a) => Math.hypot(...a),
    unit = (a) => a.map((v) => v / norm(a));
  const rng = (seed) => () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed + 0.5) / 4294967296;
  };
  const normal = (r) => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
  function isotropic(r) {
    const z = 2 * r() - 1,
      phi = 2 * Math.PI * r(),
      a = Math.sqrt(1 - z * z);
    return [a * Math.cos(phi), a * Math.sin(phi), z];
  }
  function turn(u, cos, phi) {
    const ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0],
      v = unit([u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]]),
      w = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    return u.map((x, i) => x * cos + sin * (v[i] * Math.cos(phi) + w[i] * Math.sin(phi)));
  }
  function partnerDirection(u, r) {
    const a = (normal(r) * F.pairAngleFwhm) / F.fwhmSigma,
      b = (normal(r) * F.pairAngleFwhm) / F.fwhmSigma;
    return turn(u, -Math.cos(Math.hypot(a, b)), Math.atan2(b, a));
  }
  function hitCylinder(p, u, radius, length) {
    const aa = u[0] ** 2 + u[1] ** 2;
    if (aa < 1e-12) return null;
    const b = p[0] * u[0] + p[1] * u[1],
      cc = p[0] ** 2 + p[1] ** 2 - radius ** 2,
      disc = b * b - aa * cc;
    if (disc < 0) return null;
    const t = (-b + Math.sqrt(disc)) / aa;
    if (t <= 0) return null;
    const hit = add(p, u, t);
    return Math.abs(hit[2]) <= length / 2 ? { point: hit, distance: t } : null;
  }
  function sampler(v) {
    const indices = [],
      cdf = [];
    let total = 0;
    for (let i = 0; i < v.length; i++)
      if (v[i]) {
        total += v[i];
        indices.push(i);
        cdf.push(total);
      }
    const sample = (r) => {
      const target = r() * total;
      let lo = 0,
        hi = cdf.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const i = indices[lo];
      return {
        point: [
          ((i % 128) + r() - 64) * 2,
          ((Math.floor(i / 128) % 128) + r() - 64) * 2,
          (Math.floor(i / 16384) + r() - 48) * 2,
        ],
        value: v[i] / 32,
        index: i,
      };
    };
    return { sample, total, voxels: indices.length };
  }
  function muAt(tissue, p) {
    const x = Math.floor(p[0] / 2 + 64),
      y = Math.floor(p[1] / 2 + 64),
      z = Math.floor(p[2] / 2 + 48);
    return x >= 0 && x < 128 && y >= 0 && y < 128 && z >= 0 && z < 96 && tissue[(z * 128 + y) * 128 + x] > 0
      ? 0.0096
      : 0;
  } // mm^-1
  function optical(tissue, p, u, distance, target = Infinity) {
    const step = 4,
      n = Math.ceil(distance / step),
      ds = distance / n;
    let tau = 0;
    for (let k = 0; k < n; k++) {
      tau += muAt(tissue, add(p, u, (k + 0.5) * ds)) * ds;
      if (tau >= target) return { tau, distance: (k + 0.5) * ds };
    }
    return { tau, distance: null };
  }
  function kleinNishina(r, energy = 511) {
    for (;;) {
      const cos = 2 * r() - 1,
        k = 1 / (1 + (energy / 511) * (1 - cos)),
        weight = k * k * (k + 1 / k - (1 - cos * cos));
      if (2 * r() <= weight) return { cos, energy: energy * k };
    }
  }
  function geometry(s) {
    const circum = Math.round((Math.PI * s.ring) / s.crystal),
      rings = Math.max(1, Math.round(s.fov / s.crystal)),
      detectors = circum * rings;
    return { circum, rings, detectors, radial: s.crystal / 2, acceptance: s.fov / Math.hypot(s.ring, s.fov) };
  }
  function detector(hit, s) {
    const g = geometry(s),
      phi = (Math.atan2(hit[1], hit[0]) + 2 * Math.PI) % (2 * Math.PI),
      angular = Math.min(g.circum - 1, Math.floor((phi / (2 * Math.PI)) * g.circum)),
      ring = Math.min(g.rings - 1, Math.max(0, Math.floor((hit[2] / s.fov + 0.5) * g.rings)));
    return { id: ring * g.circum + angular, ring, angular };
  }
  function rates(s, elapsed = 0) {
    const half = F.isotopes[s.isotope].half,
      activity = F.decay(s.activity, s.uptake + elapsed / 60, half),
      energy = F.spectrum(F.materials[s.material].resolution, s.lower),
      // Count rates follow the positron emission rate, not the total decay rate.
      base = F.rates(activity * F.isotopes[s.isotope].br, s.window, energy),
      geo = geometry(s).acceptance / (200 / Math.hypot(800, 200)),
      // Pair capture relative to the 20 mm LYSO reference geometry.
      capture =
        ((1 - Math.exp(-F.materials[s.material].mu * s.depth)) / (1 - Math.exp(-F.materials.LYSO.mu * 20))) ** 2,
      scale = geo * capture,
      plane = s.mode === '2D' ? 0.18 : 1;
    const T = base.T * scale * plane,
      S = base.S * scale * plane * (s.mode === '2D' ? 0.35 : 1),
      R = base.R * scale * plane * plane,
      den = T + S + 2 * R;
    return {
      activity,
      T,
      S,
      R,
      total: T + S + R,
      necr: den ? (T * T) / den : 0,
      sf: T + S ? S / (T + S) : 0,
      rf: T + S + R ? R / (T + S + R) : 0,
      dead: 1 - base.live,
      live: base.live,
    };
  }
  function scanBudget(s) {
    const N = 40,
      dt = s.duration / N,
      totals = { T: 0, S: 0, R: 0 };
    for (let i = 0; i < N; i++) {
      const v = rates(s, (i + 0.5) * dt);
      for (const k of ['T', 'S', 'R']) totals[k] += v[k] * dt;
    }
    const half = F.isotopes[s.isotope].half,
      decay = F.windowDecays(1, s.uptake, s.duration / 60, half) / (1e6 * s.duration);
    return { ...totals, total: totals.T + totals.S + totals.R, decay };
  }
  function blur(s, radial = 0) {
    return A.resolution({ crystal: s.crystal, ring: s.ring, isotope: s.isotope, radial, doi: s.doi, depth: s.depth })
      .fwhm;
  }
  function photon(p, u, s, tissue, r) {
    let hit = hitCylinder(p, u, s.ring / 2, s.fov);
    if (!hit) return null;
    let points = [p],
      energy = 511,
      scatter = false,
      distance = 0;
    const interaction = optical(tissue, p, u, hit.distance, -Math.log(r()));
    if (interaction.distance !== null) {
      const q = add(p, u, interaction.distance),
        kn = kleinNishina(r);
      u = turn(u, kn.cos, 2 * Math.PI * r());
      hit = hitCylinder(q, u, s.ring / 2, s.fov);
      if (!hit) return null;
      points.push(q);
      distance += interaction.distance;
      energy = kn.energy;
      scatter = true;
      if (r() > Math.exp(-optical(tissue, q, u, hit.distance).tau)) return null;
    }
    distance += hit.distance;
    points.push(hit.point);
    const radial = unit([hit.point[0], hit.point[1], 0]),
      cos = Math.max(0.02, Math.abs(dot(radial, u))),
      capture = 1 - Math.exp((-F.materials[s.material].mu * s.depth) / cos);
    if (r() > capture) return null;
    const measured = energy + (normal(r) * energy * F.materials[s.material].resolution) / 100 / F.fwhmSigma;
    if (measured < s.lower || measured > 650) return null;
    return { points, energy: measured, scatter, distance, hit: hit.point, ...detector(hit.point, s) };
  }
  function event(s, source, tissue, r) {
    const rate = rates(s),
      random = r() < rate.rf;
    for (let trial = 0; trial < 160; trial++) {
      const origin = source.sample(r).point,
        range = -F.isotopes[s.isotope].mean * Math.log(r()),
        annihilation = add(origin, isotropic(r), range),
        direction = isotropic(r),
        u2 = partnerDirection(direction, r),
        a = photon(annihilation, direction, s, tissue, r);
      if (!a) continue;
      const origin2 = random ? source.sample(r).point : origin,
        annihilation2 = random ? origin2 : annihilation,
        b = photon(annihilation2, random ? isotropic(r) : u2, s, tissue, r);
      if (!b) continue;
      if (s.mode === '2D' && Math.abs(a.ring - b.ring) > 1) continue;
      const dt = random
        ? (r() - 0.5) * s.window
        : (b.distance - a.distance) / c + (normal(r) * (s.tof || UNTIMED_JITTER_PS)) / 1000 / F.fwhmSigma;
      if (Math.abs(dt) > s.window / 2) continue;
      return {
        origin,
        annihilation,
        origin2,
        annihilation2,
        arms: [a, b],
        kind: random ? 'random' : a.scatter || b.scatter ? 'scatter' : 'true',
        dt,
        range,
        trial: trial + 1,
        tofPosition: random ? null : (c * dt) / 2,
      };
    }
    return null;
  }
  function lor(p, angle) {
    return p[0] * Math.cos(angle) + p[1] * Math.sin(angle);
  }
  function michelogram(rings = 9, maxDifference = 4, span = 3) {
    const groups = new Map(),
      cells = [];
    for (let a = 0; a < rings; a++)
      for (let b = 0; b < rings; b++) {
        const d = b - a,
          valid = Math.abs(d) <= maxDifference,
          segment = Math.sign(d) * Math.floor((Math.abs(d) + (span - 1) / 2) / span),
          axial = a + b,
          key = segment + ':' + axial;
        if (valid) groups.set(key, (groups.get(key) || 0) + 1);
        cells.push({ a, b, d, valid, segment, axial });
      }
    return { cells, planes: groups.size, pairs: cells.filter((x) => x.valid).length };
  }
  function pulse(t, arrival, decay = 40, rise = 0.5) {
    const u = t - arrival;
    if (u < 0) return 0;
    const peak = Math.log(decay / rise) / (1 / rise - 1 / decay),
      max = Math.exp(-peak / decay) - Math.exp(-peak / rise);
    return (Math.exp(-u / decay) - Math.exp(-u / rise)) / max;
  }
  function cfd(decay = 40, rise = 0.5, fraction = 0.2) {
    let lo = 0,
      hi = Math.log(decay / rise) / (1 / rise - 1 / decay);
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (pulse(mid, 0, decay, rise) < fraction) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  function timing(s, position = 60) {
    const near = (s.ring / 2 - position) / c,
      far = (s.ring / 2 + position) / c,
      tau = F.materials[s.material].decay,
      offset = cfd(tau),
      delta = far - near;
    return {
      near,
      far,
      delta,
      x: (c * delta) / 2,
      tau,
      cfdNear: near + offset,
      cfdFar: far + offset,
      gate: 5 * tau,
      decision: far + 5 * tau,
      delayed: 500,
      end: far + 5 * tau + 520,
      accepted: Math.abs(delta) <= s.window / 2,
      localisation: s.tof ? (s.tof * c) / 2000 : null,
    };
  }
  return {
    defaults,
    c,
    rng,
    normal,
    add,
    dot,
    norm,
    unit,
    isotropic,
    turn,
    partnerDirection,
    hitCylinder,
    sampler,
    muAt,
    optical,
    kleinNishina,
    geometry,
    detector,
    rates,
    scanBudget,
    blur,
    event,
    lor,
    michelogram,
    pulse,
    cfd,
    timing,
  };
})();
export default ScenePhysics;
