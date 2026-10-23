import { $, state, idx, paint, stop } from '../core/common.js';
import { chart } from '../core/chart.js';

/* Reconstruction lab and the count-sweep hero share one worker and one state. */
export function init({ volume, tissue }) {
  let worker = null,
    jobId = 0,
    seed = 17,
    debounce = null,
    sweepTimer = null,
    busy = false,
    current = null,
    lastImage = null,
    lastTruth = null,
    lastData = null,
    lastFrameData = null;
  const settings = () => ({
    kind: $('caseSelect').value,
    algorithm: $('algorithm').value,
    iterations: +$('iterations').value,
    subsets: +$('subsets').value,
    filter: +$('filter').value,
    noise: $('measurementNoise').checked,
    counts: 10 ** state.logN,
    seed,
    corrections: {
      normalisation: $('corrNorm').checked,
      attenuation: $('corrAtten').checked,
      scatter: $('corrScatter').checked,
      randoms: $('corrRandom').checked,
    },
  });
  const activity = new Float64Array(4096),
    mu = new Float64Array(4096);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      let a = 0,
        m = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const i = idx(2 * x + dx, 2 * y + dy, 51);
          a += volume[i] / 32;
          m += tissue[i] > 0 ? 0.096 : 0;
        }
      activity[y * 64 + x] = a / 4;
      mu[y * 64 + x] = m / 4;
    }
  const displayImage = (x) => Float32Array.from({ length: 4096 }, (_, i) => x[4095 - i]);
  function status(text) {
    $('engineStatus').textContent = text;
    $('heroStatus').textContent = text;
  }
  function heroHeader() {
    const N = 10 ** state.logN;
    $('countReadout').textContent = Math.round(N).toLocaleString('en-GB');
    $('powerReadout').textContent = '10^' + state.logN.toFixed(2);
    $('noiseReadout').textContent = Math.sqrt(1e6 / N).toFixed(2) + '×';
    $('reference').setAttribute('aria-pressed', String(state.reference));
    $('reference').textContent = state.reference ? 'Show reconstruction' : 'Show assigned activity';
    $('countSlider').value = state.logN;
  }
  function paintHero() {
    if (state.reference && lastTruth) paint($('heroCanvas'), displayImage(lastTruth), 64, 64, 'inferno');
    else if (lastImage) paint($('heroCanvas'), displayImage(lastImage), 64, 64, 'inferno');
    $('reference').setAttribute('aria-pressed', String(state.reference));
    $('reference').textContent = state.reference ? 'Show reconstruction' : 'Show assigned activity';
    $('heroFigureCaption').textContent = state.reference
      ? 'Assigned activity of the synthetic input.'
      : 'Reconstruction of this simulated acquisition. Counts are sampled in projection space.';
  }
  function sino() {
    if (!lastData) return;
    const mode = $('sinoMode').value,
      values = mode === 'ratio' ? lastFrameData?.ratio : mode === 'expected' ? lastData.expected : lastData.sino;
    if (!values) return;
    const max = mode === 'ratio' ? 2 : Math.max(...lastData.sino, ...lastData.expected),
      scaled = Float32Array.from(values, (v) => (v / Math.max(max, 1e-9)) * 7);
    paint($('sinoCanvas'), scaled, 129, 120, 'inferno');
    $('sinoMid').textContent = (max / 2).toFixed(mode === 'ratio' ? 1 : 0);
    $('sinoMax').textContent = mode === 'ratio' ? '≥ 2 (unitless)' : max.toFixed(0) + ' counts/bin';
    $('sinoCaption').textContent =
      's: −128 to +128 mm, left to right. φ: 0 to 178.5°, top to bottom. ' +
      (mode === 'ratio'
        ? 'Ratio uses the current unfiltered image; values above 2 clip.'
        : '120 angles × 129 bins · common measured/expected linear scale.');
  }
  function plot() {
    const history = lastFrameData?.history || [],
      base = history[0]?.ll || 0,
      points = history.map((v) => [v.update, (v.ll - base) / Math.max(1, lastData.promptSum)]),
      lo = Math.min(0, ...points.map((p) => p[1])),
      hi = Math.max(0.01, ...points.map((p) => p[1]));
    chart('likelihoodPlot', {
      xmin: 0,
      xmax: Math.max(1, history.at(-1)?.update || 1),
      ymin: lo,
      ymax: hi,
      xlabel: 'subset updates (MLEM: full-data updates)',
      ylabel: current?.algorithm === 'FBP' ? 'FBP: direct reconstruction' : 'Δ log-likelihood / prompt',
      curves: [{ data: points }],
    });
  }
  function inputState() {
    const alg = $('algorithm').value;
    $('subsets').disabled = alg !== 'OSEM';
    $('iterations').disabled = alg === 'FBP';
    $('iterValue').textContent = $('iterations').value;
    $('filterValue').textContent = $('filter').value + ' mm';
    $('newSample').disabled = !$('measurementNoise').checked;
    $('seedLabel').textContent = seed;
  }
  function cancel() {
    clearTimeout(debounce);
    clearTimeout(sweepTimer);
    stop();
    jobId++;
    worker?.postMessage({ type: 'cancel' });
    busy = false;
    $('cancelRecon').disabled = true;
    status('Stopped. The last completed update remains visible.');
  }
  function run() {
    clearTimeout(debounce);
    if (!worker) return;
    current = settings();
    inputState();
    heroHeader();
    busy = true;
    const id = ++jobId;
    lastFrameData = null;
    lastImage = null;
    $('engineProgress').style.width = '0%';
    $('cancelRecon').disabled = false;
    status('Projecting activity and sampling the sinogram…');
    $('reconTitle').textContent = current.algorithm + ' reconstruction';
    $('updateBadge').textContent = 'initialising';
    $('metricError').textContent = '—';
    $('metricDeviance').textContent = '—';
    $('metricTime').textContent = '—';
    worker.postMessage({ id, type: 'run', ...current, activity, mu });
  }
  function schedule() {
    clearTimeout(debounce);
    clearTimeout(sweepTimer);
    heroHeader();
    inputState();
    jobId++;
    worker?.postMessage({ type: 'cancel' });
    status('Settings changed. Preparing reconstruction…');
    debounce = setTimeout(run, 180);
  }
  function onMessage(event) {
    const d = event.data;
    if (d.id !== jobId) return;
    if (d.type === 'status') {
      status(d.text);
      return;
    }
    if (d.type === 'error') {
      busy = false;
      stop();
      $('cancelRecon').disabled = true;
      status('Reconstruction could not finish: ' + d.message);
      return;
    }
    if (d.type === 'data') {
      lastData = d;
      lastTruth = d.truth;
      paint($('truthCanvas'), displayImage(d.truth), 64, 64, 'inferno');
      const desc =
        current.kind === 'brain'
          ? 'AXIAL / z = +7 mm'
          : current.kind === 'cylinder'
            ? 'WATER CYLINDER / R = 80 mm'
            : 'POINT VOXEL / R +34, A +22 mm';
      $('heroInputLabel').textContent = desc;
      $('truthCaption').textContent =
        current.kind === 'brain'
          ? 'Assigned activity · 2 × 2 block average · 4 mm pixels.'
          : current.kind === 'cylinder'
            ? 'Assigned activity · radius 80 mm · 1 a.u. inside.'
            : 'Assigned activity · one 4 × 4 mm voxel · 7 a.u.';
      const counts = current.noise
        ? Math.round(d.promptSum).toLocaleString('en-GB')
        : d.promptSum.toLocaleString('en-GB', { maximumFractionDigits: 1 });
      $('realised').textContent = counts;
      $('metricSample').textContent = counts;
      sino();
      paintHero();
      return;
    }
    if (d.type === 'frame') {
      lastImage = d.image;
      lastFrameData = d;
      paint($('reconCanvas'), displayImage(d.image), 64, 64, 'inferno');
      paintHero();
      sino();
      plot();
      $('updateBadge').textContent = d.update + ' update' + (d.update === 1 ? '' : 's');
      $('metricError').textContent = (d.metrics.nrmse * 100).toFixed(1) + '%';
      $('metricDeviance').textContent = d.rawDeviance.toFixed(3);
      $('metricTime').textContent = d.elapsedMs.toFixed(0) + ' ms';
      $('reconCaption').textContent =
        (current.algorithm === 'FBP'
          ? 'FBP · ' + d.metrics.negative + ' negative pixels clip in display.'
          : current.algorithm +
            ' · iteration ' +
            d.iteration +
            '/' +
            current.iterations +
            ' · ' +
            d.update +
            ' updates.') +
        ' Post-filter ' +
        current.filter +
        ' mm.';
      $('engineProgress').style.width = (d.done ? 100 : (100 * d.iteration) / current.iterations) + '%';
      status(
        d.done
          ? 'Complete · ' +
              current.algorithm +
              ' · ' +
              d.elapsedMs.toFixed(0) +
              ' ms · max update ' +
              d.maxStepMs.toFixed(1) +
              ' ms.'
          : 'Reconstructing · iteration ' + d.iteration + ' of ' + current.iterations + '…',
      );
      if (d.done) {
        busy = false;
        $('cancelRecon').disabled = true;
        if (state.playing) {
          if (state.logN >= 8) {
            stop();
          } else
            sweepTimer = setTimeout(() => {
              if (!state.playing) return;
              state.logN = Math.min(8, state.logN + 0.25);
              heroHeader();
              run();
            }, 350);
        }
      }
    }
  }
  $('play').onclick = () => {
    if (state.playing) {
      stop();
      clearTimeout(sweepTimer);
      return;
    }
    state.reference = false;
    if (state.logN >= 8) state.logN = 3;
    state.playing = true;
    $('play').textContent = 'Pause sweep';
    run();
  };
  $('reference').onclick = () => {
    state.reference = !state.reference;
    paintHero();
  };
  $('runRecon').onclick = () => {
    stop();
    run();
  };
  $('cancelRecon').onclick = cancel;
  $('newSample').onclick = () => {
    stop();
    seed++;
    run();
  };
  $('sinoMode').onchange = sino;
  for (const id of [
    'caseSelect',
    'algorithm',
    'subsets',
    'measurementNoise',
    'corrNorm',
    'corrAtten',
    'corrScatter',
    'corrRandom',
  ])
    $(id).onchange = () => {
      stop();
      schedule();
    };
  for (const id of ['iterations', 'filter'])
    $(id).oninput = () => {
      stop();
      schedule();
    };
  $('allCorrections').onclick = () => {
    for (const id of ['corrNorm', 'corrAtten', 'corrScatter', 'corrRandom']) $(id).checked = true;
    stop();
    schedule();
  };
  $('noCorrections').onclick = () => {
    for (const id of ['corrNorm', 'corrAtten', 'corrScatter', 'corrRandom']) $(id).checked = false;
    stop();
    schedule();
  };
  $('theme').addEventListener('change', plot);
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change', plot);
  let plotResize;
  window.addEventListener?.('resize', () => {
    clearTimeout(plotResize);
    plotResize = setTimeout(plot, 120);
  });
  // Count-sweep hero controls (formerly in the page's main script).
  $('countSlider').addEventListener('input', (e) => {
    stop();
    state.logN = +e.target.value;
    schedule();
  });
  $('reset').onclick = () => {
    stop();
    state.logN = 5;
    state.reference = false;
    $('countSlider').value = 5;
    schedule();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
  });
  matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change', (e) => {
    if (e.matches) stop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') stop();
  });
  // Links such as ../labs/reconstruction/?preset=attenuation open the lab in a prepared state.
  const preset = new URLSearchParams(location.search).get('preset');
  if (preset === 'attenuation') {
    $('caseSelect').value = 'brain';
    $('algorithm').value = 'MLEM';
    $('iterations').value = '30';
    $('filter').value = '0';
    $('measurementNoise').checked = false;
    for (const id of ['corrNorm', 'corrAtten', 'corrScatter', 'corrRandom']) $(id).checked = true;
    state.logN = 6;
    state.reference = false;
    const note = document.getElementById('presetNote');
    if (note) {
      note.hidden = false;
      note.textContent =
        'Preset loaded: corrected, noiseless MLEM with 30 iterations. Untick Attenuation under Corrections to compare.';
    }
  }
  window.reconstructionLab = {
    schedule,
    run,
    cancel,
    state: () => ({ settings: settings(), busy, jobId, seed }),
    handleMessage: onMessage,
  };
  inputState();
  heroHeader();
  try {
    if (typeof Worker === 'undefined') throw Error('This browser has no Web Worker support.');
    worker = new Worker(new URL('../workers/pet.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onMessage;
    worker.onerror = (e) => {
      stop();
      busy = false;
      status(
        'The reconstruction worker could not start. ' +
          (e.message || 'Try a current version of Chrome, Edge, Firefox or Safari.'),
      );
      $('cancelRecon').disabled = true;
    };
    run();
  } catch (e) {
    status(e.message + ' The tri-planar phantom viewer remains available.');
    for (const id of ['play', 'runRecon', 'newSample', 'cancelRecon']) $(id).disabled = true;
    paint($('heroCanvas'), displayImage(activity), 64, 64, 'inferno');
    $('heroFigureCaption').textContent = 'Assigned synthetic activity · worker unavailable, no reconstruction shown.';
  }
}
