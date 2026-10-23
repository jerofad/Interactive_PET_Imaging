import { $, idx, paint } from '../core/common.js';
import { chart } from '../core/chart.js';
import { Physics } from '../models/physics.js';

/* Chapters on decay, range, detection, coincidences, attenuation and TOF. */
export function init(phantom) {
  const T = {
    isotope: 'F18',
    activity: 200,
    uptake: 0.5,
    duration: 0.1,
    ring: 800,
    crystal: 'LYSO',
    lower: 435,
    window: 4,
    scanActivity: 200,
    path: 20,
    position: 0.5,
    hu: 0,
    bone: 1000,
    tof: 200,
    diameter: 200,
    dt: 0,
  };
  let tofWorker,
    acWorker,
    tofId = 0,
    tofTimer = null,
    lastConvergence = null;
  const q = $,
    put = (id, text) => (q(id).textContent = text);
  const series = (lo, hi, n, f) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const x = lo + ((hi - lo) * i) / n;
      return [x, f(x)];
    });

  function decayFigure() {
    const iso = Physics.isotopes[T.isotope],
      start = T.uptake * iso.half,
      duration = T.duration * iso.half,
      max = 5 * iso.half;
    chart('decayPlot', {
      xmin: 0,
      xmax: max,
      ymax: T.activity * 1.1,
      xlabel: 'time since reference (min)',
      ylabel: 'activity (MBq)',
      shade: { from: start, to: start + duration },
      marker: start,
      curves: [
        { data: series(0, max, 250, (t) => Physics.decay(T.activity, t, iso.half)) },
        {
          color: 'anatomy',
          dash: [7, 4],
          data: [
            [0, T.activity],
            [max, T.activity],
          ],
        },
      ],
    });
    put('activityValue', T.activity + ' MBq');
    put('uptakeValue', start.toFixed(2) + ' min');
    put('durationValue', duration.toFixed(2) + ' min');
    put('halfRead', iso.half < 3 ? (iso.half * 60).toFixed(2) + ' s' : iso.half.toFixed(1) + ' min');
    put('decayRead', Physics.decay(T.activity, start, iso.half).toFixed(2) + ' MBq');
    put('windowRead', Physics.windowDecays(T.activity, start, duration, iso.half).toExponential(2));
    put('positronRead', (iso.br * Physics.windowDecays(T.activity, start, duration, iso.half)).toExponential(2));
    q('physIsotope').value = T.isotope;
    q('rangeIsotope').value = T.isotope;
  }
  function rangeFigure() {
    const iso = Physics.isotopes[T.isotope],
      n = Physics.noncol(T.ring),
      sd = n / Physics.fwhmSigma,
      ymax = Math.max(Physics.rangeKernel(0, iso.blur), Physics.gaussian(0, sd)) * 1.1;
    chart('rangePlot', {
      xmin: -20,
      xmax: 20,
      ymax,
      xlabel: 'transverse offset (mm)',
      ylabel: 'normalised density (mm⁻¹)',
      curves: [
        { data: series(-20, 20, 600, (x) => Physics.rangeKernel(x, iso.blur)) },
        { color: 'photon', dash: [6, 3], data: series(-20, 20, 600, (x) => Physics.gaussian(x, sd)) },
      ],
    });
    put('ringValue', T.ring + ' mm');
    put('rangeMean', '≈ ' + iso.mean.toFixed(1) + ' mm');
    put('rangeFwhm', iso.blur.toFixed(2) + ' mm');
    put('noncolRead', n.toFixed(2) + ' mm');
  }
  let energy;
  function energyFigure() {
    const mat = Physics.materials[T.crystal];
    energy = Physics.spectrum(mat.resolution, T.lower);
    chart('energyPlot', {
      xmin: 0,
      xmax: 700,
      ymax: Math.max(...energy.peak, ...energy.scatter, ...energy.compton) * 1.1,
      xlabel: 'measured or deposited energy (keV)',
      ylabel: 'component density (keV⁻¹)',
      shade: { from: T.lower, to: 650 },
      curves: [
        { color: 'detector', data: energy.peak.map((v, i) => [i, v]) },
        { color: 'scatter', dash: [6, 4], data: energy.scatter.map((v, i) => [i, v]) },
        { color: 'random', dash: [2, 4], data: energy.compton.map((v, i) => [i, v]) },
      ],
      marker: energy.edge,
    });
    put('energyValue', T.lower + ' keV');
    put('necrEnergyValue', T.lower + ' keV');
    q('energyLower').value = T.lower;
    q('necrEnergy').value = T.lower;
    put('energyResolution', ((511 * mat.resolution) / 100).toFixed(1) + ' keV');
    put('peakAcceptance', (energy.photoAcceptance * 100).toFixed(1) + '%');
    put('scatterAcceptance', (energy.scatterAcceptance * 100).toFixed(1) + '%');
  }
  function necrFigure() {
    const points = Array.from({ length: 801 }, (_, a) => Physics.rates(a, T.window, energy)),
      peak = points.reduce((best, r, i) => (r.necr > points[best].necr ? i : best), 0),
      now = Physics.rates(T.scanActivity, T.window, energy),
      curves = [
        ['T', 'photon', []],
        ['S', 'scatter', [6, 4]],
        ['R', 'random', [2, 4]],
        ['necr', 'detector', []],
      ].map(([key, color, dash]) => ({
        color,
        dash,
        width: key === 'necr' ? 3 : 2,
        data: points.map((p, a) => [a, p[key] / 1000]),
      })),
      ymax = (Math.max(...points.map((p) => Math.max(p.T, p.S, p.R, p.necr))) / 1000) * 1.1;
    chart('necrPlot', {
      xmin: 0,
      xmax: 800,
      ymax: Math.max(1, ymax),
      xlabel: 'activity present at scan (MBq)',
      ylabel: 'rate (kcps)',
      curves,
      marker: T.scanActivity,
      point: { x: peak, y: points[peak].necr / 1000 },
    });
    put('windowNsValue', T.window + ' ns');
    put('scanActivityValue', T.scanActivity + ' MBq');
    put('necrRead', (now.necr / 1000).toFixed(1) + ' kcps');
    put('sfRead', (now.sf * 100).toFixed(1) + '%');
    put('peakRead', peak + ' MBq');
    put('randomRead', (now.R / 1000).toFixed(1) + ' kcps');
    put('deadRead', ((1 - now.live) * 100).toFixed(1) + '%');
    put('singlesRead', (now.single / 1e6).toFixed(2) + ' Mcps');
  }
  function attenFigure() {
    const a = Physics.attenuation(0.096, T.path);
    chart('attenPlot', {
      xmin: 0,
      xmax: 100,
      ymax: 1.05,
      xlabel: 'annihilation position along water path (%)',
      ylabel: 'unscattered survival probability',
      curves: [
        { color: 'anatomy', data: series(0, 100, 100, (p) => Math.exp((-0.096 * T.path * p) / 100)) },
        { color: 'photon', dash: [6, 4], data: series(0, 100, 100, (p) => Math.exp(-0.096 * T.path * (1 - p / 100))) },
        {
          color: 'detector',
          data: [
            [0, a.survival],
            [100, a.survival],
          ],
        },
      ],
      marker: T.position * 100,
    });
    put('pathValue', T.path + ' cm');
    put('positionValue', (T.position * 100).toFixed(0) + '%');
    put('pairRead', (a.survival * 100).toFixed(2) + '%');
    put('acfRead', a.acf.toFixed(2) + '×');
    put('pathsRead', (T.position * T.path).toFixed(1) + ' + ' + ((1 - T.position) * T.path).toFixed(1));
    huFigure();
  }
  function huFigure() {
    chart('huPlot', {
      xmin: -1000,
      xmax: 2000,
      ymax: Physics.huToMu(2000, T.bone) * 1.1,
      xlabel: 'CT number (HU)',
      ylabel: 'μ at 511 keV (cm⁻¹)',
      curves: [{ color: 'anatomy', data: series(-1000, 2000, 200, (h) => Physics.huToMu(h, T.bone)) }],
      marker: T.hu,
      point: { x: T.hu, y: Physics.huToMu(T.hu, T.bone), color: 'activity' },
    });
    put('huValue', T.hu + ' HU');
    put('boneValue', T.bone + ' HU');
    put('muRead', Physics.huToMu(T.hu, T.bone).toFixed(4) + ' cm⁻¹');
  }
  function tofFigure() {
    const f = Physics.tof(T.tof, T.diameter, T.dt),
      support = series(-250, 250, 500, (x) => (Math.abs(x) <= T.diameter / 2 ? 1 / T.diameter : 0)),
      sd = f.width / Physics.fwhmSigma,
      curves = [{ color: 'random', dash: [5, 4], data: support }];
    if (T.tof)
      curves.push({ color: 'photon', data: series(-250, 250, 700, (x) => Physics.gaussian(x - f.position, sd)) });
    chart('tofPlot', {
      xmin: -250,
      xmax: 250,
      ymax: Math.max(1 / T.diameter, T.tof ? Physics.gaussian(0, sd) : 0) * 1.1,
      xlabel: 'position along the LOR (mm)',
      ylabel: 'density (mm⁻¹)',
      curves,
      shade: { from: -T.diameter / 2, to: T.diameter / 2, color: 'anatomy' },
      marker: T.tof ? f.position : undefined,
    });
    put('objectValue', T.diameter + ' mm');
    put('dtValue', T.dt + ' ps');
    put('tofWidth', T.tof ? f.width.toFixed(2) + ' mm' : 'No TOF');
    put('tofGain', f.gain.toFixed(2) + '×');
    put('tofPosition', T.tof ? (f.position >= 0 ? '+' : '') + f.position.toFixed(2) + ' mm' : 'Unknown');
    q('timeDifference').disabled = !T.tof;
  }
  function convergenceFigure() {
    if (!lastConvergence) return;
    chart('tofConvergence', {
      xmin: 0,
      xmax: 20,
      ymax: Math.max(...lastConvergence.plain, ...lastConvergence.timed) * 1.1,
      xlabel: 'complete MLEM iteration',
      ylabel: 'relative reconstruction error (NRMSE)',
      curves: [
        { color: 'random', dash: [6, 4], data: lastConvergence.plain.map((v, i) => [i, v]) },
        { color: 'photon', data: lastConvergence.timed.map((v, i) => [i, v]) },
      ],
    });
  }
  function repaint() {
    decayFigure();
    rangeFigure();
    energyFigure();
    necrFigure();
    attenFigure();
    tofFigure();
    convergenceFigure();
  }
  function update(key, value) {
    if (!Object.hasOwn(T, key)) throw Error('Unknown physics setting');
    T[key] = value;
    repaint();
    if (key === 'tof') queueTOF();
  }
  const bindings = {
    physIsotope: ['isotope', false],
    rangeIsotope: ['isotope', false],
    physActivity: ['activity', true],
    physUptake: ['uptake', true],
    physDuration: ['duration', true],
    ringDiameter: ['ring', true],
    crystalSelect: ['crystal', false],
    energyLower: ['lower', true],
    necrEnergy: ['lower', true],
    coincidenceWindow: ['window', true],
    scanActivity: ['scanActivity', true],
    waterPath: ['path', true],
    sourcePosition: ['position', true, 0.01],
    huInput: ['hu', true],
    boneAnchor: ['bone', true],
    tofResolution: ['tof', true],
    objectDiameter: ['diameter', true],
    timeDifference: ['dt', true],
  };
  for (const [id, [key, numeric, scale = 1]] of Object.entries(bindings)) {
    q(id).addEventListener('input', (e) => update(key, numeric ? +e.target.value * scale : e.target.value));
  }
  q('theme').addEventListener('change', repaint);
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change', repaint);
  // Background reconstructions start only on pages that show their figures.
  const wantsAC = !!document.getElementById('acOn'),
    wantsTOF = !!document.getElementById('tofConvergence');
  const activity64 = new Float64Array(4096),
    mu64 = new Float64Array(4096),
    activity32 = new Float64Array(1024);
  if (phantom && (wantsAC || wantsTOF)) {
    const { volume, tissue } = phantom;
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const i = idx(2 * x + dx, 2 * y + dy, 51);
            activity64[y * 64 + x] += volume[i] / 128;
            mu64[y * 64 + x] += (tissue[i] > 0 ? 0.096 : 0) / 4;
          }
        activity32[Math.floor(y / 2) * 32 + Math.floor(x / 2)] += activity64[y * 64 + x] / 4;
      }
  }
  function worker() {
    return new Worker(new URL('../workers/theory.worker.js', import.meta.url), { type: 'module' });
  }
  function runTOF() {
    if (!tofWorker) return;
    const id = ++tofId;
    lastConvergence = null;
    chart('tofConvergence', {
      xmin: 0,
      xmax: 20,
      ymax: 1,
      xlabel: 'complete MLEM iteration',
      ylabel: 'computing NRMSE…',
    });
    put('tofStatus', 'Computing matched ' + (T.tof ? T.tof + ' ps' : 'non-TOF') + ' and non-TOF reconstructions…');
    tofWorker.postMessage({ id, type: 'tof', ps: T.tof, activity: activity32 });
  }
  function queueTOF() {
    clearTimeout(tofTimer);
    if (tofWorker) {
      tofId++;
      tofWorker.postMessage({ type: 'cancel' });
      put('tofStatus', 'Timing resolution changed. Recomputing…');
      tofTimer = setTimeout(runTOF, 150);
    }
  }
  try {
    if (wantsAC && phantom) {
      acWorker = worker();
      acWorker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'error') {
          put('acStatus', 'Comparison unavailable: ' + d.message);
          return;
        }
        if (d.type === 'attenuation') {
          paint(q('acOff'), Float32Array.from(d.uncorrected).reverse(), 64, 64, 'inferno');
          paint(q('acOn'), Float32Array.from(d.corrected).reverse(), 64, 64, 'inferno');
          put('acStatus', 'Computed from identical expected measurements. Same 0–7 a.u. scale for both images.');
          acWorker.terminate();
        }
      };
      acWorker.onerror = () => put('acStatus', 'The comparison worker could not run. The main lab remains available.');
      acWorker.postMessage({ id: 1, type: 'attenuation', activity: activity64, mu: mu64 });
    }
    if (wantsTOF && phantom) {
      tofWorker = worker();
      tofWorker.onmessage = (e) => {
        const d = e.data;
        if (d.id !== tofId) return;
        if (d.type === 'error') {
          put('tofStatus', 'TOF experiment unavailable: ' + d.message);
          return;
        }
        if (d.type === 'tof') {
          lastConvergence = d;
          convergenceFigure();
          put(
            'tofStatus',
            'Computed · ' +
              (d.ps ? d.ps + ' ps' : 'TOF off') +
              ' · final NRMSE ' +
              (d.timed.at(-1) * 100).toFixed(1) +
              '% versus ' +
              (d.plain.at(-1) * 100).toFixed(1) +
              '% without TOF. Expected-count relative difference ' +
              d.conservation.toExponential(1) +
              '.',
          );
        }
      };
      tofWorker.onerror = () =>
        put('tofStatus', 'The TOF worker could not run. Analytic timing controls remain available.');
      runTOF();
    }
  } catch (e) {
    put('acStatus', 'Reconstruction comparison unavailable in this browser.');
    put('tofStatus', 'TOF reconstruction comparison unavailable; analytic figures still work.');
  }
  window.petPhysics = { state: T, update, repaint, model: Physics, chart };
  let resizeTimer;
  window.addEventListener?.('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(repaint, 120);
  });
  repaint();
}
