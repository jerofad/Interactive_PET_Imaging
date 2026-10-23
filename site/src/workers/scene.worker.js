import { PET } from '../models/pet.js';
import { ScenePhysics } from '../models/scene.js';

/* Cumulative 2D diagnostic data and actual reconstruction film, isolated from the main lab. */
const sceneJobs = {};
let sceneGeometry;
const waitScene = () => new Promise((r) => setTimeout(r, 0)),
  validScene = (m) => sceneJobs[m.channel] === m.id;
const postScene = (m, d) => self.postMessage({ channel: m.channel, id: m.id, ...d });
function roiMetrics(x, truth) {
  let peak = 0,
    background = 0,
    n = 0;
  for (let i = 0; i < x.length; i++) {
    const xx = ((i % 64) + 0.5 - 32) * 4,
      yy = (Math.floor(i / 64) + 0.5 - 32) * 4;
    if (Math.hypot(xx + 34, yy - 16) < 8) peak = Math.max(peak, x[i]);
    if (truth[i] === 1) {
      background += x[i];
      n++;
    }
  }
  return { peak, background: n ? background / n : 0 };
}
function sceneData(g, p, s, N, seed, noise = true) {
  const budget = ScenePhysics.scanBudget(s),
    f = budget.decay,
    blur = ScenePhysics.blur(s),
    input = PET.smooth(p.x, g.n, blur, g.dx),
    d = PET.acquire(g, { x: Float64Array.from(input, (v) => v * f), mu: p.mu }, N, seed, false),
    factors = [budget.T / budget.total / 0.65, budget.S / budget.total / 0.25, budget.R / budget.total / 0.1];
  d.exposure *= factors[0];
  for (let i = 0; i < d.y.length; i++) {
    d.t[i] *= factors[0];
    d.s[i] *= factors[1];
    d.r[i] *= factors[2];
    d.expected[i] = d.t[i] + d.s[i] + d.r[i];
  }
  const r = PET.random(seed);
  d.y = Float64Array.from(d.expected, (v) => (noise ? PET.poisson(v, r) : v));
  d.promptSum = PET.sum(d.y);
  return { d, f, blur, budget };
}
function sceneModel(g, d, s, f) {
  const model = PET.model(g, d, s);
  if (s.decay) for (let i = 0; i < model.weights.length; i++) model.weights[i] *= f;
  return model;
}
function sceneEM(g, d, model, subsets, blur) {
  const em = PET.prepareEM(g, d, model, subsets);
  if (blur) {
    em.sens = [];
    for (let j = 0; j < subsets; j++) {
      const w = Float64Array.from(model.weights, (v, i) => (Math.floor(i / g.bins) % subsets === j ? v : 0));
      em.sens.push(PET.smooth(PET.back(g, w), g.n, blur, g.dx));
    }
  }
  return em;
}
function sceneStep(g, d, model, em, subset, blur) {
  if (!blur) {
    PET.emStep(g, d, model, em, subset);
    return;
  }
  const q = PET.predict(g, PET.smooth(em.x, g.n, blur, g.dx), model),
    ratio = Float64Array.from(q, (v, i) =>
      Math.floor(i / g.bins) % em.subsets === subset ? (model.weights[i] * d.y[i]) / Math.max(v, 1e-15) : 0,
    ),
    back = PET.smooth(PET.back(g, ratio), g.n, blur, g.dx);
  for (let i = 0; i < em.x.length; i++) em.x[i] = em.sens[subset][i] > 0 ? (em.x[i] * back[i]) / em.sens[subset][i] : 0;
}
async function sceneFit(m, g, d, model, s, blur, steps = s.iterations) {
  if (s.algorithm === 'FBP') return PET.smooth(PET.fbp(g, d, model), 64, s.filter, 0.4);
  const subsets = s.algorithm === 'OSEM' ? s.subsets : 1,
    em = sceneEM(g, d, model, subsets, blur);
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < subsets; j++) {
      if (!validScene(m)) return null;
      sceneStep(g, d, model, em, j, blur);
      await waitScene();
    }
  return PET.smooth(em.x, 64, s.filter, 0.4);
}
async function acquisition(m, g, p) {
  const s = m.settings,
    { d, f, blur, budget } = sceneData(g, p, s, Math.min(1e9, ScenePhysics.scanBudget(s).total), 71, false),
    r = PET.random(991),
    y = new Float64Array(g.rows),
    totals = { T: 0, S: 0, R: 0 },
    levels = [0.005, 0.015, 0.04, 0.08, 0.15, 0.25, 0.4, 0.6, 0.8, 1];
  let previous = 0;
  for (const fraction of levels) {
    if (!validScene(m)) return;
    for (let i = 0; i < y.length; i++) {
      const t = PET.poisson(d.t[i] * (fraction - previous), r),
        sc = PET.poisson(d.s[i] * (fraction - previous), r),
        ra = PET.poisson(d.r[i] * (fraction - previous), r);
      y[i] += t + sc + ra;
      totals.T += t;
      totals.S += sc;
      totals.R += ra;
    }
    previous = fraction;
    const current = {
        ...d,
        y: Float64Array.from(y),
        exposure: d.exposure * fraction,
        s: Float64Array.from(d.s, (v) => v * fraction),
        r: Float64Array.from(d.r, (v) => v * fraction),
      },
      model = sceneModel(g, current, s, f),
      image = await sceneFit(m, g, current, model, s, s.psf && s.algorithm !== 'FBP' ? blur : 0);
    if (!image) return;
    postScene(m, {
      type: 'frame',
      fraction,
      image: Float32Array.from(image),
      sino: Float32Array.from(y),
      totals: { ...totals },
      elapsed: s.duration * fraction,
      roi: roiMetrics(image, p.x),
      decay: f,
      blur,
      done: fraction === 1,
      capped: budget.total > 1e9,
    });
    await waitScene();
  }
}
async function film(m, g, p) {
  const s = m.settings,
    { d, f, blur } = sceneData(g, p, s, 1e5, 173, true),
    correct = { ...s, normalisation: true, attenuation: true, scatter: true, randoms: true, decay: true },
    model = sceneModel(g, d, correct, f),
    corrected = Float64Array.from(d.y, (v, i) => (v - model.add[i]) / model.weights[i]),
    frames = [];
  // Unfiltered adjoint images are displayed with explicit normalisation, not activity calibration.
  for (const angles of [6, 30, 60, 120]) {
    const y = Float64Array.from(corrected, (v, i) => (Math.floor(i / g.bins) < angles ? v : 0)),
      x = PET.back(g, y),
      max = Math.max(...x);
    frames.push({
      act: 1,
      title: angles + ' / 120 backprojected angles',
      image: Float32Array.from(x, (v) => v / Math.max(max, 1e-15)),
      scale: 1,
      units: 'normalised peak',
      ratio: Float32Array.from(d.y),
      ratioScale: Math.max(...d.y),
      ratioUnits: 'counts/bin',
      update: angles,
      roi: null,
    });
  }
  const fbp = PET.fbp(g, d, model);
  frames.push({
    act: 1,
    title: 'Ram-Lak ramp filter + backprojection',
    image: Float32Array.from(fbp),
    scale: 7,
    units: 'a.u.',
    ratio: Float32Array.from(d.y),
    ratioScale: Math.max(...d.y),
    ratioUnits: 'counts/bin',
    update: 120,
    roi: roiMetrics(fbp, p.x),
  });
  const algorithm = s.algorithm === 'FBP' ? 'MLEM' : s.algorithm,
    subsets = algorithm === 'OSEM' ? s.subsets : 1,
    em = sceneEM(g, d, model, subsets, s.psf ? blur : 0),
    total = s.iterations * subsets,
    history = [];
  for (let k = 0; k <= total; k++) {
    if (!validScene(m)) return;
    const blurred = s.psf ? PET.smooth(em.x, 64, blur, 0.4) : em.x,
      q = PET.predict(g, blurred, model),
      ll = PET.logLikelihood(d.y, q);
    history.push([k, ll]);
    if (k === 0 || k <= 3 || k % Math.max(1, Math.ceil(total / 12)) === 0 || k === total) {
      const ratio = Float64Array.from(d.y, (v, i) => v / Math.max(q[i], 1e-15)),
        weighted = Float64Array.from(ratio, (v, i) => v * model.weights[i]),
        back = PET.back(g, weighted),
        sensitivity = PET.back(g, model.weights),
        b = s.psf ? PET.smooth(back, 64, blur, 0.4) : back,
        sen = s.psf ? PET.smooth(sensitivity, 64, blur, 0.4) : sensitivity;
      frames.push({
        act: 2,
        title: algorithm + ' · update ' + k + ' / ' + total,
        image: Float32Array.from(PET.smooth(em.x, 64, s.filter, 0.4)),
        scale: 7,
        units: 'a.u.',
        ratio: Float32Array.from(ratio),
        ratioScale: 2,
        ratioUnits: 'unitless ratio',
        back: Float32Array.from(b, (v, i) => (sen[i] > 0 ? v / sen[i] : 0)),
        history: history.slice(),
        update: k,
        roi: roiMetrics(PET.smooth(em.x, 64, s.filter, 0.4), p.x),
      });
    }
    if (k < total) {
      sceneStep(g, d, model, em, k % subsets, s.psf ? blur : 0);
      await waitScene();
    }
  }
  const stages = ['None', 'Normalisation', '+ attenuation', '+ scatter', '+ randoms', '+ decay'];
  for (let stage = 0; stage < 6; stage++) {
    if (!validScene(m)) return;
    postScene(m, { type: 'progress', message: 'Correction film: ' + stages[stage] });
    const flags = {
        normalisation: stage >= 1,
        attenuation: stage >= 2,
        scatter: stage >= 3,
        randoms: stage >= 4,
        decay: stage >= 5,
      },
      mm = sceneModel(g, d, flags, f),
      x = await sceneFit(m, g, d, mm, { ...s, algorithm: 'MLEM', subsets: 1, filter: 0 }, s.psf ? blur : 0, 30);
    if (!x) return;
    frames.push({
      act: 3,
      title: stages[stage],
      image: Float32Array.from(x),
      scale: 7,
      units: 'a.u.',
      ratio: Float32Array.from(
        PET.predict(g, s.psf ? PET.smooth(x, 64, blur, 0.4) : x, mm),
        (v, i) => d.y[i] / Math.max(v, 1e-15),
      ),
      ratioScale: 2,
      ratioUnits: 'unitless ratio',
      update: stage,
      roi: roiMetrics(x, p.x),
      decay: f,
    });
    await waitScene();
  }
  postScene(m, {
    type: 'result',
    frames,
    prompts: PET.sum(d.y),
    truth: Float32Array.from(p.x),
    blur,
    decay: f,
    algorithm,
  });
}
self.onmessage = async ({ data: m }) => {
  sceneJobs[m.channel] = m.id;
  if (m.type === 'cancel') return;
  try {
    if (!sceneGeometry) {
      sceneGeometry = PET.geometry();
      await waitScene();
    }
    const g = sceneGeometry,
      p = { x: Float64Array.from(m.activity), mu: Float64Array.from(m.mu) };
    if (m.channel === 'acquisition') await acquisition(m, g, p);
    else if (m.channel === 'film') await film(m, g, p);
    else if (m.channel === 'bench')
      postScene(m, {
        type: 'result',
        phantom: Float32Array.from(PET.forward(g, p.x)),
        point: Float32Array.from(PET.forward(g, PET.phantom(g, 'point').x)),
      });
  } catch (e) {
    if (validScene(m)) postScene(m, { type: 'error', message: e.message });
  }
};
