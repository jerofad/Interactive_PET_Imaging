import { PET } from '../models/pet.js';

let geometryCache = null,
  currentJob = 0;
const yieldWorker = () => new Promise((resolve) => setTimeout(resolve, 0));
self.onmessage = async (e) => {
  const job = ++currentJob,
    req = e.data;
  if (req.type === 'cancel') return;
  const id = req.id;
  try {
    if (!geometryCache) {
      self.postMessage({ id, type: 'status', text: 'Preparing Siddon ray paths…' });
      await yieldWorker();
      geometryCache = PET.geometry();
    }
    if (job !== currentJob) return;
    const g = geometryCache,
      start = performance.now(),
      p = PET.phantom(g, req.kind, req.activity, req.mu),
      d = PET.acquire(g, p, req.counts, req.seed, req.noise),
      m = PET.model(g, d, req.corrections);
    self.postMessage({
      id,
      type: 'data',
      truth: p.x,
      sino: d.y,
      expected: d.expected,
      mu: p.mu,
      promptSum: d.promptSum,
      exposure: d.exposure,
      maxSino: Math.max(...d.y),
      rayCount: g.rows,
      segments: g.indices.length,
    });
    await yieldWorker();
    if (job !== currentJob) return;
    let history = [],
      maxStepMs = 0;
    const finishFrame = (x, update, iteration, done = false) => {
      const predicted = PET.predict(g, x, m),
        ll = PET.logLikelihood(d.y, predicted),
        dev = PET.deviance(d.y, predicted);
      if (req.algorithm !== 'FBP') history.push({ update, iteration, ll, dev });
      const displayed = PET.smooth(x, g.n, req.filter, g.dx),
        met = PET.metrics(displayed, p.x),
        ratio = Float64Array.from(d.y, (v, i) => v / Math.max(predicted[i], 1e-15));
      self.postMessage({
        id,
        type: 'frame',
        image: displayed,
        ratio,
        history,
        metrics: met,
        update,
        iteration,
        done,
        elapsedMs: performance.now() - start,
        maxStepMs,
        rawDeviance: dev,
      });
    };
    if (req.algorithm === 'FBP') {
      const t = performance.now(),
        x = PET.fbp(g, d, m);
      maxStepMs = performance.now() - t;
      finishFrame(x, 1, 1, true);
      return;
    }
    const subsets = req.algorithm === 'OSEM' ? req.subsets : 1,
      em = PET.prepareEM(g, d, m, subsets);
    finishFrame(em.x, 0, 0);
    await yieldWorker();
    for (let i = 0; i < req.iterations; i++) {
      for (let s = 0; s < subsets; s++) {
        if (job !== currentJob) return;
        const t = performance.now();
        PET.emStep(g, d, m, em, s);
        maxStepMs = Math.max(maxStepMs, performance.now() - t);
        await yieldWorker();
      }
      if (job !== currentJob) return;
      finishFrame(em.x, (i + 1) * subsets, i + 1, i + 1 === req.iterations);
      await yieldWorker();
    }
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message || String(error) });
  }
};
