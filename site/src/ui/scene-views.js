/* Four Three.js surfaces. Coordinates are mm unless the scene explicitly labels a diagram. */
import * as THREE from 'three';
import { ScenePhysics } from '../models/scene.js';
import { createScanner } from './scanner-scene.js';

export const SceneViews = (() => {
  const C = {
    activity: 0xff997b,
    photon: 0xef8ec9,
    detector: 0xefbd6d,
    scatter: 0xd28d5d,
    random: 0x9da6b4,
    anatomy: 0x70c7c0,
    text: '#e8eef5',
  };
  function create(kind, canvas, hud, inputs) {
    const T = THREE,
      renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = T.SRGBColorSpace;
    const scene = new T.Scene();
    scene.background = new T.Color(0x060c16);
    const camera = new T.PerspectiveCamera(45, 1, 0.1, 15000);
    camera.up.set(0, 1, 0);
    const root = new T.Group(),
      dynamic = new T.Group(),
      story = new T.Group();
    scene.add(root, dynamic, story, new T.HemisphereLight(0xffffff, 0x25304d, 2.0));
    const lamp = new T.DirectionalLight(0xffffff, 2);
    lamp.position.set(400, 700, 900);
    scene.add(lamp);
    let width = 0,
      height = 0,
      settings = { ...ScenePhysics.defaults },
      cam = 'overview',
      currentEvent = null,
      eventProgress = 1,
      labels = [],
      textures = [],
      lastHUD = {},
      orbit = { yaw: 0, pitch: 0, zoom: 1 },
      spin = { yaw: 0, pitch: 0 },
      drag = null,
      tween = null,
      pending = 0;
    const vec = (a) => new T.Vector3(...a),
      reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
      material = (color, opacity = 1) =>
        new T.MeshStandardMaterial({
          color,
          roughness: 0.58,
          metalness: 0.12,
          transparent: opacity < 1,
          opacity,
          side: T.DoubleSide,
        });
    function dispose(group) {
      group.traverse((x) => {
        x.geometry?.dispose();
        if (x.material) {
          const ms = Array.isArray(x.material) ? x.material : [x.material];
          for (const m of ms) {
            m.map?.dispose();
            m.dispose();
          }
        }
      });
      group.clear();
    }
    function mesh(geometry, color, pos = [0, 0, 0], opacity = 1, parent = root) {
      const o = new T.Mesh(geometry, material(color, opacity));
      o.position.set(...pos);
      parent.add(o);
      return o;
    }
    function line(points, color = C.photon, dashed = false, parent = dynamic) {
      const geometry = new T.BufferGeometry().setFromPoints(points.map(vec)),
        mat = dashed
          ? new T.LineDashedMaterial({
              color,
              dashSize: dashed === 'random' ? 2 : 8,
              gapSize: dashed === 'random' ? 6 : 5,
            })
          : new T.LineBasicMaterial({ color }),
        o = new T.Line(geometry, mat);
      if (dashed) o.computeLineDistances();
      parent.add(o);
      return o;
    }
    function sphere(pos, r, color, parent = dynamic, opacity = 1) {
      return mesh(new T.SphereGeometry(r, 14, 10), color, pos, opacity, parent);
    }
    function ellipsoid(pos, scale, opacity = 0.22) {
      const o = sphere(pos, 1, C.anatomy, root, opacity);
      o.scale.set(...scale);
      return o;
    }
    function texturePlane(source, pos, size = [220, 220]) {
      const texture = new T.CanvasTexture(source);
      texture.colorSpace = T.SRGBColorSpace;
      const o = new T.Mesh(new T.PlaneGeometry(...size), new T.MeshBasicMaterial({ map: texture, side: T.DoubleSide }));
      o.position.set(...pos);
      root.add(o);
      textures.push(texture);
      return o;
    }
    function preset(aspect) {
      let eye,
        target = [0, 0, 0];
      if (kind === 'scanner') {
        if (cam !== 'block') return scannerScene.pose(cam, aspect);
        eye = [70, 70, 150];
        target = [0, 0, -5];
      } else {
        const span = aspect < 0.85 ? 770 : 560,
          d = Math.max(span, 1050 / aspect) / (2 * Math.tan(Math.PI / 8));
        eye = [0, 65, d];
      }
      return { eye, target };
    }
    // Camera presets ease into each other: the target slides and the eye swings around it.
    function cameraPose(now = performance.now()) {
      const aspect = width / Math.max(1, height),
        to = preset(aspect),
        sph = new T.Spherical().setFromVector3(vec(to.eye).sub(vec(to.target)));
      camera.aspect = aspect;
      camera.up.set(0, 1, 0);
      sph.theta += orbit.yaw;
      sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi + orbit.pitch));
      sph.radius *= orbit.zoom;
      let target = vec(to.target);
      if (tween) {
        const x = Math.min(1, (now - tween.start) / tween.duration),
          k = x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2,
          from = tween.from;
        let dTheta = sph.theta - from.theta;
        dTheta -= 2 * Math.PI * Math.round(dTheta / (2 * Math.PI));
        sph.set(
          from.radius + (sph.radius - from.radius) * k,
          from.phi + (sph.phi - from.phi) * k,
          from.theta + dTheta * k,
        );
        target = from.target.clone().lerp(target, k);
        if (x >= 1) tween = null;
      }
      camera.position.copy(new T.Vector3().setFromSpherical(sph).add(target));
      camera.lookAt(target);
      camera.updateProjectionMatrix();
      camera.userData.target = target;
    }
    function scanner() {
      dispose(root);
      dispose(dynamic);
      labels = [];
      textures = [];
      story.visible = cam !== 'block';
      if (cam === 'block') {
        const d = settings.crystal,
          depth = settings.depth,
          w = d * 8;
        for (let j = 0; j < 8; j++)
          for (let i = 0; i < 8; i++) {
            mesh(new T.BoxGeometry(d * 0.94, d * 0.94, depth), C.detector, [(i - 3.5) * d, (j - 3.5) * d, 0], 0.85);
            mesh(new T.BoxGeometry(d * 0.84, d * 0.84, 2), 0x418f94, [(i - 3.5) * d, (j - 3.5) * d, -depth / 2 - 20]);
          }
        mesh(new T.BoxGeometry(w, w, 3), 0x8094ac, [0, 0, -depth / 2 - 8], 0.55);
        line(
          [
            [0, 0, depth / 2],
            [0, 0, -depth / 2 - 19],
          ],
          C.detector,
          false,
          root,
        );
        labels = [
          { p: [w / 2 + 7, 0, 0], text: '8 × 8 crystal array' },
          { p: [0, -w / 2 - 8, -depth / 2 - 8], text: 'Light guide → SiPM array' },
        ];
        return;
      }
      scannerScene.build(settings, cam);
      labels = scannerScene.labels();
    }
    function boards(sources, names) {
      textures.forEach((t) => t.dispose());
      dispose(root);
      dispose(dynamic);
      labels = [];
      textures = [];
      const portrait = width / Math.max(1, height) < 0.85,
        positions = portrait
          ? [
              [0, 220, 0],
              [0, -10, 0],
              [0, -240, 0],
            ]
          : [
              [-310, 0, 0],
              [0, 0, 0],
              [310, 0, 0],
            ];
      sources.forEach((source, i) => {
        texturePlane(source, positions[i], [220, 200]);
        labels.push({ p: [positions[i][0], positions[i][1] + 118, 1], text: names[i] });
      });
      return positions;
    }
    let benchPositions, filmPositions;
    function bench() {
      benchPositions = boards(
        [inputs.benchSlice, inputs.benchSino, inputs.michelogram],
        ['Activity / transverse plane', 's–φ projection space', 'Axial ring-pair map'],
      );
      const table = new T.CanvasTexture(inputs.listMode || inputs.michelogram);
      table.colorSpace = T.SRGBColorSpace;
      textures.push(table);
      for (let i = 1; i < 3; i++)
        line(
          [
            benchPositions[i - 1].map((x, j) => x + (j === 2 ? -12 : 0)),
            benchPositions[i].map((x, j) => x + (j === 2 ? -12 : 0)),
          ],
          0x3e536c,
          true,
          root,
        );
    }
    function updateBench(angle, s, act = 0) {
      if (!benchPositions) return;
      dispose(dynamic);
      const p = benchPositions[0],
        phi = (angle * Math.PI) / 180,
        scale = 220 / 256,
        points = [-145, 145].map((t) => [
          p[0] + (-s * Math.cos(phi) + t * Math.sin(phi)) * scale,
          p[1] + (s * Math.sin(phi) + t * Math.cos(phi)) * scale,
          3,
        ]);
      line(points, C.photon);
      sphere([p[0] - 34 * scale, p[1] + 22 * scale, 5], 4, C.activity);
      if (root.children[2]) {
        root.children[2].visible = act !== 3;
        root.children[2].material.map = textures[act === 2 ? 3 : 2];
      }
      if (act === 3) {
        const base = benchPositions[2],
          stack = new T.Group();
        stack.position.set(...base);
        stack.rotation.x = 0.5;
        dynamic.add(stack);
        for (let i = 0; i < 9; i++) {
          const o = mesh(new T.TorusGeometry(90, 1.3, 5, 48), C.detector, [0, (i - 4) * 19, 0], 0.65, stack);
          o.rotation.x = Math.PI / 2;
        }
        for (const slice of inputs.stack || []) {
          const texture = new T.CanvasTexture(slice.canvas);
          texture.colorSpace = T.SRGBColorSpace;
          const o = new T.Mesh(
            new T.PlaneGeometry(180, 180),
            new T.MeshBasicMaterial({
              map: texture,
              side: T.DoubleSide,
              transparent: true,
              opacity: 0.42,
              depthWrite: false,
            }),
          );
          o.position.set(0, slice.z * 0.7, 0);
          o.rotation.x = -Math.PI / 2;
          stack.add(o);
        }
        const difference = inputs.maxRingDifference?.() ?? 4,
          dy = (difference * 19) / 2;
        line(
          [
            [-90, -dy, 0],
            [90, dy, 0],
          ],
          C.photon,
          false,
          stack,
        );
        labels[2].text = 'Phantom slices / ' + (difference ? 'oblique' : 'direct') + ' ring pair';
      } else labels[2].text = act === 2 ? 'Illustrated list-mode records' : 'Axial ring-pair map';
      textures.forEach((t) => (t.needsUpdate = true));
    }
    function film() {
      filmPositions = boards(
        [inputs.filmImage, inputs.filmRatio, inputs.filmBack],
        ['Current image', 'Measured / predicted', 'Backprojected ratio'],
      );
      for (let i = 1; i < 3; i++)
        line(
          [
            filmPositions[i - 1].map((x, j) => x + (j === 2 ? -15 : 0)),
            filmPositions[i].map((x, j) => x + (j === 2 ? -15 : 0)),
          ],
          C.detector,
          true,
          root,
        );
    }
    function updateFilm(act) {
      textures.forEach((t) => (t.needsUpdate = true));
      if (labels[0]) labels[0].text = act === 1 ? 'Backprojection / FBP' : 'Current activity estimate';
      if (labels[1]) labels[1].text = act === 1 ? 'Measured sinogram' : 'Measured / predicted';
      if (labels[2]) labels[2].text = act === 2 ? 'Full-data correction factor' : 'Assigned reference activity';
    }
    let timingInfo,
      zoom = false;
    function timeline(info, flightZoom) {
      dispose(root);
      dispose(dynamic);
      labels = [];
      textures = [];
      timingInfo = info;
      zoom = flightZoom;
      const max = zoom ? 6 : info.end,
        X = (t) => -420 + (840 * t) / max;
      line(
        [
          [-420, -155, 0],
          [420, -155, 0],
        ],
        0x63758d,
        false,
        root,
      );
      for (let j = 0; j <= 5; j++) {
        const x = -420 + (840 * j) / 5;
        line(
          [
            [x, -160, 0],
            [x, 160, 0],
          ],
          0x203145,
          false,
          root,
        );
        labels.push({ p: [x, -187, 0], text: ((max * j) / 5).toFixed(zoom ? 1 : 0) + ' ns' });
      }
      for (const [arrival, y, color] of [
        [info.near, 65, C.photon],
        [info.far, -45, C.detector],
      ]) {
        const points = [];
        for (let j = 0; j <= 420; j++) {
          const t = (max * j) / 420;
          points.push([X(t), y + 65 * ScenePhysics.pulse(t, arrival, info.tau), 0]);
        }
        line(points, color, false, root);
        if (arrival <= max) {
          sphere([X(arrival), y, 0], 5, color, root);
          line(
            [
              [X(0), y - 25, 0],
              [X(arrival), y - 25, 0],
            ],
            color,
            false,
            root,
          );
          const stamp = arrival + ScenePhysics.cfd(info.tau);
          line(
            [
              [X(stamp), y - 10, 4],
              [X(stamp), y + 38, 4],
            ],
            color,
            true,
            root,
          );
        }
        if (!zoom) {
          const left = X(arrival),
            right = X(arrival + info.gate);
          mesh(new T.BoxGeometry(right - left, 9, 3), color, [(left + right) / 2, y - 12, -3], 0.4);
          const delayed = [];
          for (let j = 0; j <= 420; j++) {
            const t = (max * j) / 420;
            delayed.push([X(t), y + 65 * ScenePhysics.pulse(t, arrival + 500, info.tau), 0]);
          }
          line(delayed, C.random, 'random', root);
        }
      }
      labels.push({
        p: [-370, 167, 0],
        text: zoom ? 'Flight / CFD detail · linear scale' : 'Prompt pulse → integration → delayed copy',
      });
      cameraPose();
    }
    function updateTimeline(time) {
      if (!timingInfo) return;
      dispose(dynamic);
      const max = zoom ? 6 : timingInfo.end,
        x = -420 + (840 * Math.min(max, time)) / max;
      line(
        [
          [x, -155, 5],
          [x, 175, 5],
        ],
        C.activity,
      );
      if (time <= max) sphere([x, 0, 5], 6, C.activity);
    }
    function updateEvent(event, progress) {
      currentEvent = event;
      eventProgress = progress;
      if (kind !== 'scanner') return;
      scannerScene.update(event, progress);
      if (cam !== 'block') labels = scannerScene.labels();
    }
    function wrap(ctx, text, x, y, max, lineHeight, maxLines = 3) {
      const words = text.split(' ');
      let lineText = '',
        row = 0;
      for (const word of words) {
        const next = lineText ? lineText + ' ' + word : word;
        if (ctx.measureText(next).width > max && lineText) {
          ctx.fillText(lineText, x, y + row * lineHeight);
          lineText = word;
          if (++row >= maxLines) return;
        } else lineText = next;
      }
      ctx.fillText(lineText, x, y + row * lineHeight);
    }
    function overlay(data) {
      lastHUD = data;
      const ctx = hud.getContext('2d'),
        ratio = Math.min(2, window.devicePixelRatio || 1);
      hud.width = Math.round(width * ratio);
      hud.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const small = width < 600,
        compact = height < 350,
        font = compact ? 16 : small ? 18 : 24,
        scales = data.scales || [],
        header = compact ? 43 : small ? 82 : 77,
        footer = compact ? 65 : scales.length ? 128 : small ? 101 : 86;
      // Header and footer fade into the scene rather than boxing it in.
      const top = ctx.createLinearGradient(0, 0, 0, header + 18),
        bottom = ctx.createLinearGradient(0, height - footer - 18, 0, height);
      top.addColorStop(0, 'rgba(6,12,22,.92)');
      top.addColorStop(0.7, 'rgba(6,12,22,.72)');
      top.addColorStop(1, 'rgba(6,12,22,0)');
      bottom.addColorStop(0, 'rgba(6,12,22,0)');
      bottom.addColorStop(0.3, 'rgba(6,12,22,.72)');
      bottom.addColorStop(1, 'rgba(6,12,22,.92)');
      ctx.fillStyle = top;
      ctx.fillRect(0, 0, width, header + 18);
      ctx.fillStyle = bottom;
      ctx.fillRect(0, height - footer - 18, width, footer + 18);
      ctx.textAlign = 'left';
      ctx.fillStyle = C.text;
      ctx.font = '600 ' + font + 'px system-ui';
      wrap(ctx, data.title || '', 18, compact ? 26 : 30, width - 36, font + 4, compact ? 1 : 2);
      if (!compact) {
        ctx.fillStyle = '#9dafc5';
        ctx.font = '13px monospace';
        ctx.fillText(data.kicker || 'SYNTHETIC PHANTOM · EDUCATIONAL MODEL', 18, small ? 72 : 63);
        ctx.font = (small ? 14 : 17) + 'px system-ui';
        ctx.fillStyle = '#d5e0ee';
        wrap(ctx, data.caption || '', 18, height - footer + 24, width - 36, small ? 19 : 23, 2);
      }
      if (scales.length) {
        const gap = 16,
          bw = (width - 36 - gap * (scales.length - 1)) / scales.length;
        ctx.font = '12px monospace';
        for (let k = 0; k < scales.length; k++) {
          const x = 18 + k * (bw + gap),
            y = height - 33;
          ctx.fillStyle = '#c5d2e3';
          ctx.textAlign = 'left';
          ctx.fillText(scales[k].label, x, y - 9);
          for (let j = 0; j < 64; j++) {
            const v = Math.round((j / 63) * 255);
            ctx.fillStyle =
              'rgb(' + inputs.colours[v * 3] + ',' + inputs.colours[v * 3 + 1] + ',' + inputs.colours[v * 3 + 2] + ')';
            ctx.fillRect(x + (j * bw) / 64, y, bw / 64 + 1, 6);
          }
          ctx.fillStyle = '#c5d2e3';
          ctx.fillText('0', x, y + 23);
          ctx.textAlign = 'right';
          ctx.fillText(scales[k].max, x + bw, y + 23);
        }
      } else {
        ctx.font = '13px monospace';
        ctx.fillStyle = '#f1bd77';
        ctx.fillText(data.readout || '', 18, height - 13, width - 36);
      }
      camera.updateMatrixWorld();
      const project = (point) => {
        const p = vec(point).project(camera);
        return { x: ((p.x + 1) * width) / 2, y: ((1 - p.y) * height) / 2, front: p.z < 1 };
      };
      if (kind === 'scanner' && cam !== 'block')
        scannerScene.overlay(ctx, { width, height, header, footer, project, compact });
      if (compact) return;
      ctx.textAlign = 'center';
      for (const label of labels) {
        // Coloured labels are small chips that sit just above the thing they name.
        const chip = label.color !== undefined,
          { x, y: py, front } = project(label.p),
          y = chip ? py - 16 : py;
        ctx.font = chip ? '12px monospace' : (small ? 12 : 15) + 'px monospace';
        if (front && x > 30 && x < width - 30 && y > header + 10 && y < height - footer - 15) {
          const measure = ctx.measureText(label.text).width,
            hex = chip ? '#' + label.color.toString(16).padStart(6, '0') : '#b9c8db';
          ctx.fillStyle = 'rgba(6,12,22,.82)';
          ctx.fillRect(x - measure / 2 - 5, y - (chip ? 13 : 15), measure + 10, chip ? 18 : 22);
          if (chip) {
            ctx.strokeStyle = hex;
            ctx.lineWidth = 1;
            ctx.strokeRect(x - measure / 2 - 5, y - 13, measure + 10, 18);
          }
          ctx.fillStyle = hex;
          ctx.fillText(label.text, x, y);
        }
      }
    }
    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect(),
        w = Math.max(1, rect.width),
        h = Math.max(1, rect.height);
      if (w === width && h === height) return;
      width = w;
      height = h;
      renderer.setSize(width, height, false);
      scannerScene?.resize(width, height);
      cameraPose();
      if (kind === 'bench') {
        bench();
        inputs.refreshBench?.();
      }
      if (kind === 'film') {
        film();
        inputs.refreshFilm?.();
      }
      overlay(lastHUD);
    }
    // Renders are coalesced into one per animation frame; camera easing and orbit inertia keep
    // the loop alive on their own and stop it when they settle.
    function frame(now) {
      pending = 0;
      try {
        resize();
        if (!drag && (Math.abs(spin.yaw) > 1e-4 || Math.abs(spin.pitch) > 1e-4)) {
          orbit.yaw += spin.yaw;
          orbit.pitch += spin.pitch;
          spin.yaw *= 0.9;
          spin.pitch *= 0.9;
        } else if (!drag) spin = { yaw: 0, pitch: 0 };
        cameraPose(now);
        renderer.render(scene, camera);
        overlay(lastHUD);
        if (tween || spin.yaw || spin.pitch) requestFrame();
      } catch (e) {
        tween = null;
        inputs.onFail?.(e);
      }
    }
    function requestFrame() {
      if (!pending) pending = requestAnimationFrame(frame);
    }
    function render(data = lastHUD) {
      lastHUD = data;
      requestFrame();
    }
    function configure(s) {
      settings = { ...s };
      if (kind === 'scanner') {
        scanner();
        updateEvent(currentEvent, eventProgress);
      }
      cameraPose();
    }
    function setCamera(name) {
      // The exploded block is a different scene, so only ring views ease between each other.
      const ease = !reduced() && cam !== 'block' && name !== 'block' && width > 1;
      if (ease) {
        const target = camera.userData.target?.clone() || new T.Vector3(),
          from = new T.Spherical().setFromVector3(camera.position.clone().sub(target));
        tween = { start: performance.now(), duration: 900, from: Object.assign(from, { target }) };
      } else tween = null;
      cam = name;
      orbit = { yaw: 0, pitch: 0, zoom: 1 };
      spin = { yaw: 0, pitch: 0 };
      scanner();
      cameraPose();
      updateEvent(currentEvent, eventProgress);
    }
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      tween = null;
      spin = { yaw: 0, pitch: 0 };
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      spin = { yaw: (e.clientX - drag.x) * 0.007, pitch: (e.clientY - drag.y) * 0.007 };
      orbit.yaw += spin.yaw;
      orbit.pitch += spin.pitch;
      drag = { x: e.clientX, y: e.clientY };
      render();
    });
    const release = () => {
      drag = null;
      if (reduced()) spin = { yaw: 0, pitch: 0 };
      render();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        orbit.zoom = Math.max(0.35, Math.min(3, orbit.zoom * Math.exp(e.deltaY * 0.001)));
        render();
      },
      { passive: false },
    );
    const scannerScene = kind === 'scanner' ? createScanner({ root, story, inputs, C, camera, mesh, material }) : null;
    resize();
    if (kind === 'scanner') scanner();
    if (kind === 'bench') bench();
    if (kind === 'film') film();
    cameraPose();
    return {
      render,
      resize,
      configure,
      setCamera,
      updateEvent,
      stage: () => (cam === 'block' ? null : scannerScene?.stage()),
      beats: () => scannerScene?.beats(),
      spawn: (e, t) => scannerScene?.spawn(e, t),
      advance: (dt) => scannerScene?.advance(dt),
      commit: (e, t) => scannerScene?.commit(e, t),
      showUntil: (t) => scannerScene?.showUntil(t),
      trimLines: (t) => scannerScene?.trim(t),
      clearLines: () => scannerScene?.clear(),
      updateBench,
      updateFilm,
      timeline,
      updateTimeline,
      refreshTextures: () => textures.forEach((t) => (t.needsUpdate = true)),
      dispose: () => {
        textures.forEach((t) => t.dispose());
        dispose(root);
        dispose(dynamic);
        scannerScene?.dispose();
        renderer.dispose();
      },
      getScene: () => scene,
      getCamera: () => camera,
    };
  }
  return { create, colors: C };
})();
