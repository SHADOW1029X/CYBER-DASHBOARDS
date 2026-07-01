/* ════════════════════════════════════════════════════════════════════
   COMBAT DRONE — scroll-driven WebGL companion
   ════════════════════════════════════════════════════════════════════
   Architecture mirrors the PeachWeb clown-fish technique:
     • The drone's WORLD POSITION maps 1:1 to SCREEN position
       (camera is fixed, looking down -Z at a z=0 plane).
     • Scroll progress drives keyframed screen-space X/Y, scale,
       yaw / pitch / roll — producing the same "weaving between
       content corners" feeling, but with real drone flight physics
       (banks into turns, pitches on climb/dive, idle hover jitter).
     • The drone is hidden during #hero (first section) and fades in
       once the user scrolls into #focus (second section onward),
       then persists, corner-to-corner, through every remaining
       section down to the footer.

   Isolation: runs in its own IIFE, guards every DOM lookup, never
   throws past its boundary, and namespaces all globals. If anything
   here fails, the rest of the page (preloader, warrior canvas, tab
   shaders, etc.) is completely unaffected.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CANVAS = document.getElementById('droneCanvas');
  if (!CANVAS) return; // markup not present — nothing to do

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return; // respect user preference — canvas is display:none via CSS too
  }

  /* ── Sequential script loader (jsdelivr → unpkg fallback) ──────────
     Keeps this module 100% self-contained: no dependency on whether
     Three.js happens to be loaded elsewhere on the page. */
  var CDN = ['https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/'];
  var QUEUE = [
    'three@0.134.0/build/three.min.js',
    'three@0.134.0/examples/js/loaders/GLTFLoader.js'
  ];

  function loadOne(pkg, cdnIdx, onOk, onFail) {
    var s = document.createElement('script');
    s.src = CDN[cdnIdx] + pkg;
    s.onload = onOk;
    s.onerror = function () {
      if (cdnIdx + 1 < CDN.length) loadOne(pkg, cdnIdx + 1, onOk, onFail);
      else onFail(pkg);
    };
    document.head.appendChild(s);
  }
  function loadNext(i) {
    if (i >= QUEUE.length) { init(); return; }
    loadOne(QUEUE[i], 0, function () { loadNext(i + 1); }, function (pkg) {
      console.warn('[drone] failed to load', pkg, '— companion disabled');
    });
  }
  loadNext(0);

  /* ════════════════════════════════════════════════════════════════
     MAIN INITIALISATION — runs once Three.js + GLTFLoader are ready
     ════════════════════════════════════════════════════════════════ */
  function init() {
    if (typeof THREE === 'undefined' || !THREE.GLTFLoader) {
      console.warn('[drone] THREE/GLTFLoader unavailable — companion disabled');
      return;
    }

    try {

      /* ── Renderer ──────────────────────────────────────────────
         alpha:true so the page's own background shows through;
         the drone canvas only ever paints the model + its glow. */
      var renderer = new THREE.WebGLRenderer({
        canvas: CANVAS, antialias: true, alpha: true, powerPreference: 'high-performance'
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.LinearToneMapping; // no ACES bloom-overflow risk
      renderer.toneMappingExposure = 1.0;
      renderer.setClearColor(0x000000, 0);

      var scene = new THREE.Scene();

      /* ── Camera ────────────────────────────────────────────────
         Fixed perspective camera looking down -Z at the z=0 plane.
         World XY at z=0 maps directly to screen position — this is
         what lets scroll-driven keyframes feel like "fish swimming
         across the screen" rather than a 3D fly-through. */
      var CAM_Z = 9;
      var FOV = 38;
      var camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.05, 200);
      camera.position.set(0, 0, CAM_Z);
      camera.lookAt(0, 0, 0);

      function halfH() { return CAM_Z * Math.tan(THREE.MathUtils.degToRad(FOV / 2)); }
      function halfW() { return halfH() * (window.innerWidth / window.innerHeight); }

      /* ── Lights ────────────────────────────────────────────────
         Cool blue/cyan key + magenta rim, matching NYTHERION's
         --blue / --magenta accent palette so the drone feels native
         to the site rather than a foreign drop-in. */
      scene.add(new THREE.AmbientLight(0x3a4a78, 2.0));

      // Key: cooler, stronger — simulates a bright environment reflection
      var key = new THREE.DirectionalLight(0xddeeff, 6.5);
      key.position.set(3, 6, 6); scene.add(key);

      // Sharp specular highlight — positioned to catch top-front surfaces
      var spec = new THREE.DirectionalLight(0xffffff, 5.0);
      spec.position.set(1, 10, 5); scene.add(spec);

      // Rim: warm white back-light — creates the metallic edge catch
      var rim = new THREE.DirectionalLight(0xffffff, 4.5);
      rim.position.set(-6, 4, -3); scene.add(rim);

      // Secondary rim: cyan accent to match site palette
      var rim2 = new THREE.DirectionalLight(0x22c6e6, 2.8);
      rim2.position.set(5, -2, -4); scene.add(rim2);

      var fill = new THREE.DirectionalLight(0x3f8cff, 2.2);
      fill.position.set(4, -2, 4); scene.add(fill);

      var glowA = new THREE.PointLight(0x3f8cff, 5.5, 5.5);
      var glowB = new THREE.PointLight(0x22c6e6, 4.0, 4.0);
      scene.add(glowA, glowB);

      /* ── Subtle ambient particles (depth cue, very low opacity) ─ */
      (function () {
        var n = 160, pos = new Float32Array(n * 3);
        for (var i = 0; i < n; i++) {
          pos[i * 3] = (Math.random() - 0.5) * 20;
          pos[i * 3 + 1] = (Math.random() - 0.5) * 26;
          pos[i * 3 + 2] = (Math.random() - 0.5) * 8 - 2;
        }
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
          size: 0.035, color: 0x9fc4ff, transparent: true, opacity: 0.22
        })));
      })();

      /* ════════════════════════════════════════════════════════
         SECTION-ANCHORED FLIGHT PATH
         ════════════════════════════════════════════════════════
         Rather than hand-picking arbitrary keyframe percentages
         (fragile if content length changes), we measure every
         section from #focus onward and place one flight waypoint
         per section boundary, in an alternating-corner pattern —
         exactly like the clown fish darting between content blocks
         on peachweb.io. Waypoints are expressed in SCREEN-normalised
         units (x:[-1,1], y:[-1,1]) and converted to world units
         against camera distance each frame (so it stays correct
         across any viewport / resize). */

      var SECTION_IDS = [
        'focus', 'ideaSection', 'how-it-works', 'warriorSection',
        'physicsSection', 'engineSection', 'touchSection',
        'pages', 'stack', 'manifestoSection'
      ];

      // Alternating corner targets per section (screen-normalised).
      // Values stay within ±0.86 so the drone never clips off-screen.
      var CORNER_PATTERN = [
        { x: 0.74, y: 0.62 },   // top-right
        { x: -0.78, y: -0.40 }, // bottom-left
        { x: 0.70, y: -0.58 },  // bottom-right
        { x: -0.72, y: 0.55 },  // top-left
        { x: 0.62, y: 0.10 },   // mid-right
        { x: -0.66, y: 0.05 },  // mid-left
        { x: 0.78, y: -0.30 },  // lower-right
        { x: -0.74, y: 0.62 },  // top-left
        { x: 0.68, y: 0.58 },   // top-right
        { x: -0.20, y: -0.62 }  // bottom-center (settles near footer)
      ];

      /* Build keyframe arrays once layout is known. Recomputed on
         resize/orientation change since section heights can reflow. */
      var KX = [], KY = [], KS = [], docHeight = 1;

      /* ── Per-session randomisation ───────────────────────────────
         Two independent sources of randomness, generated ONCE per
         page load (cheap, no per-frame cost):
           1. CORNER_JITTER — nudges each waypoint a little so the
              route isn't identical corner-to-corner every visit.
           2. BACKTRACK_PULSES — a small handful of scroll positions
              where the drone will briefly reverse along its own path
              before continuing forward, like a real drone correcting
              or glancing back. Few in number, smooth in/out, so it
              reads as natural hesitation rather than jitter. */
      function rand(min, max) { return min + Math.random() * (max - min); }
      function clampRange(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

      var CORNER_JITTER = CORNER_PATTERN.map(function () {
        return { dx: rand(-0.05, 0.05), dy: rand(-0.045, 0.045), ds: rand(-0.08, 0.10) };
      });

      var BACKTRACK_PULSES = (function () {
        var count = 3 + Math.floor(Math.random() * 2); // 3–4 backward dips total
        var pulses = [];
        var minGap = 0.16;
        var attempts = 0;
        while (pulses.length < count && attempts < 60) {
          attempts++;
          var c = rand(0.14, 0.90);
          var ok = pulses.every(function (p) { return Math.abs(p.center - c) > minGap; });
          if (!ok) continue;
          pulses.push({
            center: c,
            halfWidth: rand(0.016, 0.028),
            amount: rand(0.045, 0.075) // how far back along the path it dips
          });
        }
        return pulses;
      })();

      // Smooth 0..1 dip shaped like a bump — 0 at both edges of the
      // window, peaking at the center. Used to pull the sample time
      // backward for a moment without any velocity discontinuity.
      function backtrackWarp(t) {
        var total = 0;
        for (var i = 0; i < BACKTRACK_PULSES.length; i++) {
          var p = BACKTRACK_PULSES[i];
          var d = (t - p.center) / p.halfWidth;
          if (d > -1 && d < 1) {
            var u = (d + 1) * 0.5; // 0..1 across the window
            total += p.amount * Math.sin(u * Math.PI);
          }
        }
        return total;
      }

      function buildPath() {
        docHeight = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
        var focusEl = document.getElementById('focus');
        var focusTop = focusEl ? focusEl.offsetTop : 0;

        KX = []; KY = []; KS = [];

        // Before #focus: drone stays parked off the top edge (invisible / fading).
        KX.push({ at: 0, v: CORNER_PATTERN[0].x });
        KY.push({ at: 0, v: 1.15 }); // parked above viewport
        KS.push({ at: 0, v: 0.85 });

        var prevAt = 0;
        for (var i = 0; i < SECTION_IDS.length; i++) {
          var el = document.getElementById(SECTION_IDS[i]);
          if (!el) continue;
          var rect = el.getBoundingClientRect();
          var top = window.scrollY + rect.top;
          var mid = top + rect.height * 0.5;
          var at = clamp01((mid - 0) / docHeight);
          // guarantee monotonic, minimum spacing so easing never collapses
          if (at <= prevAt + 0.015) at = prevAt + 0.015;
          prevAt = at;

          var c = CORNER_PATTERN[i % CORNER_PATTERN.length];
          var j = CORNER_JITTER[i % CORNER_JITTER.length];
          // gentle scale pulse — bigger when entering a section, easing
          // down slightly mid-section, matching the PeachWeb depth illusion
          var pulse = 0.92 + (i % 3 === 0 ? 0.18 : i % 3 === 1 ? -0.06 : 0.08);

          // Jittered, per-session waypoint — keeps the route inside the
          // same safe on-screen bounds as the base corner pattern while
          // making the actual path different on every page load.
          KX.push({ at: at, v: clampRange(c.x + j.dx, -0.86, 0.86) });
          KY.push({ at: at, v: clampRange(c.y + j.dy, -0.86, 0.86) });
          KS.push({ at: at, v: clampRange(pulse + j.ds, 0.62, 1.15) });
        }

        // Tail: settle near the footer, slightly lower + centered.
        KX.push({ at: 1.0, v: -0.10 });
        KY.push({ at: 1.0, v: -0.70 });
        KS.push({ at: 1.0, v: 0.80 });
      }

      function clamp01(v) { return Math.max(0, Math.min(1, v)); }

      /* ── Keyframe sampler with smooth ease-in-out ──────────────── */
      function eio(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
      function sample(ks, t) {
        if (!ks.length) return 0;
        if (t <= ks[0].at) return ks[0].v;
        if (t >= ks[ks.length - 1].at) return ks[ks.length - 1].v;
        for (var i = 0; i < ks.length - 1; i++) {
          var a = ks[i], b = ks[i + 1];
          if (t >= a.at && t <= b.at) {
            var l = (b.at - a.at) > 0 ? (t - a.at) / (b.at - a.at) : 0;
            return a.v + (b.v - a.v) * eio(l);
          }
        }
        return ks[ks.length - 1].v;
      }

      /* ════════════════════════════════════════════════════════
         REAL DRONE FLIGHT PHYSICS
         ════════════════════════════════════════════════════════
         droneGroup → world XY position + YAW (heading) + ROLL (bank)
         drone (GLB child) → PITCH (nose up/down) + scale

         Heading/bank are *derived each frame* from the instantaneous
         direction of travel (finite-difference of the smoothed
         position), so the drone always banks correctly into turns
         regardless of how the corner pattern is edited — this is
         what makes it read as "precise, real flight" rather than a
         canned animation. */
      var droneGroup = new THREE.Group();
      scene.add(droneGroup);

      var drone = null, mixer = null;
      var clock = new THREE.Clock();

      var BASE_SCALE = 0.026; // tuned below once real bbox is known, see load callback

      var L = { x: 0, y: halfH() * 1.15, sc: BASE_SCALE, yaw: 0, pitch: 0, roll: 0 };
      var prevWorld = { x: 0, y: halfH() * 1.15 };
      var SMOOTH_POS = 0.05;
      var SMOOTH_ROT = 0.085;
      var SMOOTH_SC = 0.06;
      // Yaw turns slightly slower than roll/pitch react — a real drone's
      // body takes a moment to swing its heading even though it banks
      // into the turn almost immediately, so this reads as inertia
      // rather than a mechanical snap. SMOOTH_TURN is slower still,
      // used only for the deliberate "turn to face the camera" pose so
      // yaw/pitch/roll arrive together instead of pitch/roll snapping
      // level before the yaw has finished turning.
      var SMOOTH_YAW = 0.055;
      var SMOOTH_TURN = 0.035;

      // ── Idle-detection state (for the "look at camera" behaviour) ──
      // idleTime accumulates real seconds while the drone has been
      // effectively stationary (no meaningful scroll-driven motion).
      // Any real motion resets it immediately.
      var idleTime = 0;
      var lastScrollT = -1; // sentinel so the very first frame counts as "moved"
      var IDLE_LOOK_DELAY = 5.0; // seconds of no scrolling before it turns to face us
      var FACE_CAMERA_YAW = Math.PI / 2; // calibrated below — see heading notes

      // ── Heading calibration ──────────────────────────────────────
      // yaw = 0 was confirmed to already face LEFT (-X) correctly, and a
      // full 180° (π rad) turn faces RIGHT (+X) — a straight small-angle
      // "bank" formula can only ever cover a fraction of that, which is
      // why rightward travel previously looked tail-first. VX_TURN_SCALE
      // controls how quickly horizontal speed saturates the turn toward
      // a full 0→π sweep; lower = snappier full turns at lower speeds.
      var VX_TURN_SCALE = 0.02;

      // Randomised wander phases — generated once per load so the
      // organic weave (independent of scroll) never repeats the same
      // pattern twice, at effectively zero per-frame cost (a few sines).
      var WPH = {
        x1: rand(0, Math.PI * 2), x2: rand(0, Math.PI * 2),
        y1: rand(0, Math.PI * 2), y2: rand(0, Math.PI * 2)
      };

      var scrollT = 0;
      var visible = false;

      function updateScrollProgress() {
        var h = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
        scrollT = clamp01(window.scrollY / h);

        var focusEl = document.getElementById('focus');
        var heroEl = document.getElementById('hero');
        var shouldShow = true;
        if (heroEl) {
          var heroRect = heroEl.getBoundingClientRect();
          // still inside hero (haven't scrolled past it yet) → hide
          shouldShow = heroRect.bottom <= window.innerHeight * 0.65;
        }
        if (shouldShow !== visible) {
          visible = shouldShow;
          CANVAS.classList.toggle('drone-visible', visible);
        }
      }

      /* Plug into the page's existing shared scroll bus if present
         (script.js exposes window.__nytherionOnScroll as a tiny shim
         below); otherwise fall back to our own passive listener. */
      if (typeof window.__nytherionOnScroll === 'function') {
        window.__nytherionOnScroll(updateScrollProgress);
      } else {
        window.addEventListener('scroll', updateScrollProgress, { passive: true });
      }
      window.addEventListener('resize', function () {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        buildPath();
        updateScrollProgress();
      });

      /* ── Load GLB ──────────────────────────────────────────────── */
      new THREE.GLTFLoader().load(
        'CombatDrone.glb',
        function (gltf) {
          drone = gltf.scene;

          // GLB has no embedded lights/cameras (verified offline) and a
          // single material with zero emissive — no blowout risk, but we
          // still defensively strip any stray lights for robustness.
          drone.traverse(function (obj) {
            if (obj.isLight) { obj.intensity = 0; obj.visible = false; }
            if (obj.isMesh && obj.material) {
              var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
              mats.forEach(function (m) {
                if (!m) return;
                // Push metalness up and roughness down so the drone
                // catches directional highlights like polished metal
                if (m.metalness !== undefined) m.metalness = Math.max(m.metalness, 0.82);
                if (m.roughness !== undefined) m.roughness = Math.min(m.roughness, 0.28);
                m.envMapIntensity = 2.8;
                m.needsUpdate = true;
              });
            }
          });

          // Measure the EFFECTIVE bounding box after Three.js has already
          // applied the GLB's baked node matrices (90° axis conversion +
          // 0.0254 unit-scale), so our BASE_SCALE is correct regardless of
          // how the source FBX→GLB export was authored.
          var box = new THREE.Box3().setFromObject(drone);
          var size = new THREE.Vector3(); box.getSize(size);
          var center = new THREE.Vector3(); box.getCenter(center);
          var maxDim = Math.max(size.x, size.y, size.z) || 1;

          // Target: drone's longest dimension ≈ 32% of viewport height —
          // prominent like the clown fish, but small enough to weave
          // between corners without overwhelming the section content.
          var targetWorldSize = halfH() * 2 * 0.60;
          BASE_SCALE = targetWorldSize / maxDim;

          drone.scale.setScalar(BASE_SCALE);
          // Re-centre on its own pivot so position keyframes target the
          // visual centre of the model, not an off-centre mesh origin.
          drone.position.set(
            -center.x * BASE_SCALE,
            -center.y * BASE_SCALE,
            -center.z * BASE_SCALE
          );

          droneGroup.add(drone);
          droneGroup.position.set(0, halfH() * 1.15, 0);

          if (gltf.animations && gltf.animations.length) {
            mixer = new THREE.AnimationMixer(drone);
            gltf.animations.forEach(function (clip) {
              mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
            });
          }

          buildPath();
          updateScrollProgress();
          console.log('[drone] CombatDrone loaded — scale=' + BASE_SCALE.toFixed(4));
        },
        undefined,
        function (err) {
          console.warn('[drone] failed to load CombatDrone.glb — companion disabled', err);
        }
      );

      /* ── Render loop ───────────────────────────────────────────── */
      function tick() {
        requestAnimationFrame(tick);
        var dt = clock.getDelta();
        var el = clock.getElapsedTime();
        if (mixer) mixer.update(dt);
        if (!drone) { renderer.render(scene, camera); return; }

        var t = scrollT;
        var hh = halfH(), hw = halfW();

        // Sample time is warped by the scheduled backtrack pulses: for a
        // brief window the effective position along the path moves
        // *earlier* even though the user keeps scrolling forward, so the
        // drone genuinely reverses along its own route for a moment —
        // a handful of times across the whole page, never more. Floored
        // to the first REAL waypoint so a dip can never overshoot into
        // the off-screen "parked before #focus" segment.
        var floorT = KX.length > 1 ? KX[1].at : 0;
        var tEff = clamp01(t - backtrackWarp(t));
        if (tEff < floorT) tEff = floorT;

        var tx = hw * sample(KX, tEff);
        var ty = hh * sample(KY, tEff);
        var tsc = BASE_SCALE * sample(KS, t);

        // Continuous organic wander — low-amplitude, non-repeating drift
        // layered on top of the section-to-section path so the route
        // never reads as a rigid straight line between waypoints. Cheap:
        // a handful of sines, no extra geometry or draw calls.
        var wx = (Math.sin(el * 0.53 + WPH.x1) * 0.032 + Math.sin(el * 0.21 + WPH.x2) * 0.016) * hw;
        var wy = (Math.cos(el * 0.47 + WPH.y1) * 0.026 + Math.sin(el * 0.19 + WPH.y2) * 0.014) * hh;
        tx += wx; ty += wy;

        // Track previous SMOOTHED position (not raw target) so velocity
        // reflects actual on-screen motion — this is what drives correct,
        // non-jittery banking even when scroll is choppy (trackpad/wheel),
        // and correctly flips during a backtrack dip.
        var beforeX = L.x, beforeY = L.y;

        L.x += (tx - L.x) * SMOOTH_POS;
        L.y += (ty - L.y) * SMOOTH_POS;
        L.sc += (tsc - L.sc) * SMOOTH_SC;

        var vx = L.x - beforeX;
        var vy = L.y - beforeY;
        var speed = Math.sqrt(vx * vx + vy * vy);

        // ── Idle tracking ──────────────────────────────────────────
        // Keyed off the actual SCROLL POSITION, not on-screen speed —
        // the continuous organic wander keeps the drone drifting a
        // little even while the user isn't scrolling, so speed alone
        // would never reach zero. This checks "has the user actually
        // scrolled" and accumulates real wall-clock seconds otherwise.
        if (Math.abs(scrollT - lastScrollT) > 0.0002) {
          idleTime = 0;
          lastScrollT = scrollT;
        } else {
          idleTime += dt;
        }
        var lookingAtCamera = idleTime >= IDLE_LOOK_DELAY;

        // ── Derive heading (yaw) ─────────────────────────────────────
        // Horizontal travel maps across the FULL 0→π sweep (not a small
        // clamped bank) since the model's neutral pose already faces
        // left (yaw≈0) and needs a genuine half-turn to face right
        // (yaw≈π) — a small-angle clamp can never reach that, which is
        // what caused rightward travel to read as flying backwards.
        // A softsign of vx gives a smooth, saturating -1..1 value that
        // maps directly onto that 0..π sweep, and naturally handles the
        // reversed direction during a backtrack dip the same way.
        //
        // Gated on |vx| specifically (not overall speed) — pure vertical
        // travel (vx≈0, vy≠0) now holds the current heading instead of
        // swinging the nose toward the camera, which is what a real
        // drone climbing/diving in place would do.
        var vxAbs = Math.abs(vx);
        if (lookingAtCamera) {
          // Stayed still for a while — turn to look directly at the viewer.
          L.yaw += (FACE_CAMERA_YAW - L.yaw) * SMOOTH_TURN;
        } else if (vxAbs > 0.00035) {
          var n = vx / (vxAbs + VX_TURN_SCALE); // softsign, -1..1
          var targetYaw = (n + 1) * (Math.PI / 2); // -1→0 (left), +1→π (right)
          L.yaw += (targetYaw - L.yaw) * SMOOTH_YAW;
        }
        // else: no meaningful horizontal motion — hold the current
        // heading rather than snapping anywhere.

        // ── Derive pitch from vertical velocity (nose up when climbing,
        //    nose down when descending — also nose-up when braking into
        //    a backtrack, matching how a real drone decelerates) ──
        var targetPitch = lookingAtCamera ? 0 : Math.max(-0.5, Math.min(0.5, -vy * 9.0));
        L.pitch += (targetPitch - L.pitch) * (lookingAtCamera ? SMOOTH_TURN : SMOOTH_ROT);

        // ── Derive roll/bank from horizontal velocity — banks INTO the
        //    turn like a real quad/fixed-wing platform, including the
        //    hard bank-and-turn look when it reverses direction ──
        var targetRoll = lookingAtCamera ? 0 : Math.max(-0.68, Math.min(0.68, -vx * 13.5));
        L.roll += (targetRoll - L.roll) * (lookingAtCamera ? SMOOTH_TURN : SMOOTH_ROT);

        // ── Idle hover micro-jitter — always alive, even mid-scroll-pause ──
        var hx = Math.cos(el * 1.7) * 0.006 + Math.sin(el * 3.0) * 0.0025;
        var hy = Math.sin(el * 1.4) * 0.009 + Math.cos(el * 2.4) * 0.004;
        var hr = Math.sin(el * 2.0) * 0.012;

        droneGroup.position.set(L.x + hx, L.y + hy, 0);
        droneGroup.rotation.order = 'YZX';
        droneGroup.rotation.y = L.yaw;
        droneGroup.rotation.z = L.roll + hr;
        droneGroup.rotation.x = 0;

        drone.rotation.x = L.pitch;
        drone.scale.setScalar(L.sc);

        // Engine glow follows + pulses with speed
        glowA.position.set(L.x, L.y - 0.05, 0.3);
        glowB.position.set(L.x + 0.04, L.y + 0.03, 0.2);
        glowA.intensity = 5.0 + Math.sin(el * 3.4) * 2.0 + speed * 50;
        glowB.intensity = 4.0 + Math.cos(el * 2.7) * 1.6 + speed * 35;

        renderer.render(scene, camera);
      }
      tick();

    } catch (e) {
      console.error('[drone] companion failed to initialise, page unaffected:', e);
    }
  }

})();
