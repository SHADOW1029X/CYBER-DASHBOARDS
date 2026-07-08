// ══════════════════════════════════════════════════
// CUSTOM CURSOR — ANIMATED ENERGY MODEL
// Desktop only: replaces the native cursor with the animated glTF model,
// rendered small and tracking the real cursor position. Adapted from the
// reference Energy VFX Viewer (Pointer.html) — same lighting setup and
// the same per-material glow treatment (emissive boost, additive
// blending, depthWrite off, color multiply) — but reworked from "auto-
// frame a model filling the whole viewport" into "render it small and
// glue it to the mouse", plus a pass of accuracy/efficiency/reliability
// hardening on top of the first working version:
//
//   ACCURACY   — orthographic camera instead of perspective. A
//                perspective camera visibly stretches/skews an object
//                as it moves away from screen center (the same reason
//                wide-angle photos distort at the edges), which would
//                have made the cursor warp slightly as it moved toward
//                the corners of the screen. Orthographic has no such
//                distortion regardless of position, and turns "map
//                mouse position to world position" into an exact 1
//                world-unit = 1 CSS-pixel relationship — no per-frame
//                trigonometry needed at all.
//
//   EFFICIENCY — renders into a small fixed-size canvas (~100px) instead
//                of the full viewport — the model only ever occupies a
//                tiny area of the screen, so an earlier version of this
//                rendering the full browser window every frame to
//                display something the size of an icon was pure waste.
//                The small canvas is repositioned to follow the mouse
//                via a CSS transform (a compositor-level operation, not
//                a re-render) instead of moving the model through world
//                space — this also means window resizes no longer need
//                to resize/reallocate the renderer or recompute camera
//                distance at all, since the render target's pixel size
//                never changes. The render loop also fully pauses via
//                the Page Visibility API when the tab isn't active.
//                Glow is done with a CSS drop-shadow filter on the
//                canvas rather than a WebGL bloom post-processing pass
//                (see the ACCURACY note by the canvas's filter style for
//                why) — as a side effect this is also lighter-weight
//                than running a multi-pass blur shader every frame.
//
//   RELIABILITY — WebGL context-loss is now handled explicitly (GPU
//                driver resets, browser tab discarding, etc. can lose
//                a context at any time); the animation mixer's delta
//                time is clamped so returning to a backgrounded tab
//                doesn't cause the model to jump through a huge chunk
//                of its animation at once; a per-frame try/catch with
//                a circuit breaker stops the loop after repeated errors
//                instead of spamming the console forever; and every
//                failure path now actually tears down its listeners
//                and cancels the render loop instead of continuing to
//                run for a feature that already gave up.
//
//   UX          — hovering a link/button/etc. now scales the cursor up
//                slightly, restoring the "this is clickable" affordance
//                that a hidden native cursor would otherwise lose;
//                pressing the mouse gives a quick tactile scale-down/up
//                pulse.
//
// This remains the one place on the site that pulls in Three.js from a
// CDN — everywhere else (Warrior 3D, Aether Drive) is hand-rolled WebGL
// specifically to avoid that, but reproducing a textured, animated glTF
// with PBR materials by hand is a different scope of effort than a
// cursor warrants.
//
// Every failure path here (no WebGL, blocked CDN, model load timeout,
// repeated render errors, lost context that never recovers) falls back
// to simply not running / cleanly tearing down — the native cursor is
// only ever hidden (html.custom-cursor-active, see design.css) after
// the model has actually loaded and a frame has rendered, and is
// restored immediately if anything goes wrong afterward, so nothing
// here can leave a visitor without a visible cursor.
// ══════════════════════════════════════════════════
try {
  // Touch/coarse-pointer devices have no persistent cursor to replace.
  // Deliberately NOT gating on the site's shared .low-power class here
  // — that heuristic (hardwareConcurrency <= 4) was tuned for the
  // heavier background effects elsewhere on the site and trips on a
  // lot of perfectly ordinary desktops/laptops. A small ~100px render
  // target is a much lighter load than those other effects anyway.
  const isDesktop = window.matchMedia('(pointer: fine) and (hover: hover)').matches;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!isDesktop) {
    console.log('[NYTHERION] custom cursor: skipped (no fine pointer/hover — touch device)');
  } else if (reduceMotion) {
    console.log('[NYTHERION] custom cursor: skipped (prefers-reduced-motion)');
  } else {
    console.log('[NYTHERION] custom cursor: starting setup…');
    setupCustomCursor(); // guards itself against being called more than once
  }
} catch (e) {
  console.error('[NYTHERION] pointer.js setup failed:', e);
}

async function setupCustomCursor() {
  if (document.getElementById('cursorCanvas')) {
    console.warn('[NYTHERION] custom cursor: setupCustomCursor() called again while already running — ignoring');
    return;
  }

  let THREE, GLTFLoader;
  try {
    [THREE, { GLTFLoader }] = await Promise.all([
      import('three'),
      import('three/addons/loaders/GLTFLoader.js'),
    ]);
  } catch (e) {
    // CDN blocked/offline — no custom cursor, native cursor untouched.
    console.error('[NYTHERION] custom cursor: three.js failed to load — check for an ad-blocker/extension or firewall blocking unpkg.com', e);
    return;
  }
  console.log('[NYTHERION] custom cursor: three.js loaded, fetching model…');

  // Target size of the model itself, and the render target it sits in
  // (larger than the model to leave room for the bloom glow to bleed
  // outward without getting clipped at the canvas edge).
  const CURSOR_PX = 34;
  const CANVAS_PX = 100;
  const HALF = CANVAS_PX / 2;
  const HOVER_SCALE = 1.18;  // over a clickable element
  const PRESS_SCALE = 0.82;  // brief press feedback
  const MODEL_LOAD_TIMEOUT_MS = 20000;

  const canvas = document.createElement('canvas');
  canvas.id = 'cursorCanvas';
  canvas.style.cssText = [
    'position:fixed', 'top:0', 'left:0',
    `width:${CANVAS_PX}px`, `height:${CANVAS_PX}px`,
    'pointer-events:none', 'z-index:99999',
    'opacity:0',
    'transition:opacity .2s ease',
    'will-change:transform',
    // Glow via CSS instead of a WebGL bloom pass: UnrealBloomPass's
    // multi-stage composite (bright-pass extract -> several blur
    // passes -> final blend) does not reliably preserve the canvas's
    // alpha channel through that pipeline, which is what was showing
    // up as a solid opaque box instead of a transparent glow. A
    // drop-shadow filter reads the canvas's actual rendered alpha
    // silhouette directly, so it can't have that problem, and several
    // stacked at increasing blur/decreasing opacity gives a soft
    // falloff similar to what the bloom pass was going for.
    'filter:drop-shadow(0 0 5px rgba(255,170,90,.95)) drop-shadow(0 0 14px rgba(255,110,40,.7)) drop-shadow(0 0 28px rgba(255,80,20,.4))',
  ].join(';');
  document.body.appendChild(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    console.error('[NYTHERION] custom cursor: WebGL unavailable', e);
    canvas.remove();
    return;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(CANVAS_PX, CANVAS_PX, false); // false: canvas CSS size is set above, don't override it
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.4;
  // alpha:true on the renderer only makes the canvas *capable* of
  // transparency — it still clears to opaque black every frame unless
  // told otherwise.
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();

  // Orthographic, spanning exactly CANVAS_PX world units — 1 world unit
  // is exactly 1 CSS pixel within this canvas, with zero perspective
  // distortion regardless of where the model sits.
  const camera = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, 0.01, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  // Brighter than the reference viewer's rig — at cursor size the model
  // reads as much smaller/dimmer on screen than it does filling an
  // entire viewport, so it needs more light to still read clearly at a
  // glance (the CSS drop-shadow above handles the glow/bloom look now).
  scene.add(new THREE.AmbientLight(0xffffff, 2.2));
  const key = new THREE.PointLight(0xffaa55, 16); key.position.set(3, 3, 4); scene.add(key);
  const fill = new THREE.PointLight(0xff3300, 12); fill.position.set(-3, -1, -2); scene.add(fill);
  const rim = new THREE.PointLight(0xffffff, 6); rim.position.set(0, 5, -5); scene.add(rim);

  let model = null;
  let mixer = null;
  let ready = false;
  let running = true;
  let rafId = null;
  let errorStreak = 0;
  const MAX_ERROR_STREAK = 8; // stop the loop rather than spam the console forever

  function teardown(reason) {
    if (!running) return;
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    document.documentElement.classList.remove('custom-cursor-active');
    canvas.remove();
    try { renderer.dispose(); } catch (_) {}
    console.warn('[NYTHERION] custom cursor: stopped —', reason);
  }

  // WebGL contexts can be lost at any time (driver reset, GPU switch,
  // browser reclaiming memory) — without handling this, the render loop
  // would start throwing on every frame. If it comes back, we simply
  // let the next few frames resume naturally; if it doesn't within a
  // few seconds, tear down cleanly rather than leave a dead canvas.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('[NYTHERION] custom cursor: WebGL context lost, waiting to see if it recovers…');
    canvas.style.opacity = '0';
    setTimeout(() => {
      if (canvas.isConnected && renderer.getContext() && renderer.getContext().isContextLost()) {
        teardown('context lost and did not recover');
      }
    }, 4000);
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    console.log('[NYTHERION] custom cursor: WebGL context restored');
    if (ready) canvas.style.opacity = '1';
  }, false);

  const loader = new GLTFLoader();
  let loadTimedOut = false;
  const loadTimer = setTimeout(() => {
    loadTimedOut = true;
    console.error('[NYTHERION] custom cursor: model load timed out after', MODEL_LOAD_TIMEOUT_MS, 'ms — giving up');
    teardown('model load timeout');
  }, MODEL_LOAD_TIMEOUT_MS);

  loader.load(
    './af93a7ad086d47e39cfce7796e78df43_Textured.gltf',
    (gltf) => {
      clearTimeout(loadTimer);
      if (loadTimedOut || !running) return; // gave up already, ignore a late response

      model = gltf.scene;

      // Same material pass as the reference: boost emissive, switch to
      // additive+no-depth-write so overlapping glow blooms instead of
      // occluding, and push the base color brighter so it has something
      // for the bloom pass to actually pick up.
      model.traverse((obj) => {
        if (!obj.isMesh) return;
        const m = obj.material;
        if (m.emissive) m.emissiveIntensity = 9;
        m.transparent = true;
        m.blending = THREE.AdditiveBlending;
        m.depthWrite = false;
        if (m.color) m.color.multiplyScalar(3.2);
        m.needsUpdate = true;
      });

      if (gltf.animations.length) {
        mixer = new THREE.AnimationMixer(model);
        gltf.animations.forEach((a) => mixer.clipAction(a).play());
      }

      // Center the model on its own origin, then scale it to exactly
      // CURSOR_PX world units (= CSS pixels) tall regardless of its
      // native export scale.
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      model.position.sub(center);

      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      model.userData.baseScale = CURSOR_PX / maxDim;
      model.scale.setScalar(model.userData.baseScale);

      scene.add(model);
      ready = true;

      // Only now — model loaded, first frame about to render — do we
      // actually take over the cursor.
      document.documentElement.classList.add('custom-cursor-active');
      canvas.style.opacity = '1';
      console.log('[NYTHERION] custom cursor: active');
    },
    undefined,
    (err) => {
      clearTimeout(loadTimer);
      console.error('[NYTHERION] custom cursor: model failed to load — check that af93a7ad086d47e39cfce7796e78df43_Textured.gltf was uploaded in the same folder as UI.html', err);
      teardown('model failed to load');
    }
  );

  // Raw + smoothed mouse position, in CSS pixels. The smoothing gives
  // the model a slight trailing follow rather than snapping frame to
  // frame, which reads as intentional "energy" motion rather than lag.
  const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const smoothed = { x: mouse.x, y: mouse.y };
  let hasMoved = false;

  window.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (!hasMoved) { smoothed.x = mouse.x; smoothed.y = mouse.y; hasMoved = true; }
  }, { passive: true });

  // Hide while the real cursor is off-window (e.g. over the browser
  // chrome) rather than leaving it stranded at the last known position.
  document.addEventListener('mouseleave', () => { canvas.style.opacity = '0'; });
  document.addEventListener('mouseenter', () => { if (ready) canvas.style.opacity = '1'; });

  // UX: hovering a clickable element scales the cursor up a bit —
  // restoring the "this is interactive" affordance a hidden native
  // cursor would otherwise lose entirely. Anything can opt back into
  // the plain native cursor (e.g. a future text field) by marking
  // itself with [data-native-cursor].
  const HOVER_SELECTOR = 'a, button, input, textarea, select, [role="button"], [onclick], .grid-item, label, summary';
  let targetScale = 1;
  document.addEventListener('pointerover', (e) => {
    if (!ready) return;
    const el = e.target;
    if (el.closest && el.closest('[data-native-cursor]')) {
      canvas.style.opacity = '0';
      return;
    }
    canvas.style.opacity = '1';
    targetScale = (el.closest && el.closest(HOVER_SELECTOR)) ? HOVER_SCALE : 1;
  });

  // UX: a quick tactile press/release pulse.
  window.addEventListener('pointerdown', () => { if (ready) targetScale *= PRESS_SCALE; }, { passive: true });
  window.addEventListener('pointerup', () => {
    if (!ready) return;
    // Recompute from scratch rather than dividing back out, in case the
    // element under the cursor changed mid-press.
    const el = document.elementFromPoint(mouse.x, mouse.y);
    const overNative = el && el.closest && el.closest('[data-native-cursor]');
    targetScale = (!overNative && el && el.closest && el.closest(HOVER_SELECTOR)) ? HOVER_SCALE : 1;
  }, { passive: true });

  const clock = new THREE.Clock();
  let currentScale = 1;

  // Pause entirely while the tab isn't visible — no point spending GPU/
  // battery animating a cursor nobody can see, and it sidesteps the
  // browser potentially throttling rAF in ways that cause a huge delta
  // jump on the mixer when the tab returns.
  document.addEventListener('visibilitychange', () => {
    if (!ready) return;
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    } else if (running && !rafId) {
      clock.getDelta(); // discard the time spent hidden
      rafId = requestAnimationFrame(animate);
    }
  });

  function animate() {
    if (!running) return;
    rafId = requestAnimationFrame(animate);
    if (document.hidden) return;

    try {
      // Clamp delta so a throttled/backgrounded frame can't make the
      // clip mixer jump through a large chunk of animation at once.
      const dt = Math.min(clock.getDelta(), 1 / 30);
      if (mixer) mixer.update(dt);

      smoothed.x += (mouse.x - smoothed.x) * 0.65;
      smoothed.y += (mouse.y - smoothed.y) * 0.65;
      canvas.style.transform = `translate3d(${(smoothed.x - HALF).toFixed(1)}px, ${(smoothed.y - HALF).toFixed(1)}px, 0)`;

      if (model) {
        currentScale += (targetScale - currentScale) * 0.2;
        model.scale.setScalar(model.userData.baseScale * currentScale);
      }

      renderer.render(scene, camera);
      errorStreak = 0;
    } catch (e) {
      errorStreak++;
      console.error('[NYTHERION] custom cursor: render error', e);
      if (errorStreak >= MAX_ERROR_STREAK) teardown('too many consecutive render errors');
    }
  }
  rafId = requestAnimationFrame(animate);

  // The render target's pixel size never changes (it's a small fixed
  // canvas, not full-viewport), so a resize no longer needs to touch
  // the renderer or camera at all — only the mouse-tracking math above
  // (which already reads window.innerWidth/innerHeight live on every
  // frame) needs nothing further done here.
}
