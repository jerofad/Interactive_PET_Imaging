import { $, onPage, state, idx, paint } from '../core/common.js';
import { chart } from '../core/chart.js';
import { Advanced } from '../models/advanced.js';

/* Reconstruction statistics, resolution, quantification, artifacts and the MIP. */
export function init({ volume, tissue }) {
  const q = $,
    put = (id, t) => (q(id).textContent = t);
  const S = {
    crystal: 4,
    ring: 800,
    radial: 0,
    doi: false,
    isotope: 'F18',
    diameter: 6,
    iteration: 10,
    kind: 'head',
    severity: 60,
    enabled: true,
    row: 36,
    angle: 0,
  };
  const ids = { ensemble: 0, counts: 0, artifact: 0, mip: 0 },
    statuses = { ensemble: 'biasStatus', counts: 'fractionStatus', artifact: 'artifactStatus', mip: 'mipStatus' };
  let worker,
    biasResult,
    countResult,
    artifactResult,
    mipResult,
    mipPlaying = false,
    mipTimer,
    artifactTimer,
    biasTimer,
    countTimer,
    artifactStarted = false,
    biasStarted = false,
    countsStarted = false;
  const activity64 = new Float64Array(4096),
    mu64 = new Float64Array(4096),
    activity32 = new Float64Array(1024),
    mu32 = new Float64Array(1024),
    mipVolume = new Uint8Array(64 * 64 * 48);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const i = idx(2 * x + dx, 2 * y + dy, 51);
          activity64[y * 64 + x] += volume[i] / 128;
          mu64[y * 64 + x] += (tissue[i] > 0 ? 0.096 : 0) / 4;
        }
      const i = Math.floor(y / 2) * 32 + Math.floor(x / 2);
      activity32[i] += activity64[y * 64 + x] / 4;
      mu32[i] += mu64[y * 64 + x] / 4;
    }
  for (let z = 0; z < 48; z++)
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        let max = 0;
        for (let dz = 0; dz < 2; dz++)
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) max = Math.max(max, volume[idx(2 * x + dx, 2 * y + dy, 2 * z + dz)]);
        mipVolume[(z * 64 + y) * 64 + x] = max;
      }
  const defaults = {
    biasCounts: 100000,
    biasFilter: 0,
    fractionCounts: 1000000,
    suvMean: 5,
    suvMax: 8,
    suvReference: 2,
    suvDose: 200,
    suvWeight: 70,
  };
  for (const [id, v] of Object.entries(defaults)) q(id).value = String(v);
  q('resolutionDOI').checked = false;
  q('artifactEnabled').checked = true;
  q('biasIteration').disabled = true;
  function image(id, x, n = 64) {
    paint(q(id), Float32Array.from(x).reverse(), n, n, 'inferno', null, ['A', 'P', 'R', 'L']);
  }
  function blank(id, n = 64) {
    image(id, new Float32Array(n * n), n);
  }
  function request(channel, extra) {
    if (!worker) {
      put(statuses[channel], 'Interactive computation unavailable in this browser.');
      return;
    }
    const id = ++ids[channel];
    worker.postMessage({ type: 'run', channel, id, ...extra });
  }
  function invalidate(channel) {
    ++ids[channel];
    worker?.postMessage({ type: 'cancel', channel, id: ids[channel] });
  }
  function resolution() {
    const r = Advanced.resolution(S),
      rc = Advanced.recovery(S.diameter, r.fwhm);
    put('crystalSizeValue', S.crystal.toFixed(1) + ' mm');
    put('resolutionRingValue', S.ring + ' mm');
    put('radialOffsetValue', S.radial + ' mm');
    put('resolutionValue', r.fwhm.toFixed(2) + ' mm');
    put('parallaxValue', r.parallax.toFixed(2) + ' mm');
    put(
      'resolutionTerms',
      'Pre-quadrature terms: crystal ' +
        r.detector.toFixed(2) +
        ' · range ' +
        r.range.toFixed(2) +
        ' · non-collinearity ' +
        r.noncol.toFixed(2) +
        ' · decoding ' +
        r.decoding.toFixed(2) +
        ' mm.',
    );
    put('sphereDiameterValue', S.diameter.toFixed(1) + ' mm');
    put('recoveryValue', (100 * rc).toFixed(1) + '%');
    put('sphereCentre', (1 + 6 * rc).toFixed(2) + ' a.u.');
    chart('recoveryPlot', {
      xmin: 0,
      xmax: 30,
      ymax: 1,
      xlabel: 'sphere diameter (mm)',
      ylabel: 'centre contrast recovery (fraction)',
      marker: S.diameter,
      point: { x: S.diameter, y: rc },
      curves: [{ data: Array.from({ length: 151 }, (_, i) => [i / 5, Advanced.recovery(i / 5, r.fwhm)]) }],
    });
    chart('sphereProfile', {
      xmin: -25,
      xmax: 25,
      ymax: 7.5,
      xlabel: 'distance from sphere centre (mm)',
      ylabel: 'activity (a.u.)',
      curves: [
        {
          data: Array.from({ length: 251 }, (_, i) => {
            const x = i / 5 - 25;
            return [x, 1 + 6 * Advanced.recovery(S.diameter, r.fwhm, x)];
          }),
        },
        {
          color: 'anatomy',
          dash: [6, 4],
          data: [
            [-25, 1],
            [-S.diameter / 2, 1],
            [-S.diameter / 2, 7],
            [S.diameter / 2, 7],
            [S.diameter / 2, 1],
            [25, 1],
          ],
        },
      ],
    });
  }
  function quantification() {
    const vals = ['suvMean', 'suvMax', 'suvReference', 'suvDose', 'suvWeight'].map((id) =>
        q(id).value.trim() === '' ? NaN : +q(id).value,
      ),
      v = Advanced.quantify(...vals);
    for (const [id, key] of [
      ['suvMeanRead', 'mean'],
      ['suvMaxRead', 'max'],
      ['suvrRead', 'suvr'],
    ])
      put(id, v ? v[key].toFixed(2) : '—');
    put(
      'suvStatus',
      v
        ? 'Hypothetical inputs only. Mean and maximum refer to the same target ROI; SUVR uses its mean.'
        : 'Enter finite positive weight, dose and reference values, and a non-negative target mean no greater than the maximum.',
    );
  }
  function biasFigure() {
    const curves = biasResult?.curves || [],
      ymax = Math.max(0.1, ...curves.flatMap((x) => [x.bias, x.spread, x.rmse])) * 1.1;
    chart('biasPlot', {
      xmin: 1,
      xmax: 30,
      ymax,
      xlabel: 'complete MLEM iteration',
      ylabel: 'error / truth norm',
      marker: S.iteration,
      curves: [
        { data: curves.map((x) => [x.iteration, x.rmse]) },
        { color: 'anatomy', dash: [6, 4], data: curves.map((x) => [x.iteration, x.bias]) },
        { color: 'random', dash: [2, 4], data: curves.map((x) => [x.iteration, x.spread]) },
      ],
    });
    put('biasIterationValue', S.iteration);
    if (biasResult) {
      image('biasSingle', biasResult.first[S.iteration - 1], 32);
      image('biasMean', biasResult.means[S.iteration - 1], 32);
      const d = curves[S.iteration - 1];
      put(
        'biasStatus',
        'Computed: 8 realisations · ' +
          biasResult.counts.toLocaleString() +
          ' expected prompts · ' +
          biasResult.filter +
          ' mm post-filter. Iteration ' +
          S.iteration +
          ': bias ' +
          (100 * d.bias).toFixed(1) +
          '%, spread ' +
          (100 * d.spread).toFixed(1) +
          '%, total ' +
          (100 * d.rmse).toFixed(1) +
          '%. Images: 0–7 a.u.; R left, A top.',
      );
    }
  }
  function runBias() {
    clearTimeout(biasTimer);
    biasStarted = true;
    biasResult = null;
    q('biasIteration').disabled = true;
    blank('biasSingle', 32);
    blank('biasMean', 32);
    biasFigure();
    put('biasStatus', 'Computing eight independent Poisson reconstructions…');
    request('ensemble', {
      activity: activity32,
      mu: mu32,
      counts: +q('biasCounts').value,
      filter: +q('biasFilter').value,
    });
  }
  function runCounts() {
    clearTimeout(countTimer);
    countsStarted = true;
    countResult = null;
    for (const f of [10, 25, 50, 100]) blank('count' + f);
    put('fractionStatus', 'Computing four independent count levels…');
    request('counts', { activity: activity64, mu: mu64, counts: +q('fractionCounts').value });
  }
  const explanations = {
    head: [
      'Two-position head motion',
      'Half the expected true signal comes from the original head pose and half from a translated pose. Activity and attenuation move together; reconstruction assumes the original static map.',
    ],
    resp: [
      'Periodic motion analogue',
      'Twelve equally weighted phases of a sinusoidal anterior–posterior translation move both activity and attenuation. Reconstruction assumes a static object. This brain slice is a mechanism demonstration, not a respiratory anatomy model.',
    ],
    misreg: [
      'Attenuation-map misregistration',
      'The emission measurement is unchanged, but the attenuation map used for reconstruction is shifted. Rays receive the wrong attenuation correction, producing regional bias.',
    ],
    truncation: [
      'Missing tissue outside the attenuation field',
      'The measured emission still includes the full object. The reconstruction map omits lateral tissue, underestimating attenuation along affected rays.',
    ],
    metal: [
      'An excessive attenuation band',
      'A narrow artificial band is added to the reconstruction μ-map. Overestimated attenuation drives excessive correction. This is a metal-like map error, not a CT metal transport simulation.',
    ],
    void: [
      'An artificial attenuation void',
      'An anterior off-centre ellipse loses attenuation in the reconstruction map. MR susceptibility voids near dental material can cause this type of missing tissue assignment; the inserted shape here is arbitrary.',
    ],
    scatter: [
      'Subtracting too much scatter',
      'The additive scatter estimate is scaled above its true simulated value. EM therefore attributes less of the measured signal to activity. The example uses a broad prescribed scatter field, not a patient-specific single-scatter simulation.',
    ],
    psf: [
      'An overly broad reconstruction PSF',
      'The true image is blurred by a 4 mm Gaussian before projection. The reference models that kernel; the changed reconstruction assumes a broader one. Both EM updates use the same Gaussian in the forward and transpose operators. Excessive deconvolution can create edge overshoot; use the row profile and unclipped peak to inspect it.',
    ],
  };
  function artifactDescription() {
    const [title, description] = explanations[S.kind],
      strength = S.severity / 100;
    put('artifactTitle', title);
    put('artifactExplanation', description);
    put('artifactSeverityValue', S.severity + '%');
    const settings = {
      head: 'Pose separation ' + (12 * strength).toFixed(1) + ' mm.',
      resp: 'Sinusoidal amplitude ±' + (12 * strength).toFixed(1) + ' mm.',
      misreg: 'Reconstruction-map shift ' + (12 * strength).toFixed(1) + ' mm.',
      truncation: 'Map half-width ' + (128 - 65 * strength).toFixed(1) + ' mm.',
      metal: 'Added attenuation ' + (0.18 * strength).toFixed(3) + ' cm⁻¹.',
      void: 'Attenuation removed within ellipse: ' + S.severity + '%.',
      scatter: 'Estimated scatter ' + (1 + 1.5 * strength).toFixed(2) + '× its true value.',
      psf: 'Assumed FWHM ' + (4 + 8 * strength).toFixed(1) + ' mm; true FWHM 4.0 mm.',
    };
    put('artifactSetting', settings[S.kind]);
    put('artifactImageLabel', S.enabled ? 'Effect on' : 'Effect off · reference');
    q('artifactChanged').setAttribute(
      'aria-label',
      S.enabled ? 'Reconstruction with ' + title : 'Reference reconstruction, selected effect off',
    );
  }
  function artifactFigure() {
    artifactDescription();
    put('artifactRowValue', S.row);
    let curves = [],
      ymax = 7.5;
    if (artifactResult) {
      const a = artifactResult.baseline,
        b = S.enabled ? artifactResult.changed : a;
      image('artifactReference', a);
      image('artifactChanged', b);
      const row = (x) => Array.from({ length: 64 }, (_, i) => [(i + 0.5 - 32) * 4, x[S.row * 64 + i]]);
      curves = [
        { data: row(b) },
        { color: 'anatomy', dash: [6, 4], data: row(a) },
        ...(artifactResult.truth ? [{ color: 'random', dash: [2, 4], data: row(artifactResult.truth) }] : []),
      ];
      ymax = Math.max(7.5, ...curves.flatMap((c) => c.data.map((p) => p[1]))) * 1.05;
      put('artifactDifference', (100 * (S.enabled ? artifactResult.difference : 0)).toFixed(1) + '%');
      put(
        'artifactPeak',
        (S.enabled ? artifactResult.changedMax : artifactResult.baselineMax).toFixed(2) +
          ' / ' +
          artifactResult.baselineMax.toFixed(2) +
          ' a.u.',
      );
    }
    chart('artifactProfile', {
      xmin: -128,
      xmax: 128,
      ymax,
      xlabel: 'physical R coordinate (mm)',
      ylabel: 'activity (a.u.)',
      curves,
    });
  }
  function runArtifact() {
    clearTimeout(artifactTimer);
    artifactStarted = true;
    artifactResult = null;
    put('artifactDifference', '—');
    put('artifactPeak', '—');
    blank('artifactReference');
    blank('artifactChanged');
    artifactFigure();
    put('artifactStatus', 'Computing reference and changed-model reconstructions…');
    request('artifact', { activity: activity64, mu: mu64, kind: S.kind, severity: S.severity });
  }
  function stopMIP() {
    mipPlaying = false;
    clearTimeout(mipTimer);
    put('playMIP', 'Rotate MIP');
    q('playMIP').setAttribute('aria-pressed', 'false');
  }
  function requestMIP(initial = false) {
    put('mipAngleValue', S.angle + '°');
    q('mipAngle').value = String(S.angle);
    request('mip', { angle: S.angle, ...(initial ? { volume: mipVolume } : {}) });
  }
  function mipFigure() {
    if (mipResult) paint(q('mipCanvas'), mipResult.image, 96, 48, state.palette, null, ['S', 'I', '', '']);
    put('mipAngleValue', S.angle + '°');
    q('mipRamp').style.background = state.palette === 'gray' ? 'linear-gradient(90deg,#000,#fff)' : '';
  }
  function handleMessage({ data: d }) {
    if (d.id !== ids[d.channel]) return;
    if (d.type === 'error') {
      put(statuses[d.channel], 'Computation unavailable: ' + d.message);
      if (d.channel === 'mip') stopMIP();
      return;
    }
    if (d.type === 'progress') {
      put(statuses[d.channel], d.message);
      return;
    }
    if (d.type !== 'result') return;
    if (d.channel === 'ensemble') {
      biasResult = d;
      q('biasIteration').disabled = false;
      biasFigure();
    } else if (d.channel === 'counts') {
      countResult = d;
      d.images.forEach((x) => image('count' + Math.round(x.fraction * 100), x.image));
      put(
        'fractionStatus',
        'Computed · R left, A top · realised prompts: ' +
          d.images.map((x) => Math.round(x.fraction * 100) + '% = ' + x.prompts.toLocaleString()).join(' · ') +
          '.',
      );
    } else if (d.channel === 'artifact') {
      artifactResult = d;
      if (d.kind === 'psf' && d.edge) {
        S.row = d.edge.row;
        q('artifactRow').value = String(S.row);
      }
      artifactFigure();
      put(
        'artifactStatus',
        'Computed from expected projections. Toggle Effect on to compare instantly; choose a new effect or strength to recompute.' +
          (d.kind === 'psf' && d.edge
            ? ' PSF example: in tissue assigned 4 a.u., the changed-model edge reaches ' +
              d.edge.value.toFixed(2) +
              ' a.u. (reference at that voxel: ' +
              d.edge.reference.toFixed(2) +
              ' a.u.). Profile row selected through this location.'
            : ''),
      );
    } else if (d.channel === 'mip') {
      mipResult = d;
      mipFigure();
      put(
        'mipStatus',
        'Projection at ' + d.angle + '° around the superior–inferior axis · maximum sampled activity (a.u.).',
      );
      if (mipPlaying)
        mipTimer = setTimeout(() => {
          S.angle = (S.angle + 10) % 360;
          requestMIP();
        }, 180);
    }
  }
  for (const [id, key, numeric] of [
    ['crystalSize', 'crystal', true],
    ['resolutionRing', 'ring', true],
    ['radialOffset', 'radial', true],
    ['resolutionIsotope', 'isotope', false],
    ['sphereDiameter', 'diameter', true],
  ])
    q(id).addEventListener('input', (e) => {
      S[key] = numeric ? +e.target.value : e.target.value;
      resolution();
    });
  q('resolutionDOI').addEventListener('change', (e) => {
    S.doi = e.target.checked;
    resolution();
  });
  for (const id of ['suvMean', 'suvMax', 'suvReference', 'suvDose', 'suvWeight'])
    q(id).addEventListener('input', quantification);
  q('runBias').onclick = runBias;
  q('runFractions').onclick = runCounts;
  q('runArtifact').onclick = runArtifact;
  for (const id of ['biasCounts', 'biasFilter'])
    q(id).addEventListener('change', () => {
      if (biasStarted) {
        invalidate('ensemble');
        clearTimeout(biasTimer);
        biasResult = null;
        put('biasStatus', 'Settings changed; recomputing…');
        biasTimer = setTimeout(runBias, 180);
      }
    });
  q('biasIteration').addEventListener('input', (e) => {
    S.iteration = +e.target.value;
    biasFigure();
  });
  q('fractionCounts').addEventListener('change', () => {
    if (countsStarted) {
      invalidate('counts');
      clearTimeout(countTimer);
      put('fractionStatus', 'Count setting changed; recomputing…');
      countTimer = setTimeout(runCounts, 180);
    }
  });
  function artifactChange() {
    invalidate('artifact');
    clearTimeout(artifactTimer);
    artifactResult = null;
    put('artifactDifference', '—');
    put('artifactPeak', '—');
    blank('artifactReference');
    blank('artifactChanged');
    artifactFigure();
    put('artifactStatus', artifactStarted ? 'Effect changed; recomputing…' : 'Choose Run to compute this effect.');
    if (artifactStarted) artifactTimer = setTimeout(runArtifact, 200);
  }
  q('artifactKind').addEventListener('change', (e) => {
    S.kind = e.target.value;
    artifactChange();
  });
  q('artifactSeverity').addEventListener('input', (e) => {
    S.severity = +e.target.value;
    artifactChange();
  });
  q('artifactEnabled').addEventListener('change', (e) => {
    S.enabled = e.target.checked;
    artifactFigure();
  });
  q('artifactRow').addEventListener('input', (e) => {
    S.row = +e.target.value;
    artifactFigure();
  });
  q('mipAngle').addEventListener('input', (e) => {
    stopMIP();
    S.angle = +e.target.value;
    requestMIP();
  });
  q('playMIP').onclick = () => {
    if (mipPlaying) {
      stopMIP();
      return;
    }
    mipPlaying = true;
    put('playMIP', 'Pause rotation');
    q('playMIP').setAttribute('aria-pressed', 'true');
    requestMIP();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopMIP();
  });
  q('palette').addEventListener('change', mipFigure);
  matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change', (e) => {
    if (e.matches) stopMIP();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') stopMIP();
  });
  function repaint() {
    resolution();
    biasFigure();
    artifactFigure();
    mipFigure();
  }
  q('theme').addEventListener('change', repaint);
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change', repaint);
  let resizeTimer;
  window.addEventListener?.('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(repaint, 120);
  });
  try {
    // The worker is only needed on pages that show the ensemble, count, artifact or MIP experiments.
    if (!['biasPlot', 'count10', 'artifactChanged', 'mipCanvas'].some(onPage)) throw Error('not needed');
    worker = new Worker(new URL('../workers/advanced.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = handleMessage;
    worker.onerror = () => {
      worker = null;
      for (const id of Object.values(statuses)) put(id, 'Interactive worker unavailable. Reload to retry.');
      stopMIP();
    };
    if (onPage('mipCanvas')) requestMIP(true);
  } catch (e) {
    for (const id of Object.values(statuses)) put(id, 'Interactive worker unavailable in this browser.');
  }
  for (const id of [
    'biasSingle',
    'biasMean',
    'count10',
    'count25',
    'count50',
    'count100',
    'artifactReference',
    'artifactChanged',
  ])
    blank(id);
  quantification();
  repaint();
  window.petAdvanced = {
    state: S,
    model: Advanced,
    repaint,
    handleMessage,
    runBias,
    runCounts,
    runArtifact,
    stopMIP,
    ids,
  };
}
