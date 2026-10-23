/* Scanner scene: a horizontal-bore gantry, the phantom and the staged story of one coincidence.
   Geometry in mm. Patient [R,A,S] maps to world [-R, A, -S]: anterior up, the bore along z, the head
   end toward the default camera. Event objects are pooled; one event rebuilds only its paths. */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { ScenePhysics as P } from '../models/scene.js';
import { Physics } from '../models/physics.js';

const T = THREE;
export const world = (p) => [-p[0], p[1], -p[2]];

// Beats as fractions of one event's clock. Photons leave at RANGE_END; the farther one lands at FLIGHT_END.
const RANGE_END = 0.2,
  FLIGHT_END = 0.66,
  LOR_START = 0.8,
  LOR_DRAWN = 0.88,
  TRAIL = 150, // mm of bright comet tail behind each photon
  STEP = 4; // mm per trail segment
const clamp = (x) => Math.max(0, Math.min(1, x)),
  smooth = (x) => (x = clamp(x)) * x * (3 - 2 * x),
  lerp = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k),
  sub = (a, b) => a.map((v, i) => v - b[i]);

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'),
    r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.22, 'rgba(255,255,255,.6)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

// Translucent rim-lit shell for the schematic body: bright at grazing angles, nearly clear face-on.
function rimMaterial(color, strength = 0.5) {
  return new T.ShaderMaterial({
    uniforms: { color: { value: new T.Color(color) }, strength: { value: strength } },
    vertexShader:
      'varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0);' +
      ' vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader:
      'uniform vec3 color; uniform float strength; varying vec3 vN; varying vec3 vV; void main() {' +
      ' float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);' +
      ' gl_FragColor = vec4(color * (0.05 + f) * strength, 1.0); }',
    transparent: true,
    blending: T.AdditiveBlending,
    depthWrite: false,
  });
}

/** Polyline resampled into STEP-mm segments with cumulative distance. */
function sample(points) {
  const out = [points[0]],
    dist = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      d = sub(points[i], a),
      L = P.norm(d),
      n = Math.max(1, Math.ceil(L / STEP));
    for (let k = 1; k <= n; k++) {
      out.push(P.add(a, d, k / n));
      dist.push(dist.at(-1) + L / n);
    }
  }
  return { points: out, dist, length: dist.at(-1) };
}
function at(path, d) {
  const { points, dist } = path;
  for (let k = 1; k < dist.length; k++)
    if (d <= dist[k]) return lerp(points[k - 1], points[k], (d - dist[k - 1]) / Math.max(1e-9, dist[k] - dist[k - 1]));
  return points.at(-1);
}

export function createScanner({ root, story, inputs, C, camera, mesh, material }) {
  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let settings = null,
    cam = 'overview',
    blocks = null,
    flashes = null,
    ring = null,
    labels = [],
    chips = [],
    event = null,
    clock = 0,
    visible = false,
    tracks = [],
    lost = [],
    tofSpot = null,
    lensPath = null;
  const glowMap = glowTexture(),
    lineMaterials = [],
    colour = new T.Color(),
    matrix = new T.Matrix4();

  // Pooled story objects; never disposed by a gantry rebuild.
  function fat(width, opts = {}) {
    const m = new LineMaterial({
      color: opts.color ?? 0xffffff,
      linewidth: width,
      vertexColors: !!opts.vertex,
      transparent: true,
      opacity: opts.opacity ?? 1,
      blending: T.AdditiveBlending,
      depthWrite: false,
    });
    lineMaterials.push(m);
    const l = new Line2(new LineGeometry(), m);
    l.frustumCulled = false;
    l.visible = false;
    story.add(l);
    return l;
  }
  function glow(color = 0xffffff) {
    const s = new T.Sprite(
      new T.SpriteMaterial({ map: glowMap, color, blending: T.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    s.visible = false;
    story.add(s);
    return s;
  }
  const pool = {
    arms: [0, 1].map(() => ({
      line: fat(3, { vertex: true }),
      head: glow(),
      core: glow(0xffffff),
      hit: glow(C.detector),
    })),
    lost: [0, 1].map(() => ({ line: fat(2, { vertex: true }), head: glow(C.random) })),
    ghost: fat(1.5, { color: C.scatter, opacity: 0.55 }),
    lor: fat(3),
    tof: fat(8, { vertex: true }),
    emit: [glow(C.activity), glow(C.activity)],
    burst: [glow(0xffe6c8), glow(0xffe6c8)],
    kink: glow(C.scatter),
    tofGlow: glow(C.activity),
  };
  function shape(line, points, withColours = false) {
    line.geometry.dispose();
    const g = new LineGeometry();
    g.setPositions(points.flat());
    if (withColours) g.setColors(new Array(points.length * 3).fill(0));
    line.geometry = g;
    if (line.material.dashed) line.computeLineDistances();
  }
  function dash(line, kind) {
    const m = line.material;
    m.dashed = kind !== 'true';
    m.dashSize = kind === 'random' ? 3 : 10;
    m.gapSize = kind === 'random' ? 7 : 6;
  }
  function segment(line, a, b) {
    const buffer = line.geometry.attributes.instanceStart.data;
    buffer.array.set([...a, ...b]);
    buffer.needsUpdate = true;
    if (line.material.dashed) line.computeLineDistances();
    line.visible = true;
  }
  function place(sprite, p, size, opacity = 1) {
    sprite.visible = opacity > 0.01;
    sprite.position.set(...p);
    sprite.scale.setScalar(size);
    sprite.material.opacity = Math.min(1, opacity);
  }
  // Light the trail behind a photon at distance d: a bright comet that settles to a faint path.
  function paint(track, d, fade, floor) {
    const buffer = track.line.geometry.attributes.instanceColorStart.data,
      a = buffer.array,
      { dist } = track.path,
      level = (x) => fade * Math.max(floor, 1 - x / TRAIL);
    let n = 0;
    for (let k = 0; k < dist.length - 1 && dist[k] < d; k++) {
      const rgb = track.rgb[k],
        f0 = level(d - dist[k]),
        f1 = level(Math.max(0, d - dist[k + 1]));
      for (let c = 0; c < 3; c++) {
        a[k * 6 + c] = rgb[c] * f0;
        a[k * 6 + 3 + c] = rgb[c] * f1;
      }
      n = k + 1;
    }
    buffer.needsUpdate = true;
    track.line.geometry.instanceCount = n;
    track.line.visible = n > 0;
  }
  const linear = (hex) => {
    const c = new T.Color(hex);
    return [c.r, c.g, c.b];
  };

  /* ---------- Gantry, bed, body and phantom ---------- */
  function build(s, camera_) {
    settings = { ...s };
    cam = camera_;
    const radius = s.ring / 2,
      blockWidth = s.crystal * 8,
      nc = Math.max(24, Math.round((2 * Math.PI * radius) / blockWidth)),
      nr = Math.max(1, Math.ceil(s.fov / blockWidth));
    ring = { radius, nc, nr };
    // The gantry is built with its axis on local y, then turned so the bore runs along world z.
    const gantry = new T.Group();
    gantry.rotation.x = -Math.PI / 2;
    root.add(gantry);
    const g = new T.BoxGeometry(((2 * Math.PI * radius) / nc) * 0.94, (s.fov / nr) * 0.94, s.depth),
      dummy = new T.Object3D();
    blocks = new T.InstancedMesh(g, material(0x8a6b3c), nc * nr);
    blocks.material.roughness = 0.7;
    let n = 0;
    for (let j = 0; j < nr; j++)
      for (let i = 0; i < nc; i++) {
        const a = (i * 2 * Math.PI) / nc;
        dummy.position.set(
          (radius + s.depth / 2) * Math.sin(a),
          ((j + 0.5) * s.fov) / nr - s.fov / 2,
          (radius + s.depth / 2) * Math.cos(a),
        );
        dummy.rotation.set(0, a, 0);
        dummy.updateMatrix();
        blocks.setMatrixAt(n++, dummy.matrix);
      }
    gantry.add(blocks);
    flashes = new T.InstancedMesh(
      new T.BoxGeometry(((2 * Math.PI * radius) / nc) * 1.02, (s.fov / nr) * 1.02, s.depth * 1.08),
      new T.MeshBasicMaterial({ blending: T.AdditiveBlending, transparent: true, depthWrite: false }),
      2,
    );
    flashes.count = 0;
    flashes.frustumCulled = false;
    flashes.setColorAt(0, colour.set(0));
    gantry.add(flashes);
    if (inputs.housing()) {
      // A wedge facing the camera is cut away so the crystals stay visible; the axial view keeps it whole.
      const eye = pose(cam, 16 / 9).eye,
        centre = Math.atan2(eye[0], eye[1]),
        cut = cam === 'slice' ? 0 : (110 * Math.PI) / 180,
        start = centre + cut / 2,
        length = 2 * Math.PI - cut,
        shell = material(0x2d3c52, 0.94);
      gantry.add(
        new T.Mesh(new T.CylinderGeometry(radius + 65, radius + 65, s.fov + 40, 96, 1, true, start, length), shell),
      );
      gantry.add(
        new T.Mesh(
          new T.CylinderGeometry(radius - 6, radius - 6, s.fov + 40, 96, 1, true, start, length),
          material(0x8c9baa, 0.08),
        ),
      );
      for (const y of [-s.fov / 2 - 20, s.fov / 2 + 20]) {
        const face = new T.Mesh(
          new T.RingGeometry(radius - 6, radius + 65, 96, 1, Math.PI / 2 - centre + cut / 2, length),
          material(0x3a4c66, 0.96),
        );
        face.position.y = y;
        face.rotation.x = Math.PI / 2;
        gantry.add(face);
      }
    }
    if (s.mode === '2D')
      for (let y = -s.fov / 2; y < s.fov / 2; y += s.crystal * 4) {
        const septum = new T.Mesh(new T.RingGeometry(radius - 24, radius + s.depth, 72), material(0x66807f, 0.45));
        septum.position.y = y;
        septum.rotation.x = Math.PI / 2;
        gantry.add(septum);
      }
    // Bed and pedestal run out of the bore toward the feet (+z).
    mesh(new T.BoxGeometry(340, 18, 1850), 0x1d2c3e, [0, -136, 725]);
    mesh(new T.BoxGeometry(220, 500, 900), 0x141d29, [0, -395, 1250]);
    const body = [
      [
        [0, 0, 0],
        [84, 105, 92],
      ],
      [
        [0, -15, 165],
        [46, 44, 60],
      ],
      [
        [0, -20, 330],
        [150, 95, 240],
      ],
      [
        [185, -35, 430],
        [40, 40, 240],
      ],
      [
        [-185, -35, 430],
        [40, 40, 240],
      ],
      [
        [76, -40, 830],
        [58, 62, 300],
      ],
      [
        [-76, -40, 830],
        [58, 62, 300],
      ],
    ];
    for (const [pos, scale] of body) {
      const o = new T.Mesh(new T.SphereGeometry(1, 40, 24), rimMaterial(C.anatomy, pos[2] ? 0.5 : 0.7));
      o.position.set(...pos);
      o.scale.set(...scale);
      root.add(o);
    }
    const positions = [],
      colours = [];
    for (const p of inputs.cloud) {
      positions.push(...world(p.point));
      const k = Math.max(0, Math.min(255, Math.round((p.value / 7) * 255))),
        c = new T.Color(
          inputs.colours[k * 3] / 255,
          inputs.colours[k * 3 + 1] / 255,
          inputs.colours[k * 3 + 2] / 255,
        ).convertSRGBToLinear();
      colours.push(c.r, c.g, c.b);
    }
    const pg = new T.BufferGeometry();
    pg.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    pg.setAttribute('color', new T.Float32BufferAttribute(colours, 3));
    const cloudMap = new T.CanvasTexture(glowMap.image);
    cloudMap.colorSpace = T.SRGBColorSpace;
    root.add(
      new T.Points(
        pg,
        new T.PointsMaterial({
          size: 6,
          map: cloudMap,
          vertexColors: true,
          transparent: true,
          opacity: 0.85,
          blending: T.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
    labels = [{ p: [0, radius + 115, -s.fov / 2 - 30], text: 'Axial FOV ' + s.fov + ' mm' }];
    event = undefined; // force the current event to re-resolve crystal indices
  }

  /** Camera presets: { eye, target } in world mm, y up. */
  function pose(name, aspect) {
    const s = settings || P.defaults,
      radius = s.ring / 2,
      wide = Math.max(1, 1 / aspect);
    if (name === 'slice') return { eye: [0, 0, -((radius + 90) / (0.414 * 0.9)) * wide], target: [0, 0, 0] };
    // In the bore beside the head, looking across at the far crystal wall.
    if (name === 'inside')
      return {
        eye: [-0.62 * radius, 0.3 * radius, -0.3 * radius],
        target: [0.7 * radius, -0.15 * radius, 0.05 * radius],
      };
    const d = ((radius + 70) / (0.414 * 0.8)) * wide,
      dir = P.unit([0.52, 0.22, -0.83]),
      target = [0, -30, 40];
    return { eye: P.add(target, dir, d), target };
  }

  /* ---------- One coincidence ---------- */
  function blockIndex(p) {
    if (!blocks) return -1;
    // Inverse of the gantry turn: local = (x, -z, y).
    const a = (Math.atan2(p[0], p[1]) + 2 * Math.PI) % (2 * Math.PI),
      i = Math.round(a / ((2 * Math.PI) / ring.nc)) % ring.nc,
      j = Math.max(0, Math.min(ring.nr - 1, Math.floor(((-p[2] + settings.fov / 2) / settings.fov) * ring.nr)));
    return j * ring.nc + i;
  }
  function setup(e) {
    event = e;
    tracks = [];
    lost = [];
    tofSpot = null;
    lensPath = null;
    if (!e || !settings) return;
    const kind = e.kind,
      hex = kind === 'true' ? C.photon : kind === 'scatter' ? C.scatter : C.random,
      paths = e.arms.map((a) => sample(a.points.map(world))),
      dmax = Math.max(...paths.map((p) => p.length));
    tracks = e.arms.map((arm, i) => {
      const slot = pool.arms[i],
        path = paths[i],
        kinkD = arm.scatter ? P.norm(sub(arm.points[1], arm.points[0])) : Infinity,
        // A scattered photon changes colour at the kink: it carries less energy from there on.
        rgb = path.dist.map((d) => linear(kind === 'random' ? C.random : d < kinkD ? C.photon : C.scatter));
      dash(slot.line, kind);
      shape(slot.line, path.points, true);
      slot.head.material.color.setHex(kind === 'true' ? C.photon : kind === 'random' ? C.random : C.photon);
      let ghost = null;
      if (arm.scatter) {
        // Where the photon would have landed without scattering.
        const q = arm.points[1],
          u = P.unit(sub(q, arm.points[0])),
          h = P.hitCylinder(q, u, settings.ring / 2, settings.fov);
        ghost = [world(q), world(h ? h.point : P.add(q, u, settings.ring / 2))];
        dash(pool.ghost, 'scatter');
        shape(pool.ghost, ghost);
      }
      return {
        ...slot,
        arm,
        path,
        rgb,
        arrive: RANGE_END + ((FLIGHT_END - RANGE_END) * path.length) / dmax,
        hitPoint: world(arm.hit),
        block: blockIndex(world(arm.hit)),
        kink: arm.scatter ? { p: world(arm.points[1]), d: kinkD } : null,
        ghost,
      };
    });
    tracks.speed = dmax / (FLIGHT_END - RANGE_END);
    if (kind === 'random')
      // Each unrelated annihilation also sent a partner photon that was never detected.
      lost = e.arms.map((arm, i) => {
        const start = arm.points[0],
          u = P.unit(sub(start, arm.points[1])),
          path = sample([start, P.add(start, u, settings.ring * 0.62)].map(world)),
          slot = pool.lost[i];
        dash(slot.line, 'random');
        shape(slot.line, path.points, true);
        return { ...slot, path, rgb: path.dist.map(() => linear(C.random)) };
      });
    const order = [...tracks].sort((a, b) => a.arrive - b.arrive);
    tracks.first = order[0];
    tracks.second = order[1];
    shape(pool.lor, [order[0].hitPoint, order[0].hitPoint]);
    dash(pool.lor, kind);
    pool.lor.material.color.setHex(hex);
    if (settings.tof && kind === 'true') {
      const a = e.arms[0].hit,
        b = e.arms[1].hit,
        u = P.unit(sub(a, b)),
        centre = P.add(lerp(a, b, 0.5), u, e.tofPosition),
        fwhm = (settings.tof * P.c) / 2000,
        sigma = fwhm / 2.3548,
        points = [],
        rgb = [];
      for (let k = -24; k <= 24; k++) {
        const t = (k / 24) * 2.5 * sigma,
          w = Math.exp((-t * t) / (2 * sigma * sigma));
        points.push(world(P.add(centre, u, t)));
        rgb.push(...linear(C.activity).map((v) => v * w * 1.4));
      }
      shape(pool.tof, points);
      pool.tof.geometry.setColors(rgb);
      tofSpot = { p: world(centre), half: fwhm / 2 };
    }
    // A 2D random walk for the magnified positron track, ending exactly at the annihilation offset.
    const r = P.rng(1 + e.arms[0].id * 7919 + e.arms[1].id),
      N = 18,
      // Real tracks are tortuous: the path wanders at the isotope's typical scale, whatever the net range.
      mean = Physics.isotopes[settings.isotope].mean,
      step = Math.max(e.range, 0.5 * mean) * 0.3,
      walk = [[0, 0]];
    for (let k = 0; k < N; k++) {
      const a = 2 * Math.PI * r();
      walk.push([walk[k][0] + step * Math.cos(a), walk[k][1] + step * Math.sin(a)]);
    }
    const angle = 2 * Math.PI * r(),
      target = [e.range * Math.cos(angle), e.range * Math.sin(angle)],
      end = walk[N];
    lensPath = walk.map((p, k) => [p[0] - (k / N) * (end[0] - target[0]), p[1] - (k / N) * (end[1] - target[1])]);
    lensPath.field = [1, 2, 5, 10, 20, 50].find((v) => v >= 2.6 * Math.max(e.range, mean)) || 50;
  }
  function flash(index, k) {
    if (index < 0 || !flashes) return;
    const n = flashes.count;
    blocks.getMatrixAt(index, matrix);
    flashes.setMatrixAt(n, matrix);
    flashes.setColorAt(n, colour.setHex(C.detector).multiplyScalar(k));
    flashes.count = n + 1;
    flashes.instanceMatrix.needsUpdate = true;
    flashes.instanceColor.needsUpdate = true;
  }
  function update(e, u) {
    for (const o of story.children) o.visible = false;
    if (flashes) flashes.count = 0;
    chips = [];
    if (e !== event) setup(e);
    clock = u;
    visible = !!event && cam !== 'block' && inputs.show(event.kind) && tracks.length === 2;
    if (!visible) return;
    const kind = event.kind,
      still = reduced(),
      floor = still ? 1 : 0.22,
      d = Math.max(0, u - RANGE_END) * tracks.speed,
      fade = 1 - 0.55 * smooth((u - LOR_START) / 0.1);
    const sources =
      kind === 'random'
        ? [
            [event.origin, event.annihilation],
            [event.origin2, event.annihilation2],
          ]
        : [[event.origin, event.annihilation]];
    sources.forEach(([o, a], i) => {
      place(pool.emit[i], world(o), 18, u < RANGE_END ? 0.9 : 0.3);
      const x = (u - RANGE_END + 0.02) / 0.14;
      if (x > 0 && x < 1) place(pool.burst[i], world(a), 30 + 120 * x, (1 - x) ** 2);
    });
    for (const t of tracks) {
      paint(t, Math.min(d, t.path.length), fade, floor);
      if (d > 0 && d < t.path.length) {
        const p = at(t.path, d);
        t.head.material.color.setHex(t.kink && d >= t.kink.d ? C.scatter : kind === 'random' ? C.random : C.photon);
        place(t.head, p, 36);
        place(t.core, p, 10);
      }
      if (t.kink && d >= t.kink.d) {
        const x = (d - t.kink.d) / 90;
        if (x < 1) place(pool.kink, t.kink.p, 24 + 60 * x, 1 - x);
        pool.ghost.visible = true;
        pool.ghost.material.opacity = 0.55 * fade;
        if (!chips.some((c) => c.text === 'Compton scatter'))
          chips.push({ p: t.kink.p, text: 'Compton scatter', color: C.scatter });
      }
      if (u >= t.arrive) {
        const x = (u - t.arrive) / 0.1,
          k = 0.45 + 2.2 * Math.exp(-2.2 * x);
        flash(t.block, k);
        place(t.hit, t.hitPoint, 46 + 90 * Math.exp(-2 * x), Math.min(1, k));
        chips.push({ p: t.hitPoint, text: t.arm.energy.toFixed(0) + ' keV', color: C.detector });
      }
    }
    for (const l of lost) {
      const out = smooth((d - settings.ring / 2) / 150);
      paint(l, Math.min(d, l.path.length), 1 - 0.7 * out, 0.4);
      if (d > 0 && d < l.path.length) place(l.head, at(l.path, d), 26, 0.8 * (1 - out));
      if (d >= l.path.length * 0.75)
        chips.push({ p: l.path.points.at(-1), text: 'partner not detected', color: C.random });
    }
    if (u >= LOR_START) {
      const a = tracks.first.hitPoint,
        b = tracks.second.hitPoint;
      segment(pool.lor, a, lerp(a, b, still ? 1 : smooth((u - LOR_START) / (LOR_DRAWN - LOR_START))));
      if (tofSpot && u >= LOR_DRAWN) {
        const o = still ? 1 : smooth((u - LOR_DRAWN) / 0.06);
        pool.tof.visible = true;
        pool.tof.material.opacity = o;
        place(pool.tofGlow, tofSpot.p, 30, o);
        chips.push({ p: tofSpot.p, text: 'TOF ±' + tofSpot.half.toFixed(0) + ' mm', color: C.activity });
      }
    }
  }

  /** Title and caption for the current beat, or null when no event is on screen. */
  function stage() {
    if (!visible) return null;
    const u = clock,
      e = event,
      s = settings,
      half = s.window / 2;
    if (u < RANGE_END)
      return {
        title: 'Positron range',
        caption:
          'The ' +
          Physics.isotopes[s.isotope].label +
          ' positron wanders and annihilates ' +
          e.range.toFixed(2) +
          ' mm from where it was emitted (inset magnified).',
      };
    if (u < tracks.first.arrive)
      return {
        title: '511 keV photon flight',
        caption:
          e.kind === 'true'
            ? 'Two 511 keV photons leave almost back to back at the speed of light.'
            : e.kind === 'scatter'
              ? 'One photon Compton-scatters in tissue: it turns and loses energy.'
              : 'Two unrelated annihilations. One photon from each reaches the ring; the partners are lost.',
      };
    if (u < LOR_START)
      return {
        title: 'Detection and acceptance',
        caption:
          'Crystals ' +
          e.arms.map((a) => a.id).join(' and ') +
          ' record ' +
          e.arms.map((a) => a.energy.toFixed(0)).join(' and ') +
          ' keV, inside the ' +
          s.lower +
          '–650 keV window.',
      };
    return {
      title: 'Coincidence → line of response',
      caption:
        'Δt ' +
        Math.abs(e.dt).toFixed(2) +
        ' ns is inside the ±' +
        half +
        ' ns gate, so a line is recorded.' +
        (e.kind === 'true'
          ? tofSpot
            ? ' TOF places the source within ±' + tofSpot.half.toFixed(0) + ' mm.'
            : ' The source lies somewhere on it.'
          : e.kind === 'scatter'
            ? ' It misses the annihilation point.'
            : ' It joins two unrelated decays.'),
    };
  }

  /* ---------- 2D overlay: positron-range lens and coincidence window ---------- */
  function overlay(ctx, { width, height, header, footer, project, compact }) {
    if (!visible || compact) return;
    const u = clock,
      small = width < 600;
    if (lensPath && u < RANGE_END + 0.06) {
      const r = small ? 50 : 72,
        cx = width - 18 - r,
        cy = header + 16 + r,
        annihilation = world(event.annihilation),
        right = new T.Vector3().setFromMatrixColumn(camera.matrixWorld, 0),
        a = project(annihilation),
        b = project(P.add(annihilation, [right.x, right.y, right.z], 10)),
        sceneScale = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y) / 10),
        scale = (2 * r * 0.86) / lensPath.field,
        magnification = Number((scale / sceneScale).toPrecision(2)),
        progress = reduced() ? 1 : clamp(u / (RANGE_END * 0.85)),
        mid = lensPath.at(-1).map((v) => v / 2),
        X = (p) => [cx + (p[0] - mid[0]) * scale, cy - (p[1] - mid[1]) * scale];
      ctx.save();
      ctx.globalAlpha = u < RANGE_END ? 1 : 1 - (u - RANGE_END) / 0.06;
      if (a.front) {
        const k = Math.hypot(a.x - cx, a.y - cy) || 1;
        ctx.strokeStyle = 'rgba(232,238,245,.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(cx + ((a.x - cx) * r) / k, cy + ((a.y - cy) * r) / k);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(a.x, a.y, 6, 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(6,12,22,.94)';
      ctx.fill();
      ctx.strokeStyle = '#5d7591';
      ctx.stroke();
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(93,117,145,.25)';
      for (let g = -2; g <= 2; g++) {
        const o = (g * r) / 2.5;
        ctx.beginPath();
        ctx.moveTo(cx + o, cy - r);
        ctx.lineTo(cx + o, cy + r);
        ctx.moveTo(cx - r, cy + o);
        ctx.lineTo(cx + r, cy + o);
        ctx.stroke();
      }
      const n = lensPath.length - 1,
        upto = progress * n;
      ctx.strokeStyle = '#ff997b';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(...X(lensPath[0]));
      for (let k = 1; k <= Math.ceil(upto); k++)
        ctx.lineTo(...X(lerp(lensPath[k - 1], lensPath[k], Math.min(1, upto - (k - 1)))));
      ctx.stroke();
      ctx.fillStyle = '#ff997b';
      ctx.beginPath();
      ctx.arc(...X(lensPath[0]), 4, 0, 2 * Math.PI);
      ctx.fill();
      if (progress >= 1) {
        const [ex, ey] = X(lensPath[n]),
          burst = ctx.createRadialGradient(ex, ey, 0, ex, ey, 16);
        burst.addColorStop(0, 'rgba(255,240,220,1)');
        burst.addColorStop(1, 'rgba(255,240,220,0)');
        ctx.fillStyle = burst;
        ctx.fillRect(ex - 16, ey - 16, 32, 32);
      }
      const bar = (lensPath.field / 2) * scale;
      ctx.strokeStyle = '#c5d2e3';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - bar / 2, cy + r * 0.72);
      ctx.lineTo(cx + bar / 2, cy + r * 0.72);
      ctx.stroke();
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#c5d2e3';
      ctx.fillText(lensPath.field / 2 + ' mm', cx, cy + r * 0.72 - 6);
      ctx.restore();
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#c5d2e3';
      ctx.fillText('Positron range · ×' + magnification.toLocaleString(), cx, cy + r + 16);
      ctx.restore();
    }
    const first = tracks.first,
      second = tracks.second;
    if (u >= first.arrive) {
      const w = Math.min(300, width * 0.42),
        h = 66,
        x = width - 18 - w,
        y = height - footer - 14 - h,
        W = settings.window,
        dt = Math.abs(event.dt),
        X = (t) => x + 14 + ((t / W + 0.75) / 1.5) * (w - 28),
        done = u >= second.arrive;
      ctx.save();
      ctx.fillStyle = 'rgba(6,12,22,.86)';
      ctx.strokeStyle = '#3c536e';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect?.(x, y, w, h, 8) ?? ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.stroke();
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#9dafc5';
      ctx.fillText('COINCIDENCE WINDOW', x + 12, y + 17);
      ctx.fillStyle = 'rgba(239,189,109,.16)';
      ctx.fillRect(X(-W / 2), y + 27, X(W / 2) - X(-W / 2), 16);
      ctx.strokeStyle = '#efbd6d';
      ctx.strokeRect(X(-W / 2), y + 27, X(W / 2) - X(-W / 2), 16);
      ctx.strokeStyle = '#ef8ec9';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(0), y + 23);
      ctx.lineTo(X(0), y + 47);
      if (done) {
        ctx.moveTo(X(dt), y + 23);
        ctx.lineTo(X(dt), y + 47);
      }
      ctx.stroke();
      ctx.fillStyle = '#9dafc5';
      ctx.textAlign = 'center';
      ctx.fillText('−' + W / 2, X(-W / 2), y + 59);
      ctx.fillText('+' + W / 2 + ' ns', X(W / 2), y + 59);
      ctx.fillText('first hit', X(0), y + 59);
      if (done) {
        ctx.textAlign = 'right';
        ctx.fillStyle = '#70c7c0';
        ctx.fillText('Δt ' + dt.toFixed(2) + ' ns ✓', x + w - 12, y + 17);
      }
      ctx.restore();
    }
  }

  return {
    build,
    pose,
    update,
    stage,
    overlay,
    labels: () => labels.concat(chips),
    resize: (w, h) => lineMaterials.forEach((m) => m.resolution.set(w, h)),
    dispose: () => {
      glowMap.dispose();
      story.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
    },
  };
}
