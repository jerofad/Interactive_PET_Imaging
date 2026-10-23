import { $, onPage, idx, paint, imageCanvas, colours } from '../core/common.js';
import { chart } from '../core/chart.js';
import { ScenePhysics } from '../models/scene.js';

/* Controller for the scanner, sinogram bench, reconstruction film and coincidence timeline. */
// Presentation time for one illustrated coincidence, long enough to read each of its beats.
const EVENT_SECONDS = 3.4;
export function init({ volume, tissue }) {
  const q = $,
    put = (id, text) => (q(id).textContent = text),
    S = { ...ScenePhysics.defaults };
  const views = {},
    keys = ['scanner', 'bench', 'film', 'timeline'],
    sections = {
      scanner: 'scanner',
      bench: 'sinogram-bench',
      film: 'reconstruction-film',
      timeline: 'coincidence-timeline',
    },
    playing = { scanner: false, bench: false, film: false, timeline: false },
    jobs = { bench: 0, film: 0, acquisition: 0 };
  let worker,
    source,
    cloud = [],
    lastDiagnostic = null,
    event = null,
    eventClock = 0,
    shown = { true: 0, scatter: 0, random: 0 },
    eventRecords = [],
    random = ScenePhysics.rng(1983),
    diagnostics = [],
    acqRunning = false,
    progress = 0,
    benchData = null,
    benchAngle = 35,
    benchOffset = 24,
    benchAct = 0,
    benchTime = 0,
    filmData = null,
    filmIndex = 0,
    filmClock = 0,
    timelineAct = 0,
    timelineTime = 0,
    timelineClock = 0,
    lastTick = 0,
    raf = 0,
    changeTimer;
  const listCanvas = document.createElement('canvas');
  listCanvas.width = 760;
  listCanvas.height = 620;
  function drawEventList() {
    const ctx = listCanvas.getContext('2d');
    ctx.fillStyle = '#060c16';
    ctx.fillRect(0, 0, 760, 620);
    ctx.font = '22px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8eef5';
    ctx.fillText('ILLUSTRATED LIST MODE', 28, 48);
    ctx.font = '18px monospace';
    ctx.fillStyle = '#9dafc5';
    ctx.fillText('Crystal i / j   t(s)  Δt(ns)  E₁/E₂(keV)', 28, 88);
    ctx.fillText('Presentation time; separate from 2D counts', 28, 588);
    if (!eventRecords.length) ctx.fillText('Play scanner to add accepted pairs.', 28, 152);
    eventRecords.slice(-7).forEach((e, i) => {
      ctx.fillStyle = e.kind === 'true' ? '#ef8ec9' : e.kind === 'scatter' ? '#d28d5d' : '#9da6b4';
      const ids = e.arms.map((a) => String(a.id).padStart(5)).join('/'),
        row =
          ids +
          '  ' +
          e.presentation.toFixed(2).padStart(5) +
          '  ' +
          e.dt.toFixed(2).padStart(6) +
          '  ' +
          e.arms.map((a) => a.energy.toFixed(0)).join('/');
      ctx.fillText(row, 28, 144 + i * 57);
    });
    views.bench?.refreshTextures();
  }
  const a64 = new Float64Array(4096),
    m64 = new Float64Array(4096),
    point = new Float64Array(4096);
  point[37 * 64 + 40] = 7;
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const i = idx(2 * x + dx, 2 * y + dy, 51);
          a64[y * 64 + x] += volume[i] / 128;
          m64[y * 64 + x] += (tissue[i] > 0 ? 0.096 : 0) / 4;
        }
  const binding = {
    sceneIsotope: ['isotope', 'string'],
    sceneActivity: ['activity', 'number', ' MBq'],
    sceneUptake: ['uptake', 'number', ' min'],
    sceneDuration: ['duration', 'number', ' s'],
    sceneRing: ['ring', 'number', ' mm'],
    sceneFOV: ['fov', 'number', ' mm'],
    sceneCrystal: ['crystal', 'number', ' mm'],
    sceneDepth: ['depth', 'number', ' mm'],
    sceneMaterial: ['material', 'string'],
    sceneEnergy: ['lower', 'number', ' keV'],
    sceneWindow: ['window', 'number', ' ns'],
    sceneTOF: ['tof', 'number'],
    sceneMode: ['mode', 'string'],
    sceneDOI: ['doi', 'check'],
    sceneAlgorithm: ['algorithm', 'string'],
    sceneIterations: ['iterations', 'number', ''],
    sceneSubsets: ['subsets', 'number'],
    sceneFilter: ['filter', 'number', ' mm'],
    scenePSF: ['psf', 'check'],
    sceneCorrNorm: ['normalisation', 'check'],
    sceneCorrAtten: ['attenuation', 'check'],
    sceneCorrScatter: ['scatter', 'check'],
    sceneCorrRandoms: ['randoms', 'check'],
    sceneCorrDecay: ['decay', 'check'],
  };
  for (const [id, [key, type, unit]] of Object.entries(binding)) {
    if (type === 'check') q(id).checked = S[key];
    else q(id).value = String(S[key]);
    if (unit !== undefined) put(id + 'Value', S[key] + unit);
  }
  for (const [id, value] of Object.entries({
    benchAct: '0',
    benchSource: 'phantom',
    benchSpan: '3',
    benchRingDifference: '4',
    scannerCamera: 'overview',
    filmAct: '1',
    timelineAct: '0',
    timelinePosition: '60',
  }))
    q(id).value = value;
  for (const id of [
    'scannerHousing',
    'showTrues',
    'showScatter',
    'showRandoms',
    'benchLoop',
    'filmLoop',
    'timelineLoop',
    'timelineZoom',
  ])
    q(id).checked = true;
  function paintScan(id, values, w = 64, h = 64, max = 7, reverse = true) {
    const out = Float32Array.from(values, (v) => (v / Math.max(max, 1e-12)) * 7);
    if (reverse) out.reverse();
    paint(q(id), out, w, h, 'inferno', null, w === 64 ? ['A', 'P', 'R', 'L'] : null);
  }
  function blank(id, w = 64, h = 64) {
    paintScan(id, new Float32Array(w * h), w, h, 7, false);
  }
  function run(channel, extra = {}) {
    if (!worker) {
      put(
        channel === 'acquisition' ? 'scannerStatus' : channel === 'film' ? 'filmStatus' : 'scannerStatus',
        'The computation worker is unavailable; analytic controls still work.',
      );
      return;
    }
    const id = ++jobs[channel];
    worker.postMessage({
      channel,
      id,
      type: 'run',
      activity: a64,
      mu: m64,
      settings: { ...S },
      ...extra,
    });
  }
  function cancel(channel) {
    jobs[channel]++;
    worker?.postMessage({ channel, id: jobs[channel], type: 'cancel' });
  }
  function short(v) {
    return v >= 1e6
      ? (v / 1e6).toFixed(2) + ' M'
      : v >= 1000
        ? (v / 1000).toFixed(1) + ' k'
        : v < 0.01 && v > 0
          ? v.toExponential(2)
          : v.toFixed(1);
  }
  function readouts() {
    const r = ScenePhysics.rates(S, progress * S.duration),
      centre = ScenePhysics.blur(S),
      edge = ScenePhysics.blur(S, 150);
    put('sceneRandomRate', (r.R / 1000).toFixed(1) + ' kcps');
    put('sceneNECR', (r.necr / 1000).toFixed(1) + ' kcps');
    put('sceneSF', (r.sf * 100).toFixed(1) + '% / ' + (r.rf * 100).toFixed(1) + '%');
    put('sceneDead', (r.dead * 100).toFixed(1) + '%');
    put('sceneDecay', short(r.activity) + ' / ' + S.activity + ' MBq');
    put('sceneResolution', centre.toFixed(2) + ' / ' + edge.toFixed(2) + ' mm');
    q('sceneSubsets').disabled = S.algorithm !== 'OSEM';
    q('sceneIterations').disabled = S.algorithm === 'FBP';
    q('scenePSF').disabled = S.algorithm === 'FBP';
    const g = ScenePhysics.geometry(S),
      m = ScenePhysics.michelogram(9, +q('benchRingDifference').value, +q('benchSpan').value);
    put('benchLORs', '15,480 / 120');
    put('benchSampling', '2 mm / 1.5°');
    put('benchHardware', g.detectors.toLocaleString() + ' / ' + g.radial + ' mm');
    put('benchSizes', '60.5 KiB / ' + Math.round(((1e5 * 24) / 1024 / 1024) * 100) / 100 + ' MiB at 10⁵ events');
    put('benchAxial', m.pairs + ' / ' + m.planes);
    put('benchRingDifferenceValue', q('benchRingDifference').value);
    put('timelinePositionValue', q('timelinePosition').value + ' mm');
  }
  function drawDiagnostic() {
    const d = diagnostics.filter((x) => x.fraction <= progress + 0.00001).at(-1);
    if (!d) {
      lastDiagnostic = null;
      blank('sceneRecon');
      blank('sceneSino', 129, 120);
      put('sceneCounts', '0');
      put('sceneTSR', '0 / 0 / 0');
      put('sceneTime', '0 / ' + S.duration + ' s');
      return;
    }
    if (d === lastDiagnostic) return;
    lastDiagnostic = d;
    paintScan('sceneRecon', d.image);
    const max = Math.max(1, ...d.sino);
    paintScan('sceneSino', d.sino, 129, 120, max, false);
    put('sceneSinoMax', max.toFixed(0) + ' counts/bin');
    put('sceneCounts', (d.totals.T + d.totals.S + d.totals.R).toLocaleString());
    put('sceneTSR', [d.totals.T, d.totals.S, d.totals.R].map((x) => short(x)).join(' / '));
    put('sceneTime', d.elapsed.toFixed(1) + ' / ' + S.duration + ' s');
    if (d.done && progress >= 1)
      put(
        'scannerStatus',
        'Acquisition complete. These are cumulative sampled projection counts; the image is ' +
          S.algorithm +
          ' with ' +
          (S.psf && S.algorithm !== 'FBP' ? 'matched PSF' : 'no PSF model') +
          '.' +
          (d.capped ? ' Teaching count budget capped at 10⁹.' : ''),
      );
    views.scanner?.refreshTextures();
  }
  function newEvent() {
    if (!source) return;
    let next = ScenePhysics.event(S, source, tissue, random);
    // The first illustrated pair is a true coincidence so the story starts with the simple case.
    for (let i = 0; i < 40 && !eventRecords.length && next && next.kind !== 'true'; i++)
      next = ScenePhysics.event(S, source, tissue, random);
    if (!next) {
      put('eventClass', 'No accepted illustrative pair in this batch');
      return;
    }
    event = next;
    shown[event.kind]++;
    eventRecords.push({ ...event, presentation: progress * 24 });
    if (eventRecords.length > 8) eventRecords.shift();
    put(
      'eventClass',
      event.kind === 'true'
        ? 'True coincidence'
        : event.kind === 'scatter'
          ? 'Scattered coincidence'
          : 'Random coincidence',
    );
    put('eventDetectors', event.arms.map((a) => a.id).join(' / '));
    put('eventEnergy', event.arms.map((a) => a.energy.toFixed(1)).join(' / ') + ' keV');
    put('eventDelta', event.dt.toFixed(3) + ' ns');
    put('eventCounts', [shown.true, shown.scatter, shown.random].join(' / '));
    q('eventTable').innerHTML = eventRecords
      .map(
        (e) =>
          '<tr><td data-label="Class">' +
          e.kind +
          '</td><td data-label="Crystal i">' +
          e.arms[0].id +
          '</td><td data-label="Crystal j">' +
          e.arms[1].id +
          '</td><td data-label="Illustration time (s)">' +
          e.presentation.toFixed(2) +
          '</td><td data-label="Δt (ns)">' +
          e.dt.toFixed(3) +
          '</td><td data-label="E₁ / E₂ (keV)">' +
          e.arms.map((a) => a.energy.toFixed(1)).join(' / ') +
          '</td></tr>',
      )
      .join('');
    drawEventList();
  }
  function resetAcquisition() {
    playing.scanner = false;
    q('scannerPlay').textContent = 'Play acquisition';
    q('scannerPlay').setAttribute('aria-pressed', 'false');
    cancel('acquisition');
    diagnostics = [];
    acqRunning = false;
    progress = 0;
    lastDiagnostic = null;
    event = null;
    eventClock = 0;
    shown = { true: 0, scatter: 0, random: 0 };
    eventRecords = [];
    drawEventList();
    random = ScenePhysics.rng(1983);
    q('scannerProgress').value = '0';
    put('scannerProgressValue', '0%');
    put('eventCounts', '0 / 0 / 0');
    for (const id of ['eventClass', 'eventDetectors', 'eventEnergy', 'eventDelta']) put(id, '—');
    q('eventTable').innerHTML = '<tr><td colspan="6">Play the scanner scene to generate records.</td></tr>';
    blank('sceneRecon');
    blank('sceneSino', 129, 120);
    put('sceneSinoMax', '— counts/bin');
    drawDiagnostic();
    readouts();
    views.scanner?.updateEvent(null, 0);
    render('scanner');
  }
  function invalidateFilm() {
    playing.film = false;
    filmData = null;
    filmIndex = 0;
    cancel('film');
    q('filmPlay').disabled = true;
    q('filmFrame').disabled = true;
    put('filmFrameValue', '—');
    q('filmPlay').textContent = 'Play film';
    q('filmPlay').setAttribute('aria-pressed', 'false');
    for (const id of ['filmImage', 'filmRatio', 'filmBack'])
      blank(id, id === 'filmRatio' ? 129 : 64, id === 'filmRatio' ? 120 : 64);
    put('filmStatus', 'Scanner settings changed. Compute the film to use them.');
    filmCharts();
    views.film?.refreshTextures();
    render('film');
  }
  function updateSetting(id, value) {
    const [key, type, unit] = binding[id];
    S[key] = value;
    if (unit !== undefined) put(id + 'Value', value + unit);
    resetAcquisition();
    invalidateFilm();
    put('scannerStatus', 'Settings changed. Play to acquire a new cumulative dataset.');
    readouts();
    drawTimeline();
    drawBench();
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      views.scanner?.configure(S);
      render('scanner');
    }, 100);
  }
  for (const [id, [key, type]] of Object.entries(binding))
    q(id).addEventListener(type === 'check' ? 'change' : 'input', (e) =>
      updateSetting(id, type === 'check' ? e.target.checked : type === 'number' ? +e.target.value : e.target.value),
    );
  function drawMichelogram() {
    const c = q('benchMichelogram'),
      ctx = c.getContext('2d'),
      map = ScenePhysics.michelogram(9, +q('benchRingDifference').value, +q('benchSpan').value),
      left = 45,
      size = 32;
    ctx.fillStyle = '#060c16';
    ctx.fillRect(0, 0, c.width, c.height);
    for (const cell of map.cells) {
      ctx.fillStyle = !cell.valid
        ? '#182637'
        : cell.segment === 0
          ? '#70c7c0'
          : cell.segment > 0
            ? '#efbd6d'
            : '#ef8ec9';
      ctx.fillRect(left + cell.a * size, 28 + (8 - cell.b) * size, size - 2, size - 2);
    }
    ctx.fillStyle = '#b6c7dc';
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i < 9; i++) {
      ctx.fillText(String(i), left + (i + 0.5) * size, 339);
      ctx.fillText(String(i), 26, 28 + (8 - i + 0.6) * size);
    }
    ctx.fillText('detector ring i', 188, 365);
    ctx.textAlign = 'left';
    ctx.fillText('ring j', 12, 17);
  }
  function drawBench() {
    const pointMode = q('benchSource').value === 'point' || benchAct === 1,
      phi = (benchAngle * Math.PI) / 180,
      s = pointMode ? ScenePhysics.lor([34, 22], phi) : benchOffset;
    q('benchOffset').disabled = pointMode;
    put('benchAngleValue', benchAngle.toFixed(0) + '°');
    put('benchOffsetValue', s.toFixed(1) + ' mm');
    paintScan('benchSlice', pointMode ? point : a64);
    let max = 1;
    if (benchData) {
      const values = pointMode ? benchData.point : benchData.phantom;
      max = Math.max(1, ...values);
      paintScan('benchSino', values, 129, 120, max, false);
      put('benchSinoMax', max.toFixed(1) + ' a.u.·cm');
      const aa = Math.max(0, Math.min(119, Math.round(benchAngle / 1.5))),
        bb = Math.max(0, Math.min(128, Math.round(s / 2 + 64)));
      put('benchIntegral', values[aa * 129 + bb].toFixed(2) + ' a.u.·cm');
      const c = q('benchSino'),
        ctx = c.getContext('2d'),
        bounds = c._bounds;
      if (bounds) {
        ctx.strokeStyle = '#ef8ec9';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 120; i++) {
          const ss = ScenePhysics.lor([34, 22], (i * Math.PI) / 120),
            x = bounds.left + (ss / 2 + 64.5) * bounds.scale,
            y = bounds.top + (i + 0.5) * bounds.scale;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = '#efbd6d';
        ctx.beginPath();
        ctx.arc(bounds.left + (s / 2 + 64.5) * bounds.scale, bounds.top + (aa + 0.5) * bounds.scale, 5, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    drawMichelogram();
    readouts();
    views.bench?.updateBench(benchAngle, s, benchAct);
    render('bench');
  }
  function filmCharts() {
    const frame = filmData?.frames[filmIndex],
      history = frame?.history || [],
      base = history.length ? history[0][1] : 0,
      points = history.map(([x, y]) => [x, (y - base) / Math.max(1, filmData.prompts)]),
      low = Math.min(0, ...points.map((x) => x[1])),
      high = Math.max(0.01, ...points.map((x) => x[1]));
    chart('filmLikelihood', {
      xmin: 0,
      xmax: Math.max(1, history.at(-1)?.[0] || 1),
      ymin: low,
      ymax: high * 1.05,
      xlabel: 'subset update (MLEM: full-data update)',
      ylabel: 'Δ log-likelihood / prompt',
      curves: [{ data: points }],
    });
    const rows = filmData?.frames.filter((f) => f.act === (frame?.act || 3) && f.roi) || [],
      ymax = Math.max(7, ...rows.flatMap((x) => [x.roi.peak, x.roi.background])) * 1.1;
    chart('filmROI', {
      xmin: 0,
      xmax: Math.max(1, ...rows.map((x) => x.update)),
      ymax,
      xlabel: frame?.act === 3 ? 'correction stage (0–5)' : 'computed update checkpoint',
      ylabel: 'activity (a.u.)',
      marker: frame?.update,
      curves: [
        { data: rows.map((x) => [x.update, x.roi.peak]) },
        {
          color: 'anatomy',
          data: rows.map((x) => [x.update, x.roi.background]),
        },
      ],
    });
  }
  function drawFilm() {
    const f = filmData?.frames[filmIndex];
    if (!f) {
      filmCharts();
      return;
    }
    q('filmFrame').value = filmIndex;
    q('filmAct').value = String(f.act);
    put('filmFrameValue', filmIndex + 1 + ' / ' + filmData.frames.length + ' · ' + f.title);
    paintScan('filmImage', f.image, 64, 64, f.scale);
    put('filmImageMax', f.scale + ' ' + f.units);
    paintScan('filmRatio', f.ratio, 129, 120, f.ratioScale, false);
    put('filmRatioLabel', f.act === 1 ? 'Measured sinogram' : 'Measured / predicted');
    put('filmBackLabel', f.back ? 'Backprojected ratio' : 'Assigned reference activity');
    put('filmRatioMax', f.ratioScale.toFixed(f.act === 1 ? 0 : 1) + ' ' + f.ratioUnits);
    paintScan('filmBack', f.back || filmData.truth, 64, 64, f.back ? 2 : 7);
    put('filmBackMax', f.back ? '2 unitless' : '7 a.u.');
    put(
      'filmEquation',
      f.act === 1
        ? 'Backprojection: Aᵀp · FBP: backproject the ramp-filtered projections'
        : f.act === 2
          ? 'ȳ = Ax + s + r     x ← x / (Aᵀ1) · Aᵀ(y / ȳ)'
          : 'Same measured y; corrections change A and the additive expectations s + r.',
    );
    put(
      'filmStatus',
      'Computed film · ' +
        filmData.prompts.toLocaleString() +
        ' realised prompts · ' +
        f.title +
        '. ' +
        (f.act === 1 && f.scale === 1
          ? 'Backprojection is peak-normalised.'
          : f.act === 2
            ? 'All updates are computed; selected checkpoints are stored.'
            : 'Reference activity uses decay factor ' + filmData.decay.toFixed(4) + '.'),
    );
    filmCharts();
    views.film?.updateFilm(f.act);
    render('film');
  }
  function buildFilm() {
    invalidateFilm();
    put('filmStatus', 'Computing backprojection, iterative updates and all six correction stages…');
    run('film');
  }
  function timing() {
    return ScenePhysics.timing(S, +q('timelinePosition').value);
  }
  function drawTimeline(rebuild = true) {
    const t = timing(),
      zoom = q('timelineZoom').checked,
      max = zoom ? 6 : t.end;
    timelineTime = Math.min(max, timelineTime);
    q('timelineTime').max = String(max);
    q('timelineTime').step = zoom ? '.01' : '1';
    q('timelineTime').value = String(timelineTime);
    put('timelineTimeValue', timelineTime.toFixed(zoom ? 2 : 1) + ' ns');
    put('timelineFlights', t.near.toFixed(3) + ' / ' + t.far.toFixed(3) + ' ns');
    put('timelineDelta', t.delta.toFixed(3) + ' ns / ' + t.x.toFixed(1) + ' mm');
    put('timelineCFD', t.cfdNear.toFixed(3) + ' / ' + t.cfdFar.toFixed(3) + ' ns');
    put('timelinePulse', t.tau + ' ns / ' + t.gate + ' ns');
    put('timelineEnergy', '511 keV · accepted');
    put('timelineEnergyWindow', S.lower + '–650 keV · ideal full-energy pair');
    put('timelineGate', t.accepted ? 'Inside ' + S.window + ' ns window' : 'Outside timing window');
    put('timelineTOF', t.localisation ? t.localisation.toFixed(1) + ' mm' : 'TOF off');
    put('timelinePositionValue', q('timelinePosition').value + ' mm');
    const curves = [
      {
        color: 'photon',
        data: Array.from({ length: 501 }, (_, i) => {
          const x = (max * i) / 500;
          return [x, ScenePhysics.pulse(x, t.near, t.tau)];
        }),
      },
      {
        color: 'detector',
        data: Array.from({ length: 501 }, (_, i) => {
          const x = (max * i) / 500;
          return [x, ScenePhysics.pulse(x, t.far, t.tau)];
        }),
      },
      {
        color: 'random',
        dash: [2, 4],
        data: Array.from({ length: 501 }, (_, i) => {
          const x = (max * i) / 500;
          return [x, ScenePhysics.pulse(x, t.near + 500, t.tau)];
        }),
      },
    ];
    chart('timelinePlot', {
      xmin: 0,
      xmax: max,
      ymax: 1.1,
      xlabel: 'time after annihilation (ns) · linear scale',
      ylabel: 'normalised light amplitude',
      curves,
      marker: timelineTime,
    });
    const actText = [
      'Before zero: β⁺ emission, slowing and annihilation. After zero: photons travel at c.',
      'A 20% CFD crossing estimates arrival time. The long light-decay constant is not the coincidence timing FWHM.',
      'The energy integral is accumulated over 5τ. Each ideal 511 keV deposit passes the ' +
        S.lower +
        '–650 keV energy window. Prompt pairing uses timestamp difference.',
      'A 500 ns delayed timestamp copy excludes this true pair; coincidences with other unrelated singles estimate randoms.',
    ];
    put(
      'timelineStatus',
      actText[timelineAct] +
        ' ' +
        (zoom ? 'Close-up: 0–6 ns.' : 'Full electronics view: 0–' + max.toFixed(1) + ' ns.') +
        ' No timing noise is drawn in this deterministic pair.',
    );
    if (rebuild) views.timeline?.timeline(t, zoom);
    views.timeline?.updateTimeline(timelineTime);
    render('timeline');
  }
  function hud(key) {
    if (key === 'scanner') {
      // The view owns the beat timing of each event, so it also names the current beat.
      const block = q('scannerCamera').value === 'block',
        story = event && views.scanner?.stage?.();
      return {
        title: block
          ? 'Crystal → light guide → SiPM'
          : story
            ? story.title
            : 'Inside an ' + (S.ring / 10).toFixed(0) + ' cm detector ring',
        kicker: 'SYNTHETIC BRAIN · GEOMETRY IN mm · MARKERS ENLARGED · TIME SLOWED',
        caption: block
          ? S.crystal + ' × ' + S.crystal + ' × ' + S.depth + ' mm crystals; exploded layer gaps are illustrative.'
          : story
            ? story.caption
            : 'Activity-weighted phantom points; the body is schematic. Play to follow accepted pairs.',
        readout: 'Activity 0–7 a.u. · ' + (S.tof ? S.tof + ' ps TOF' : 'TOF off'),
        scales: [{ label: 'Activity', max: '7 a.u.' }],
      };
    }
    if (key === 'bench') {
      const titles = [
        'A line integral through the phantom',
        'A point writes a sine trace',
        'Two ways to store coincidences',
        'Direct and oblique axial sampling',
      ];
      return {
        title: titles[benchAct],
        kicker: 'SYNTHETIC PHANTOM · DIAGRAM SPACING IS SCHEMATIC',
        caption:
          benchAct === 3
            ? 'Ring difference selects obliquity; span groups neighbouring ring differences.'
            : benchAct === 2
              ? 'List mode retains event records; a sinogram bins events by line coordinates.'
              : 's = x cosφ + y sinφ. The highlighted coordinate follows the selected line.',
        readout: 'φ ' + benchAngle.toFixed(0) + '° · activity 0–7 a.u.',
        scales: [
          { label: 'Activity', max: '7 a.u.' },
          { label: 'Projection', max: q('benchSinoMax').textContent },
        ],
      };
    }
    if (key === 'film') {
      const f = filmData?.frames[filmIndex];
      return {
        title: f ? 'Act ' + f.act + ' · ' + f.title : 'Reconstruction, one update at a time',
        kicker: 'SYNTHETIC PHANTOM · COMPUTED PROJECTIONS AND IMAGES',
        caption: !f
          ? 'Compute the film, then play or scrub its reconstruction checkpoints.'
          : f.act === 1
            ? 'The ramp filter restores high frequencies and amplifies noise.'
            : f.act === 2
              ? 'ȳ = Ax + s + r · x ← x/(Aᵀ1) · Aᵀ(y/ȳ).'
              : 'The measurements stay fixed while the correction model changes.',
        readout: f
          ? 'Image 0–' + f.scale + ' ' + f.units + ' · ' + (f.act === 1 ? 'sinogram: counts/bin' : 'ratio: 0–2')
          : '',
        scales: f
          ? [
              {
                label: 'Image',
                max: f.scale + ' ' + (f.units === 'normalised peak' ? 'relative' : f.units),
              },
              {
                label: f.act === 1 ? 'Sinogram' : 'Ratio',
                max: f.ratioScale.toFixed(f.act === 1 ? 0 : 1) + (f.act === 1 ? ' counts' : ''),
              },
              {
                label: f.back ? 'Back factor' : 'Truth',
                max: f.back ? '2' : '7 a.u.',
              },
            ]
          : [],
      };
    }
    const t = timing();
    return {
      title: [
        'From decay to photon flight',
        'Light pulse → SiPM timestamp',
        'Energy integral and prompt pairing',
        'A delayed copy estimates randoms',
      ][timelineAct],
      kicker: 'DETERMINISTIC EXAMPLE · TIME AXES ARE LINEAR',
      caption:
        timelineAct === 0
          ? 't = 0 at annihilation; positron slowing and lifetime occur before this origin.'
          : timelineAct === 1
            ? 'Identical 20% CFD offsets cancel from the arrival-time difference.'
            : timelineAct === 2
              ? 'A ' +
                S.window +
                ' ns full gate tests Δt; 511 keV passes ' +
                S.lower +
                '–650 keV after the ' +
                t.gate +
                ' ns integral.'
              : 'A 500 ns shift breaks the true pair. Other unrelated singles are needed.',
      readout: timelineTime.toFixed(2) + ' ns · Δt ' + t.delta.toFixed(3) + ' ns',
    };
  }
  function render(key) {
    if (views[key])
      try {
        views[key].render(hud(key));
      } catch (e) {
        fallback(key, 'The 3D view stopped. Its numerical panels remain available.');
      }
  }
  function fallback(key, message) {
    put(key + 'Fallback', message);
    q(key + 'Fallback').hidden = false;
    setPlaying(key, false);
  }
  function setPlaying(key, on) {
    playing[key] = on;
    q(key + 'Play').setAttribute('aria-pressed', String(on));
    put(
      key + 'Play',
      on
        ? 'Pause'
        : key === 'scanner'
          ? 'Play acquisition'
          : key === 'bench'
            ? 'Play bench'
            : key === 'film'
              ? 'Play film'
              : 'Play timeline',
    );
    if (on) animate();
  }
  function animate() {
    if (!raf) {
      lastTick = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }
  function tick(now) {
    raf = 0;
    if (now - lastTick < 15) {
      raf = requestAnimationFrame(tick);
      return;
    }
    const dt = Math.min(0.12, (now - lastTick) / 1000);
    lastTick = now;
    if (playing.scanner) {
      progress = Math.min(1, progress + dt / 24);
      eventClock += dt / EVENT_SECONDS;
      if (!event || eventClock >= 1) {
        eventClock = 0;
        newEvent();
      }
      views.scanner?.updateEvent(event, eventClock);
      q('scannerProgress').value = String(progress * 100);
      put('scannerProgressValue', (progress * 100).toFixed(0) + '%');
      drawDiagnostic();
      readouts();
      render('scanner');
      if (progress >= 1) setPlaying('scanner', false);
    }
    if (playing.bench) {
      benchTime += dt;
      benchAngle = (benchAngle + dt * 18) % 180;
      q('benchAngle').value = String(benchAngle);
      if (benchTime >= 10) {
        benchTime = 0;
        if (q('benchLoop').checked) {
          benchAct = (benchAct + 1) % 4;
          q('benchAct').value = String(benchAct);
        } else setPlaying('bench', false);
      }
      drawBench();
    }
    if (playing.film && filmData) {
      filmClock += dt;
      if (filmClock >= 1.3) {
        filmClock = 0;
        const next = filmIndex + 1;
        if (
          next < filmData.frames.length &&
          (q('filmLoop').checked || filmData.frames[next].act === filmData.frames[filmIndex].act)
        )
          filmIndex = next;
        else if (q('filmLoop').checked) filmIndex = 0;
        else setPlaying('film', false);
        drawFilm();
      }
    }
    if (playing.timeline) {
      timelineClock += dt;
      if (timelineClock >= 10) {
        timelineClock = 0;
        if (q('timelineLoop').checked) {
          timelineAct = (timelineAct + 1) % 4;
          q('timelineAct').value = String(timelineAct);
          q('timelineZoom').checked = timelineAct < 2;
          drawTimeline(true);
        } else setPlaying('timeline', false);
      }
      const t = timing(),
        lo = timelineAct === 3 ? 500 : 0,
        hi = timelineAct < 2 ? 6 : timelineAct === 2 ? t.decision : t.end;
      timelineTime = lo + ((hi - lo) * timelineClock) / 10;
      drawTimeline(false);
    }
    if (Object.values(playing).some(Boolean)) raf = requestAnimationFrame(tick);
  }
  q('scannerPlay').onclick = () => {
    if (playing.scanner) {
      setPlaying('scanner', false);
      return;
    }
    if (progress >= 1) resetAcquisition();
    if (!acqRunning) {
      acqRunning = true;
      put('scannerStatus', 'Computing cumulative projections and reconstruction checkpoints…');
      run('acquisition');
    }
    setPlaying('scanner', true);
  };
  q('scannerReset').onclick = resetAcquisition;
  q('scannerProgress').addEventListener('input', (e) => {
    setPlaying('scanner', false);
    progress = +e.target.value / 100;
    put('scannerProgressValue', (progress * 100).toFixed(0) + '%');
    if (!acqRunning) {
      acqRunning = true;
      run('acquisition');
    }
    drawDiagnostic();
    readouts();
    render('scanner');
  });
  q('scannerCamera').addEventListener('change', (e) => {
    views.scanner?.setCamera(e.target.value);
    render('scanner');
  });
  q('scannerHousing').addEventListener('change', () => {
    views.scanner?.configure(S);
    render('scanner');
  });
  for (const id of ['showTrues', 'showScatter', 'showRandoms'])
    q(id).addEventListener('change', () => {
      views.scanner?.updateEvent(event, eventClock);
      render('scanner');
    });
  q('benchPlay').onclick = () => setPlaying('bench', !playing.bench);
  q('benchAngle').addEventListener('input', (e) => {
    setPlaying('bench', false);
    benchAngle = +e.target.value;
    drawBench();
  });
  q('benchOffset').addEventListener('input', (e) => {
    benchOffset = +e.target.value;
    drawBench();
  });
  q('benchAct').addEventListener('change', (e) => {
    benchAct = +e.target.value;
    benchTime = 0;
    drawBench();
  });
  for (const id of ['benchSource', 'benchSpan', 'benchRingDifference']) q(id).addEventListener('input', drawBench);
  q('filmBuild').onclick = buildFilm;
  q('filmPlay').onclick = () => {
    if (filmData) setPlaying('film', !playing.film);
  };
  q('filmFrame').addEventListener('input', (e) => {
    setPlaying('film', false);
    filmIndex = +e.target.value;
    drawFilm();
  });
  q('filmAct').addEventListener('change', (e) => {
    setPlaying('film', false);
    if (filmData) {
      filmIndex = filmData.frames.findIndex((f) => f.act === +e.target.value);
      drawFilm();
    }
  });
  q('timelinePlay').onclick = () => setPlaying('timeline', !playing.timeline);
  q('timelinePosition').addEventListener('input', () => drawTimeline());
  q('timelineTime').addEventListener('input', (e) => {
    setPlaying('timeline', false);
    timelineTime = +e.target.value;
    drawTimeline(false);
  });
  q('timelineZoom').addEventListener('change', () => drawTimeline());
  q('timelineAct').addEventListener('change', (e) => {
    timelineAct = +e.target.value;
    timelineClock = 0;
    timelineTime = timelineAct === 3 ? 500 : 0;
    q('timelineZoom').checked = timelineAct < 2;
    drawTimeline();
  });
  for (const key of keys) {
    q(key + 'Aspect').value = 'wide';
    q(key + 'Aspect').addEventListener('change', (e) => {
      const ratio = { wide: 16 / 9, square: 1, portrait: 9 / 16 }[e.target.value],
        frame = q(key + 'RecordFrame');
      frame.dataset.aspect = e.target.value;
      frame.style.setProperty('--scene-ratio', String(ratio));
      frame.style.setProperty('--scene-numeric', String(ratio));
      views[key]?.resize();
      render(key);
    });
    q(key + 'Clean').onclick = () => {
      const section = q(sections[key]),
        on = section.dataset.clean !== 'true';
      section.dataset.clean = String(on);
      q(key + 'Clean').setAttribute('aria-pressed', String(on));
      put(key + 'Clean', on ? 'Exit clean view' : 'Clean UI');
      render(key);
    };
    q(key + 'Fullscreen').onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (q(key + 'RecordFrame').requestFullscreen) await q(key + 'RecordFrame').requestFullscreen();
        else {
          put(key + 'Fullscreen', 'Fullscreen unavailable');
          q(key + 'Fullscreen').disabled = true;
        }
      } catch (e) {
        put(
          key === 'film' ? 'filmStatus' : key === 'timeline' ? 'timelineStatus' : 'scannerStatus',
          'Fullscreen could not open. Use the selected frame format in the page.',
        );
      }
      views[key]?.resize();
      render(key);
    };
    q(key + 'GL').addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      setPlaying(key, false);
      fallback(key, 'The 3D context was lost. Quantitative panels still work; reload to restore the scene.');
    });
  }
  function pauseAll() {
    for (const key of keys) setPlaying(key, false);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAll();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      pauseAll();
      for (const key of keys) {
        q(sections[key]).dataset.clean = 'false';
        q(key + 'Clean').setAttribute('aria-pressed', 'false');
        put(key + 'Clean', 'Clean UI');
      }
    }
  });
  document.addEventListener('fullscreenchange', () => keys.forEach(render));
  matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change', (e) => {
    if (e.matches) pauseAll();
  });
  function handleMessage({ data: d }) {
    if (d.id !== jobs[d.channel]) return;
    if (d.type === 'error') {
      put(d.channel === 'film' ? 'filmStatus' : 'scannerStatus', 'Computation could not finish: ' + d.message);
      if (d.channel === 'acquisition') {
        acqRunning = false;
        setPlaying('scanner', false);
      }
      return;
    }
    if (d.type === 'progress') {
      put('filmStatus', d.message);
      return;
    }
    if (d.channel === 'bench' && d.type === 'result') {
      benchData = d;
      drawBench();
    } else if (d.channel === 'acquisition' && d.type === 'frame') {
      diagnostics.push(d);
      drawDiagnostic();
      render('scanner');
    } else if (d.channel === 'film' && d.type === 'result') {
      filmData = d;
      filmIndex = 0;
      q('filmFrame').max = String(d.frames.length - 1);
      q('filmFrame').disabled = false;
      q('filmPlay').disabled = false;
      drawFilm();
    }
  }
  drawEventList();
  for (const id of ['sceneRecon', 'sceneSino', 'benchSlice', 'benchSino', 'filmImage', 'filmRatio', 'filmBack'])
    blank(id);
  readouts();
  drawDiagnostic();
  drawBench();
  filmCharts();
  drawTimeline();
  try {
    source = ScenePhysics.sampler(volume);
    const r = ScenePhysics.rng(444);
    cloud = Array.from({ length: 2600 }, () => source.sample(r));
    // Only the scanner, bench and film use the worker; the timeline is analytic.
    if (!['scannerGL', 'benchGL', 'filmGL'].some(onPage)) throw Error('not needed');
    worker = new Worker(new URL('../workers/scene.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = handleMessage;
    worker.onerror = () => {
      worker = null;
      pauseAll();
      put('scannerStatus', 'The scene worker stopped; analytic views remain available.');
      put('filmStatus', 'The scene worker stopped; reload to compute the film.');
    };
    if (onPage('benchGL')) run('bench');
  } catch (e) {
    put('scannerStatus', 'The scene computation worker is unavailable. The analytic timeline still works.');
  }
  const stackCanvases = Array.from({ length: 9 }, (_, j) => {
    const z = 19 + j * 8,
      values = new Float32Array(4096);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++)
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) values[y * 64 + x] += volume[idx(2 * x + dx, 2 * y + dy, z)] / 128;
    return {
      canvas: imageCanvas(Float32Array.from(values).reverse(), 64, 64, 'inferno'),
      z: (z - 47.5) * 2,
    };
  });
  // Scenes present on this page; the others keep detached default controls.
  const present = keys.filter((key) => onPage(key + 'GL'));
  let SceneViews = null;
  // Each WebGL view is built when its frame approaches the viewport, so a page with four scenes
  // does not block the main thread building all of them at load.
  function initialise3D() {
    const create = (key) => {
      try {
        views[key] = SceneViews.create(key, q(key + 'GL'), q(key + 'HUD'), {
          cloud,
          colours,
          stack: stackCanvases,
          housing: () => q('scannerHousing').checked,
          show: (kind) =>
            q(
              {
                true: 'showTrues',
                scatter: 'showScatter',
                random: 'showRandoms',
              }[kind],
            ).checked,
          benchSlice: q('benchSlice'),
          benchSino: q('benchSino'),
          michelogram: q('benchMichelogram'),
          listMode: listCanvas,
          maxRingDifference: () => +q('benchRingDifference').value,
          filmImage: q('filmImage'),
          filmRatio: q('filmRatio'),
          filmBack: q('filmBack'),
          refreshBench: drawBench,
          refreshFilm: drawFilm,
          onFail: () => fallback(key, 'The 3D view stopped. Its numerical panels remain available.'),
        });
        views[key].configure(S);
        q(key + 'Fallback').hidden = true;
        if (key === 'timeline') drawTimeline();
        if (key === 'bench') drawBench();
        if (key === 'film') drawFilm();
        render(key);
      } catch (e) {
        fallback(key, '3D is unavailable here. The numerical panels and controls below remain usable.');
      }
    };
    if (typeof IntersectionObserver === 'undefined') {
      present.forEach(create);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          create(entry.target.dataset.sceneKey);
        }
      },
      { rootMargin: '300px 0px' },
    );
    for (const key of present) {
      const frame = q(key + 'RecordFrame');
      frame.dataset.sceneKey = key;
      observer.observe(frame);
    }
  }
  function loadThree() {
    if (!present.length) return;
    if (!window.WebGLRenderingContext && !window.WebGL2RenderingContext) {
      for (const key of present)
        fallback(key, 'WebGL is unavailable. The numerical panels and controls below still work.');
      return;
    }
    // Three.js is bundled and loaded only on pages that contain a 3D scene.
    import('./scene-views.js')
      .then((module) => {
        SceneViews = module.SceneViews;
        initialise3D();
      })
      .catch(() => {
        for (const key of present)
          fallback(key, 'The 3D library could not load. The numerical panels below still work.');
      });
  }
  q('theme').addEventListener('change', () => {
    filmCharts();
    drawTimeline(false);
    keys.forEach(render);
  });
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => {
    filmCharts();
    drawTimeline(false);
    keys.forEach(render);
  });
  let resizeTimer;
  window.addEventListener?.('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      filmCharts();
      drawTimeline();
      keys.forEach(render);
    }, 100);
  });
  loadThree();
  window.petScenes = {
    settings: S,
    updateSetting,
    handleMessage,
    pauseAll,
    buildFilm,
    resetAcquisition,
    readouts,
    drawBench,
    drawTimeline,
    views,
    jobs,
    state: () => ({
      playing: { ...playing },
      progress,
      filmFrames: filmData?.frames.length || 0,
      diagnosticFrames: diagnostics.length,
      benchAct,
      timelineAct,
    }),
  };
}
