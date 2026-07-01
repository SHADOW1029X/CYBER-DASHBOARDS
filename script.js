// Production safety net: this page runs ~10 independent systems (preloader,
// scroll bus, pipeline/engine/warrior scrubs, WebGL tab shaders, etc.) each
// in its own try/guarded IIFE, but an unexpected error on some browser/
// device combination could still slip through uncaught. Surfacing it to
// the console with context beats a silent, untraceable failure.
window.addEventListener('error', e => {
  console.error('[NYTHERION] Uncaught error:', e.message, 'at', e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', e => {
  console.error('[NYTHERION] Unhandled promise rejection:', e.reason);
});

(() => {
  // ── SHARED HELPERS ──
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ── SHARED SCROLL BUS ──
  // Several independent systems below (progress bar, pipeline scrub, engine
  // scrub) need to react to scroll position. Rather than each attaching its
  // own 'scroll' listener (each scheduling its own requestAnimationFrame and
  // re-triggering style recalcs independently), they subscribe here once —
  // one listener, one rAF per frame, fanned out to every subscriber. Same
  // visual result, far fewer redundant wakeups under fast scroll.
  const scrollSubscribers = [];
  function onScroll(fn) { scrollSubscribers.push(fn); }
  let scrollRafPending = false;
  function scheduleScrollUpdate() {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      for (let i = 0; i < scrollSubscribers.length; i++) scrollSubscribers[i]();
    });
  }
  window.addEventListener('scroll', scheduleScrollUpdate, { passive: true });
  window.addEventListener('resize', scheduleScrollUpdate, { passive: true });

  // Exposed so independently-loaded modules (e.g. drone.js) can subscribe
  // to the same single rAF-batched scroll bus instead of adding their own
  // 'scroll' listener — keeps the "one listener, fanned out" guarantee
  // intact even for add-on systems loaded after this IIFE runs.
  window.__nytherionOnScroll = onScroll;

  // ── SHARED RESIZE BUS ──
  // Same idea, scoped to resize only (kept separate from the scroll bus
  // above rather than folded in, since several subscribers here — mask
  // radius, focus-frame placement — don't depend on scroll position at
  // all, and merging them would mean redundantly recomputing on every
  // scroll frame for no reason). Raw 'resize' events fire far more often
  // than the name suggests — a mobile browser's address bar sliding away
  // during scroll, or dragging a desktop window edge, can fire dozens in
  // a row — so several independent systems doing layout-forcing reads
  // (getBoundingClientRect) or expensive work (WebGL framebuffer resize)
  // directly in a raw resize handler is a real source of jank. Batching
  // to one rAF-scheduled pass fixes that the same way the scroll bus does.
  const resizeSubscribers = [];
  function onResize(fn) { resizeSubscribers.push(fn); }
  let resizeRafPending = false;
  function scheduleResizeUpdate() {
    if (resizeRafPending) return;
    resizeRafPending = true;
    requestAnimationFrame(() => {
      resizeRafPending = false;
      for (let i = 0; i < resizeSubscribers.length; i++) resizeSubscribers[i]();
    });
  }
  window.addEventListener('resize', scheduleResizeUpdate, { passive: true });
  window.__nytherionOnResize = onResize;

  // ── SCROLL PROGRESS ──
  const prog = document.getElementById('prog');
  onScroll(() => {
    const docH = document.documentElement.scrollHeight - innerHeight;
    prog.style.width = (Math.min(window.scrollY / Math.max(docH, 1), 1) * 100) + '%';
  });

  // ── PLACEHOLDER LINKS ──
  // href="#" placeholder links (footer: Documentation/API Reference/
  // Changelog) would otherwise trigger the global smooth-scroll-to-top
  // behavior on click — jarring on a page this tall. Real same-page
  // anchors (href="#hero" etc.) use a non-empty fragment and are
  // unaffected by this selector.
  document.querySelectorAll('a[href="#"]').forEach(a => {
    a.addEventListener('click', e => e.preventDefault());
  });

  // ── MOBILE MENU ──
  const ham = document.getElementById('hamburger');
  const mob = document.getElementById('mobile-menu');

  function openMobileMenu() {
    ham.classList.add('open');
    mob.classList.add('open');
    ham.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeMobileMenu({ returnFocus = false } = {}) {
    ham.classList.remove('open');
    mob.classList.remove('open');
    ham.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (returnFocus) ham.focus();
  }

  ham.addEventListener('click', () => {
    if (mob.classList.contains('open')) closeMobileMenu();
    else openMobileMenu();
  });
  mob.querySelectorAll('a').forEach(a => a.addEventListener('click', () => closeMobileMenu()));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && mob.classList.contains('open')) closeMobileMenu({ returnFocus: true });
  });

  // ── PAGE TABS (ARIA tabs pattern: click + arrow-key navigation) ──
  try { (function setupPageTabs() {
    const tabs = Array.from(document.querySelectorAll('.page-tab'));
    if (!tabs.length) return;

    function activate(tab, { focus = false } = {}) {
      tabs.forEach(b => {
        const isActive = b === tab;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        b.tabIndex = isActive ? 0 : -1;
        const panel = document.getElementById('tab-' + b.dataset.tab);
        if (panel) {
          panel.classList.toggle('active', isActive);
          if (isActive) panel.removeAttribute('hidden');
          else panel.setAttribute('hidden', '');
        }
      });
      if (focus) tab.focus();
    }

    tabs.forEach((btn, i) => {
      btn.addEventListener('click', () => activate(btn));
      btn.addEventListener('keydown', e => {
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); activate(next, { focus: true }); }
      });
    });
  })(); } catch (e) { console.error('[NYTHERION] setupPageTabs failed:', e); }

  // ── SCROLL REVEAL ──
  const revealEls = document.querySelectorAll('.reveal, .sr');
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        e.target.classList.add('visible');
        io.unobserve(e.target);
      }
    });
  }, {threshold: 0.12});
  revealEls.forEach(el => io.observe(el));

  // ── HERO HUD ──
  const heroEl = document.getElementById('hero');
  setTimeout(() => { if (heroEl) heroEl.classList.add('huddle'); }, 800);

  // ── MARQUEE ──
  const track = document.querySelector('.marq .track');
  if (track) {
    track.innerHTML += track.innerHTML;
  }

  // ── SPOTLIGHT / OVERLAY IMAGE ──
  // Implemented as a CSS radial-gradient mask whose center is driven by
  // --sx/--sy custom properties. This avoids re-encoding a canvas to a
  // PNG data-URL every frame (extremely expensive) — the browser's
  // compositor handles the gradient mask on the GPU instead.
  const revealDiv = document.getElementById('revealLayerContainer');
  const touchHint = document.getElementById('touchHint');

  // Detect touch device
  const isCoarse = window.matchMedia('(pointer:coarse)').matches;

  // Radius: larger on touch for better finger coverage
  let RADIUS = isCoarse ? 210 : 290;

  // Multi-stop falloff (ported from the original canvas gradient stops),
  // expressed as CSS mask-image stop list, scaled to the explicit circle
  // radius below so the soft edge shape matches the original exactly.
  function maskGradient() {
    const stops = isCoarse
      ? [[0, 1], [0.5, 1], [0.72, 0.7], [0.88, 0.25], [1, 0]]
      : [[0, 1], [0.35, 1], [0.6, 0.75], [0.8, 0.3], [1, 0]];
    const stopList = stops.map(([pos, alpha]) => `rgba(255,255,255,${alpha}) ${(pos * RADIUS).toFixed(1)}px`).join(', ');
    return `radial-gradient(circle ${RADIUS}px at var(--sx) var(--sy), ${stopList})`;
  }

  let winW = window.innerWidth, winH = window.innerHeight;
  let rawX = -999, rawY = -999;
  let smX  = -999, smY  = -999;
  let active  = false;
  let heroVisible = true; // tracked by IO below

  function applyMaskGradient() {
    const grad = maskGradient();
    revealDiv.style.maskImage = grad;
    revealDiv.style.webkitMaskImage = grad;
  }

  // Pause mask work when hero is off-screen
  const heroIO = new IntersectionObserver(entries => {
    heroVisible = entries[0].isIntersecting;
    if (!heroVisible) clearMask();
  }, {threshold: 0});
  heroIO.observe(heroEl);

  function resizeSL() {
    winW = window.innerWidth;
    winH = window.innerHeight;
    RADIUS = window.matchMedia('(pointer:coarse)').matches ? 210 : 290;
    applyMaskGradient();
  }
  onResize(resizeSL);
  resizeSL();

  function clearMask() {
    revealDiv.style.opacity = '0';
  }

  function applyMask(cx, cy) {
    if (!active || rawX === -999 || !heroVisible) { clearMask(); return; }

    const sx = Math.max(0, Math.min(cx, winW));
    const sy = Math.max(0, Math.min(cy, winH));

    revealDiv.style.setProperty('--sx', `${sx}px`);
    revealDiv.style.setProperty('--sy', `${sy}px`);
    revealDiv.style.opacity = '1';
  }

  // ── MOUSE (desktop) — spotlight active while cursor is over hero ──
  window.addEventListener('mousemove', e => {
    const heroRect = heroEl.getBoundingClientRect();
    if (
      e.clientY >= heroRect.top && e.clientY <= heroRect.bottom &&
      e.clientX >= heroRect.left && e.clientX <= heroRect.right
    ) {
      active = true;
      rawX = e.clientX;
      rawY = e.clientY;
    } else {
      active = false;
      rawX = -999; rawY = -999;
    }
  }, {passive: true});

  window.addEventListener('mouseleave', () => {
    active = false;
    rawX = -999; rawY = -999;
    clearMask();
  });

  // Fallback for browsers where 'mouseleave' doesn't fire reliably on window:
  // 'mouseout' with no relatedTarget means the pointer left the document entirely.
  document.addEventListener('mouseout', e => {
    if (!e.relatedTarget) {
      active = false;
      rawX = -999; rawY = -999;
      clearMask();
    }
  });

  // ── TOUCH (mobile / tablet) ──
  // On touch devices the hidden image is ONLY revealed while the user is
  // actively touching the hero — no idle reveal, no mouse fallback.
  let touchEndTimer = null;

  heroEl.addEventListener('touchstart', e => {
    clearTimeout(touchEndTimer);
    active = true;
    const t = e.touches[0];
    rawX = t.clientX; rawY = t.clientY;
    smX  = t.clientX; smY  = t.clientY; // snap on first contact — no lag
    if (touchHint) { touchHint.style.opacity = '0'; touchHint.style.visibility = 'hidden'; }
  }, {passive: true});

  heroEl.addEventListener('touchmove', e => {
    active = true;
    const t = e.touches[0];
    rawX = t.clientX; rawY = t.clientY;
  }, {passive: true});

  heroEl.addEventListener('touchend', () => {
    // Hold spotlight briefly so lifting the finger feels smooth, not abrupt
    touchEndTimer = setTimeout(() => {
      active = false;
      rawX = -999; rawY = -999;
      clearMask();
    }, 600);
  }, {passive: true});

  heroEl.addEventListener('touchcancel', () => {
    active = false;
    rawX = -999; rawY = -999;
    clearMask();
  }, {passive: true});

  // ── RAF LOOP — smooth interpolation ──
  let lastSmX = -9999, lastSmY = -9999;
  function spotlightLoop() {
    if (active && rawX !== -999) {
      const lerpFactor = isCoarse ? 0.2 : 0.1;
      smX += (rawX - smX) * lerpFactor;
      smY += (rawY - smY) * lerpFactor;
      // Only push a style update when position has meaningfully changed (> 0.5px)
      if (Math.abs(smX - lastSmX) > 0.5 || Math.abs(smY - lastSmY) > 0.5) {
        lastSmX = smX; lastSmY = smY;
        applyMask(smX, smY);
      }
    }
    requestAnimationFrame(spotlightLoop);
  }
  spotlightLoop();

  // ══════════════════════════════════════════════════
  // SYSTEM 1: PRELOADER
  // ══════════════════════════════════════════════════
  try { (function runPreloader() {
    const pre      = document.getElementById('pre');
    const preCount = document.getElementById('preCount');
    const preWord  = document.getElementById('preWord');
    const preBarI  = document.querySelector('#preBar i');
    if (!pre || !preCount || !preBarI) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) { pre.classList.add('gone'); return; }

    // Three fixed-width cells so layout never reflows (1 digit -> 3 digits).
    // Empty leading cells collapse via .pc-digit.empty, so the number grows
    // from the right like an odometer instead of leaving a blank gap.
    // #preCount's markup starts as a plain "0" (no-JS fallback) — must be
    // cleared first, or it renders as a literal extra digit ("0100%").
    preCount.textContent = '';
    const DIGITS = 3;
    const cells = [];
    for (let i = 0; i < DIGITS; i++) {
      const cell = document.createElement('span');
      cell.className = 'pc-digit empty';
      const i1 = document.createElement('i');
      i1.textContent = '';
      cell.appendChild(i1);
      preCount.appendChild(cell);
      cells.push({ el: cell, i: i1, shown: '', pendingRemoval: null, pendingRemovalTimer: null });
    }
    const pct = document.createElement('span');
    pct.className = 'pc-pct';
    pct.textContent = '%';
    preCount.appendChild(pct);

    function setDigits(n) {
      const str = String(Math.max(0, Math.min(999, n))).padStart(DIGITS, ' ');
      for (let i = 0; i < DIGITS; i++) {
        const ch = str[i] === ' ' ? '' : str[i];
        const c = cells[i];
        if (ch !== c.shown) {
          c.el.classList.toggle('empty', ch === '');
          // Quick flip rather than an instant text replace. `outgoing` must
          // capture this exact element now — c.i can move on to a newer
          // digit before the rAF below fires (changes happen almost every
          // frame during the fast part of the count-up), which previously
          // applied the exit transform to the wrong element.
          const outgoing = c.i;

          // Drop any earlier outgoing element still on its removal timer
          // immediately, rather than letting it ride out the full exit
          // duration — it's already hidden behind the newer one (cell
          // clips via overflow:hidden) so nothing is lost visually, but
          // skipping this let dozens of stale nodes pile up when digits
          // change every ~17ms, far faster than the 340ms exit animation.
          if (c.pendingRemoval && c.pendingRemoval !== outgoing) {
            clearTimeout(c.pendingRemovalTimer);
            if (c.pendingRemoval.parentNode) c.pendingRemoval.remove();
          }

          const next = document.createElement('i');
          next.textContent = ch;
          next.style.transform = 'translateY(1em)';
          next.style.transition = 'none';
          c.el.appendChild(next);
          void next.getBoundingClientRect(); // force layout so the transform-none start state is committed before animating
          next.style.transition = '';
          requestAnimationFrame(() => {
            outgoing.style.transform = 'translateY(-1em)';
            next.style.transform = 'translateY(0)';
          });
          c.pendingRemoval = outgoing;
          c.pendingRemovalTimer = setTimeout(() => {
            if (outgoing.parentNode) outgoing.remove();
            if (c.pendingRemoval === outgoing) c.pendingRemoval = null;
          }, 340);
          c.i = next;
          c.shown = ch;
        }
      }
    }

    // ── Build the kinetic label from data-lines (reuses the site's
    // word-shell mask pattern so the preloader text feels native to the
    // rest of the page rather than a separate visual language) ──
    if (preWord) {
      const lines = (preWord.getAttribute('data-lines') || '').split('|').filter(Boolean);
      let wi = 0;
      preWord.innerHTML = lines.map(line => {
        const words = line.split(' ').filter(Boolean).map(w => {
          const delay = (wi++ * 0.045).toFixed(3);
          return `<span class="word-shell" style="--delay:${delay}s"><i>${w}</i></span>`;
        }).join(' ');
        return `<span class="pw-line">${words}</span>`;
      }).join('');
      // #preWord isn't a .stagger-paragraph, so the shared
      // ".stagger-paragraph.in .word-shell>i" reveal rule doesn't apply
      // here — drive the per-word delay and the translateY(0) reveal
      // directly instead. One rAF after the innerHTML write so the
      // initial translateY(110%) state is committed before animating.
      const shellInners = preWord.querySelectorAll('.word-shell>i');
      shellInners.forEach(i => {
        i.style.transitionDelay = i.parentElement.style.getPropertyValue('--delay');
      });
      requestAnimationFrame(() => {
        shellInners.forEach(i => { i.style.transform = 'translateY(0)'; });
      });
    }

    const start = performance.now();
    const dur   = 2000; // ms — slightly longer to give the kinetic label room to land

    function tick(now) {
      const t = Math.min((now - start) / dur, 1);
      // ease-out curve
      const e = 1 - Math.pow(1 - t, 2.4);
      const p = Math.round(e * 100);
      setDigits(p);
      preCount.setAttribute('aria-valuenow', String(p));
      preBarI.style.width = (e * 100) + '%';
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        // Hold briefly on 100% so the finished state actually registers,
        // then run the exit choreography (mask-out + bracket snap) before
        // the final opacity fade defined on #pre.gone.
        setTimeout(() => {
          pre.classList.add('leaving');
          setTimeout(() => pre.classList.add('gone'), 520);
        }, 260);
      }
    }
    requestAnimationFrame(tick);
  })(); } catch (e) { console.error('[NYTHERION] runPreloader failed:', e); }

  // ══════════════════════════════════════════════════
  // SYSTEM 2: TRUE FOCUS
  // ══════════════════════════════════════════════════
  try { (function setupTrueFocus() {
    const container = document.getElementById('trueFocus');
    if (!container) return;
    const frame = container.querySelector('.focus-frame');
    const rawWords = (container.getAttribute('data-words') || '').split(' ').filter(Boolean);

    // Build word spans dynamically (INK pattern)
    const spans = rawWords.map(w => {
      const s = document.createElement('span');
      s.className = 'focus-word';
      s.textContent = w;
      container.appendChild(s);
      return s;
    });

    let autoIdx = 0;
    let manualIdx = 0;
    let manual = false;
    let sectionActive = false;

    function placeFrame(i) {
      const el = spans[i];
      if (!el || !frame) return;
      const pr = container.getBoundingClientRect();
      const r  = el.getBoundingClientRect();
      frame.style.transform = `translate(${r.left - pr.left}px, ${r.top - pr.top}px)`;
      frame.style.width     = r.width  + 'px';
      frame.style.height    = r.height + 'px';
      frame.style.opacity   = '1';
      spans.forEach((s, j) => s.classList.toggle('active', j === i));
    }

    // Hover: manual override
    spans.forEach((s, i) => {
      s.addEventListener('mouseenter', () => { manual = true; manualIdx = i; placeFrame(i); });
      s.addEventListener('mouseleave', () => { manual = false; });
    });

    // Intersection observer to only auto-cycle when visible
    const fio = new IntersectionObserver(entries => {
      sectionActive = entries[0].isIntersecting;
      if (sectionActive) placeFrame(manual ? manualIdx : autoIdx);
    }, { threshold: 0.4 });
    fio.observe(container);

    // Auto-cycle every 1900ms (matches INK)
    setInterval(() => {
      if (!sectionActive || manual) return;
      autoIdx = (autoIdx + 1) % spans.length;
      placeFrame(autoIdx);
    }, 1900);

    onResize(() => placeFrame(manual ? manualIdx : autoIdx));
    setTimeout(() => placeFrame(0), 140);
  })(); } catch (e) { console.error('[NYTHERION] setupTrueFocus failed:', e); }

  // ══════════════════════════════════════════════════
  // SYSTEM 3: PIPELINE HORIZONTAL SCRUB
  // ══════════════════════════════════════════════════
  try { (function setupPipeline() {
    const physicsSec = document.getElementById('physicsSection');
    const pipeTrack  = document.getElementById('pipeTrack');
    if (!physicsSec || !pipeTrack) return;

    // Cache stage/bar references once — querying these fresh on every
    // scroll frame (previously: querySelectorAll + nested querySelector
    // per stage, every frame) is unnecessary DOM work that adds up under
    // fast scroll/fling gestures.
    const stages = Array.from(pipeTrack.querySelectorAll('.pstage'));
    const bars   = stages.map(s => s.querySelector('.pbar'));
    const n      = stages.length;

    // Reset all progress bars to 0
    bars.forEach(b => { if (b) b.style.transform = 'scaleX(0)'; });

    function updatePipe() {
      const rect       = physicsSec.getBoundingClientRect();
      const pinHeight  = rect.height - window.innerHeight;
      if (pinHeight <= 0) return;

      let progress = clamp(-rect.top / pinHeight, 0, 1);

      // Horizontal translation
      const maxDeltaX = pipeTrack.scrollWidth - window.innerWidth;
      pipeTrack.style.transform = `translate3d(${-progress * maxDeltaX}px, 0, 0)`;

      // Per-stage progress bar fill: stagger across the scroll range
      for (let i = 0; i < n; i++) {
        const bar = bars[i];
        if (!bar) continue;
        // Each stage fills during its own ~1/n slice of scroll
        const seg = clamp(progress * n - i, 0, 1);
        bar.style.transform = `scaleX(${seg})`;
      }
    }

    onScroll(updatePipe);
    updatePipe(); // initialise state on load (e.g. scroll-restored or deep-linked pages)
  })(); } catch (e) { console.error('[NYTHERION] setupPipeline failed:', e); }

  // ══════════════════════════════════════════════════
  // SYSTEM 4: ENGINE WORD MORPH SCRUB
  // ══════════════════════════════════════════════════
  try { (function setupEngineScrub() {
    const engineSec = document.getElementById('engineSection');
    const dWord     = document.getElementById('directWord');
    const dDesc     = document.getElementById('directDesc');
    const dBarI     = document.getElementById('directBarI');
    if (!engineSec || !dWord) return;

    const dCurl  = document.getElementById('d_curl');
    const dForce = document.getElementById('d_force');
    const dBloom = document.getElementById('d_bloom');
    const dFade  = document.getElementById('d_fade');
    const dbCurl  = document.getElementById('db_curl');
    const dbForce = document.getElementById('db_force');
    const dbBloom = document.getElementById('db_bloom');
    const dbFade  = document.getElementById('db_fade');

    const presets = [
      { w: 'VISCOSITY', curl: 18, force: 3800, bloom: 0.85, fade: 0.74,
        d: 'Calculated fluid drag parameters defining internal motion density and resistance.' },
      { w: 'VORTICITY', curl: 32, force: 5400, bloom: 1.28, fade: 0.68,
        d: 'Generates high-fidelity turbulent rotational forces and swirling velocity fields.' },
      { w: 'PRESSURE',  curl:  6, force: 2600, bloom: 0.34, fade: 0.93,
        d: 'Controls micro-expansion fields forcing outward mass conservation and boundary flow.' },
      { w: 'DENSITY',   curl: 11, force: 2000, bloom: 0.55, fade: 0.82,
        d: 'Determines particle dissipation parameters and opacity fade across render loops.' },
    ];

    let lastIdx = -1;

    function updateEngine() {
      const rect      = engineSec.getBoundingClientRect();
      const pinHeight = rect.height - window.innerHeight;
      if (pinHeight <= 0) return;

      const progress = clamp(-rect.top / pinHeight, 0, 1);
      const count    = presets.length;
      let   idx      = Math.floor(progress * count);
      if (idx >= count) idx = count - 1;

      // Bar fill reflects full scroll progress
      if (dBarI) dBarI.style.width = (progress * 100) + '%';

      if (idx !== lastIdx) {
        lastIdx = idx;
        const p = presets[idx];

        // Swap word: slide out → reposition at bottom → slide in
        dWord.classList.add('out');
        setTimeout(() => {
          dWord.textContent = p.w;
          if (dDesc) dDesc.textContent = p.d;

          // Update live-panel values
          if (dCurl)  dCurl.textContent  = p.curl;
          if (dForce) dForce.textContent = p.force;
          if (dBloom) dBloom.textContent = p.bloom.toFixed(2);
          if (dFade)  dFade.textContent  = p.fade.toFixed(2);

          if (dbCurl)  dbCurl.style.width  = clamp(p.curl  / 40   * 100, 2, 100) + '%';
          if (dbForce) dbForce.style.width = clamp(p.force / 6000 * 100, 2, 100) + '%';
          if (dbBloom) dbBloom.style.width = clamp(p.bloom / 1.4  * 100, 2, 100) + '%';
          if (dbFade)  dbFade.style.width  = clamp((p.fade - 0.6) / 0.35 * 100, 2, 100) + '%';

          dWord.classList.remove('out');
          dWord.classList.add('inq');
          void dWord.getBoundingClientRect(); // force reflow
          dWord.classList.remove('inq');
        }, 260);
      }
    }

    // Initialise with first preset
    dWord.textContent = presets[0].w;
    if (dDesc) dDesc.textContent = presets[0].d;

    onScroll(updateEngine);
    updateEngine(); // initialise state on load (e.g. scroll-restored or deep-linked pages)
  })(); } catch (e) { console.error('[NYTHERION] setupEngineScrub failed:', e); }

  // ══════════════════════════════════════════════════
  // SYSTEM 5: IDEA — STAGGERED WORD REVEAL
  // ══════════════════════════════════════════════════
  try { (function setupIdeaSection() {
    const paras = document.querySelectorAll('.stagger-paragraph');
    if (!paras.length) return;

    paras.forEach(para => {
      // Collect existing .word-shell nodes (from hand-authored HTML)
      // and plain text nodes — split both into animatable shells
      const nodes = Array.from(para.childNodes);
      let wordIndex = 0;
      let rebuilt = '';

      nodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          // Split raw text words into shells
          const words = node.textContent.split(/(\s+)/);
          words.forEach(token => {
            if (/^\s+$/.test(token)) {
              rebuilt += ' ';
            } else if (token) {
              rebuilt += `<span class="word-shell" style="--delay:${(wordIndex++ * 0.032).toFixed(3)}s"><i>${token}</i></span>`;
            }
          });
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          // Preserve hand-authored .word-shell spans (accent / serif classes)
          const el = node;
          if (el.classList.contains('word-shell')) {
            el.style.setProperty('--delay', (wordIndex++ * 0.032).toFixed(3) + 's');
            rebuilt += el.outerHTML;
          } else {
            // Inline element that isn't a word-shell — wrap its text content
            rebuilt += `<span class="word-shell" style="--delay:${(wordIndex++ * 0.032).toFixed(3)}s"><i>${el.outerHTML}</i></span>`;
          }
        }
      });

      para.innerHTML = rebuilt;
    });

    // IntersectionObserver — trigger each paragraph independently
    const ideaIO = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const target = entry.target;
          target.classList.add('in');
          ideaIO.unobserve(target);

          // .word-shell>i carries a permanent will-change:transform (see
          // design.css) so the browser can pre-optimize this one-shot
          // staggered reveal — but for a paragraph of ~20 words that's
          // ~20 GPU compositing layers held open forever after a single
          // ~1-2s animation, which is unnecessary memory/bandwidth
          // pressure on mobile. Release them once the reveal has
          // actually finished: timed from THIS paragraph's own longest
          // per-word delay + the transition duration (with a small
          // buffer), not a guessed constant, so it's correct regardless
          // of paragraph length.
          const shells = target.querySelectorAll('.word-shell>i');
          let maxDelay = 0;
          shells.forEach(i => {
            const d = parseFloat(getComputedStyle(i).transitionDelay) || 0;
            if (d > maxDelay) maxDelay = d;
          });
          const TRANSITION_S = 1.1; // matches .word-shell>i's transition-duration in design.css
          setTimeout(() => {
            shells.forEach(i => { i.style.willChange = 'auto'; });
          }, (maxDelay + TRANSITION_S + 0.3) * 1000);
        }
      });
    }, { threshold: 0.18 });

    paras.forEach(p => ideaIO.observe(p));
  })(); } catch (e) { console.error('[NYTHERION] setupIdeaSection failed:', e); }

  // ══════════════════════════════════════════════════
  // SYSTEM 6: TOUCH — INTERACTIVE GRID PROXIMITY
  // ══════════════════════════════════════════════════
  try { (function setupTouchGrid() {
    const gridItems = document.querySelectorAll('#touchSection .grid-item');
    if (!gridItems.length) return;

    const isCoarsePtr = window.matchMedia('(pointer:coarse)').matches;
    const MAX_DIST = 380;

    // Track whether the section is even on screen — avoids running
    // getBoundingClientRect() for every grid item on every mousemove
    // across the whole page while this section is scrolled out of view.
    const gridSectionEl = document.getElementById('touchSection');
    let sectionVisible = true;
    if (gridSectionEl) {
      const sectionIO = new IntersectionObserver(entries => {
        sectionVisible = entries[0].isIntersecting;
        if (!sectionVisible) gridItems.forEach(resetItem);
      }, { threshold: 0 });
      sectionIO.observe(gridSectionEl);
    }

    // ── Mouse tracking (desktop) ──
    if (!isCoarsePtr) {
      let rafPending = false;
      let mx = -9999, my = -9999;

      window.addEventListener('mousemove', e => {
        if (!sectionVisible) return;
        mx = e.clientX;
        my = e.clientY;
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            applyProximity(mx, my);
          });
        }
      }, { passive: true });

      // Reset all cards when cursor leaves window
      window.addEventListener('mouseleave', () => {
        gridItems.forEach(resetItem);
      });
    }

    // ── Touch tracking (mobile / tablet) ──
    const gridSection = gridSectionEl;
    if (gridSection && isCoarsePtr) {
      let touchRaf = false;
      gridSection.addEventListener('touchmove', e => {
        const t = e.touches[0];
        if (!touchRaf) {
          touchRaf = true;
          requestAnimationFrame(() => {
            touchRaf = false;
            applyProximity(t.clientX, t.clientY);
          });
        }
      }, { passive: true });

      gridSection.addEventListener('touchend', () => {
        gridItems.forEach(resetItem);
      }, { passive: true });
    }

    function applyProximity(mx, my) {
      gridItems.forEach(item => {
        const rect = item.getBoundingClientRect();
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        const dx = mx - cx;
        const dy = my - cy;
        const dist = Math.hypot(dx, dy);

        if (dist < MAX_DIST) {
          const intensity = (MAX_DIST - dist) / MAX_DIST;
          // Tilt: normalised to card size so aspect ratio doesn't matter
          const tiltX =  (dy / rect.height) * 22 * intensity;
          const tiltY = -(dx / rect.width)  * 22 * intensity;

          // Inner spotlight origin in % relative to card
          const innerX = clamp(((mx - rect.left) / rect.width)  * 100, 0, 100);
          const innerY = clamp(((my - rect.top)  / rect.height) * 100, 0, 100);

          const inner = item.querySelector('.item-inner');
          if (inner) {
            inner.style.setProperty('--mouse-x', `${innerX.toFixed(1)}%`);
            inner.style.setProperty('--mouse-y', `${innerY.toFixed(1)}%`);
            inner.style.transform = `scale(${(1 + 0.05 * intensity).toFixed(4)})`;
          }

          item.style.transform =
            `perspective(1000px) rotateX(${tiltX.toFixed(3)}deg) rotateY(${tiltY.toFixed(3)}deg) translateZ(${(12 * intensity).toFixed(2)}px)`;
          item.style.borderColor = `rgba(63,140,255,${(0.12 + 0.3 * intensity).toFixed(3)})`;
        } else {
          resetItem(item);
        }
      });
    }

    function resetItem(item) {
      item.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) translateZ(0px)';
      item.style.borderColor = '';
      const inner = item.querySelector('.item-inner');
      if (inner) {
        inner.style.transform = 'scale(1)';
        inner.style.setProperty('--mouse-x', '50%');
        inner.style.setProperty('--mouse-y', '50%');
      }
    }
  })(); } catch (e) { console.error('[NYTHERION] setupTouchGrid failed:', e); }

  // ══════════════════════════════════════════════════
  // SYSTEM 7: MANIFESTO — STAGGERED LINES + TICKER
  // ══════════════════════════════════════════════════
  try { (function setupManifesto() {
    // Assign stagger delays to each .word inside .manifesto-line
    // (mirrors Ink's per-word delay pattern)
    document.querySelectorAll('.manifesto-line').forEach(line => {
      line.querySelectorAll('.word').forEach((w, i) => {
        w.style.setProperty('--d', (i * 0.072) + 's');
      });
    });

    // Reveal lines with IntersectionObserver
    const lines = document.querySelectorAll('.manifesto-line');
    const manifestoIO = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          manifestoIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.25 });

    lines.forEach(l => manifestoIO.observe(l));

    // Ticker: the two .ticker-content divs are already duplicated in HTML,
    // so the CSS animation produces a seamless loop with zero JS overhead.
    // Only action needed: pause animation when the section is off-screen
    // to conserve GPU compositing budget.
    const tickerSection = document.getElementById('manifestoSection');
    const tickerContents = document.querySelectorAll('#manifestoSection .ticker-content');

    if (tickerSection && tickerContents.length) {
      const tickerIO = new IntersectionObserver(entries => {
        const paused = !entries[0].isIntersecting;
        tickerContents.forEach(tc => {
          tc.style.animationPlayState = paused ? 'paused' : 'running';
        });
      }, { threshold: 0 });
      tickerIO.observe(tickerSection);
    }
  })(); } catch (e) { console.error('[NYTHERION] setupManifesto failed:', e); }

  // ══════════════════════════════════════════════════
  // SYSTEM 8: AETHER DRIVE — WebGL plasma shader on page tabs
  // (ported verbatim from the Aether Drive reference button;
  //  same vertex/fragment shaders & easing, run per-button)
  // ══════════════════════════════════════════════════
  try { (function setupAetherTabs() {
    const tabs = document.querySelectorAll('.page-tab');
    if (!tabs.length) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Each tab gets its own tiny WebGL context: a single fullscreen
    // triangle with no textures/geometry, so the GPU/memory cost per
    // context is trivial, and this is the only WebGL usage on the page.
    // Real context exhaustion is still handled gracefully — if
    // getContext('webgl') ever returns null (very old/constrained
    // devices, or context creation genuinely failing), that specific tab
    // falls back to .nogl below rather than erroring.

    const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    const FS = `
      precision highp float;
      uniform vec2 u_res;
      uniform float u_time, u_heat, u_flash;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
      }
      float fbm(vec2 p){
        float v=0.0; float a=0.5;
        for(int i=0;i<5;i++){ v+=a*noise(p); p=p*2.02+vec2(17.3,9.1); a*=0.5; }
        return v;
      }
      void main(){
        vec2 uv = gl_FragCoord.xy / u_res;
        vec2 p = uv * vec2(u_res.x/u_res.y, 1.0) * 2.1;
        float t = u_time;
        float heat = u_heat + u_flash * 1.3;
        vec2 q = vec2(fbm(p + vec2(0.0, t*0.32)), fbm(p + vec2(5.2, t*0.27)));
        vec2 r = vec2(fbm(p + 1.7*q + vec2(1.7, 9.2) + t*0.12), fbm(p + 1.6*q + vec2(8.3, 2.8) + t*0.09));
        float v = fbm(p + 2.1*r);
        float m = v*1.4 + heat*0.22;
        vec3 c1 = vec3(0.004, 0.008, 0.035), c2 = vec3(0.04, 0.08, 0.35), c3 = vec3(0.0, 0.6, 1.0), c4 = vec3(0.7, 0.9, 1.0);
        vec3 col = mix(c1, c2, smoothstep(0.2, 0.52, m));
        col = mix(col, c3, smoothstep(0.52, 0.8, m));
        col = mix(col, c4, smoothstep(0.82, 1.02, m));
        float vein = exp(-abs(q.x - q.y) * 9.0);
        col += c3 * vein * (0.12 + heat * 0.25);
        vec2 e = uv * (1.0 - uv);
        float vig = pow(e.x * e.y * 16.0, 0.28);
        col *= mix(0.5, 1.0, vig);
        col *= 0.78 + heat * 0.5;
        col += vec3(0.82, 0.94, 1.0) * u_flash * 0.4 * (0.3 + v);
        gl_FragColor = vec4(col, 1.0);
      }`;

    function compile(gl, type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('Aether tab shader compile error:', gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    }

    tabs.forEach(btn => {
      const canvas = btn.querySelector('.page-tab-gl');
      if (!canvas) return;

      const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });

      if (!gl) { btn.classList.add('nogl'); return; }

      const vs = compile(gl, gl.VERTEX_SHADER, VS);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
      if (!vs || !fs) { btn.classList.add('nogl'); return; }

      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('Aether tab program link error:', gl.getProgramInfoLog(prog));
        btn.classList.add('nogl');
        return;
      }
      gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const locP = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(locP);
      gl.vertexAttribPointer(locP, 2, gl.FLOAT, false, 0, 0);

      const uRes = gl.getUniformLocation(prog, 'u_res');
      const uTime = gl.getUniformLocation(prog, 'u_time');
      const uHeat = gl.getUniformLocation(prog, 'u_heat');
      const uFlash = gl.getUniformLocation(prog, 'u_flash');

      function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(btn.clientWidth * dpr));
        const h = Math.max(1, Math.round(btn.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w; canvas.height = h;
          gl.viewport(0, 0, w, h);
        }
      }

      let heat = 0, heatTarget = 0, erupt = 0, churn = 0, last = performance.now();
      let visible = true;
      let rafId = null;
      let contextLost = false;

      // WebGL contexts can be lost at any time (GPU reset, browser memory
      // pressure, too many contexts open across tabs/sites). Without this,
      // a lost context would spam console errors every frame forever from
      // the now-invalid gl calls below. Detect it and fall back cleanly.
      canvas.addEventListener('webglcontextlost', e => {
        e.preventDefault();
        contextLost = true;
        rafId = null;
        btn.classList.remove('gl-ready');
        btn.classList.add('nogl');
      });

      // Fully stop the render loop (no rAF callback queued at all) once the
      // tab is off-screen, at rest (heat/erupt settled), and not focused —
      // six tiny nav pills don't need six perpetual WebGL render loops.
      //
      // For reduced-motion users specifically, the ambient plasma churn is
      // frozen (see uTime below) — so once heat/erupt settle, the frame is
      // byte-for-byte identical every time, and re-rendering it forever
      // just because the pill happens to be on-screen is pure waste. Drop
      // the visibility requirement in that case so it actually stops.
      function isIdle() {
        if (reduced) return heatTarget === 0 && heat < 0.001 && erupt < 0.001;
        return !visible && heatTarget === 0 && heat < 0.001 && erupt < 0.001;
      }

      function ensureRunning() {
        if (rafId === null && !contextLost) {
          last = performance.now();
          rafId = requestAnimationFrame(frame);
        }
      }

      btn.addEventListener('mouseenter', () => { heatTarget = 1; ensureRunning(); });
      btn.addEventListener('mouseleave', () => { heatTarget = 0; });
      btn.addEventListener('mousedown',  () => { erupt = 1; ensureRunning(); });
      btn.addEventListener('focus',      () => { heatTarget = 1; ensureRunning(); });
      btn.addEventListener('blur',       () => { heatTarget = 0; });

      // Only render while the tab strip is on screen, to save GPU budget
      const tabIO = new IntersectionObserver(entries => {
        visible = entries[0].isIntersecting;
        if (visible) ensureRunning();
      }, { threshold: 0 });
      tabIO.observe(btn);

      function frame(now) {
        if (contextLost) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        heat += (heatTarget - heat) * Math.min(1, dt * 6);
        erupt *= Math.exp(-3.2 * dt);
        churn += dt * (0.35 + heat * 1.1 + erupt * 2.2);
        if (visible) {
          resize();
          gl.uniform2f(uRes, canvas.width, canvas.height);
          gl.uniform1f(uTime, reduced ? 6.0 : churn);
          gl.uniform1f(uHeat, heat);
          gl.uniform1f(uFlash, erupt);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        if (isIdle()) {
          rafId = null; // stop looping until the next interaction/visibility change
        } else {
          rafId = requestAnimationFrame(frame);
        }
      }
      ensureRunning();

      btn.classList.add('gl-ready');
    });
  })(); } catch (e) { console.error('[NYTHERION] setupAetherTabs failed:', e); }

  // ══════════════════════════════════════════════════
  // SYSTEM 9: WARRIOR CINEMATIC 3D
  // Pure vanilla JS, no library/CDN dependency — same constraint as the
  // Aether Drive tab shaders above. Parses the CyberSoldier.glb binary by
  // hand (GLB container -> JSON + BIN chunks -> accessors), uploads
  // position/normal/uv/index buffers and four PBR textures (base color,
  // metallic-roughness, normal, emissive) straight to WebGL, and lights it
  // with a small hand-written shader (key + rim light + fresnel + pulsing
  // emissive glow) tuned to the page's blue/cyan palette.
  //
  // Scroll position drives camera orbit angle (replaces the old video
  // currentTime scrub 1:1) layered on a slow ambient idle spin. Mouse
  // position adds a fine orbit/tilt offset (replaces the old stage
  // parallax translate). The model itself ships embedded as base64 in a
  // <script type="text/plain"> tag (see loadEmbeddedGLB below) rather
  // than fetched over the network, so the page works even opened
  // directly from disk — fetch() is blocked under file:// entirely,
  // with no workaround, so a separate .glb request would only ever work
  // when actually served over http(s). A chunked progress readout still
  // drives the boot HUD during the decode, since it's a ~23MB asset and
  // deserves honest feedback rather than a fake spinner. Any failure (no
  // WebGL, missing/corrupt data, decode error, lost context) falls back
  // to the static poster image — the section never breaks, it just
  // becomes a still frame.
  // ══════════════════════════════════════════════════
  try { (function setupWarriorSection() {
    const section = document.getElementById('warriorSection');
    const stage   = document.getElementById('warriorStage');
    const canvas  = document.getElementById('warriorCanvas');
    const poster  = document.getElementById('warriorPoster');
    const boot    = document.getElementById('warriorBoot');
    const bootFill  = document.getElementById('warriorBootFill');
    const bootLabel = document.getElementById('warriorBootLabel');
    const sub     = document.getElementById('warriorSub');
    if (!section || !stage || !canvas || !poster || !boot) return;

    const coarsePtr    = window.matchMedia('(pointer:coarse)').matches;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function fallbackToPoster(reason) {
      console.warn('[warrior] falling back to poster:', reason);
      stage.classList.add('fallback');
      boot.classList.add('done');
    }

    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) { fallbackToPoster('no WebGL context'); return; }

    const uintExt = gl.getExtension('OES_element_index_uint');
    if (!uintExt) { fallbackToPoster('missing OES_element_index_uint'); return; }

    // Used for a screen-space tangent basis in the fragment shader so the
    // normal map can be applied without a precomputed tangent attribute
    // (the source mesh doesn't ship one). Optional — shading still looks
    // correct without it, just with slightly softer per-pixel detail, so
    // its absence isn't a fallback-worthy condition on its own.
    const derivExt = gl.getExtension('OES_standard_derivatives');

    // WebGL contexts can be lost at any time (GPU reset, memory pressure).
    // Without this, a lost context spams invalid gl calls forever.
    let contextLost = false;
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      contextLost = true;
      fallbackToPoster('context lost');
    });

    // ── GLB parsing ──
    function parseGLB(buf) {
      const dv = new DataView(buf);
      if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('bad GLB magic');
      let offset = 12;
      let jsonChunk = null, binChunk = null;
      while (offset < buf.byteLength) {
        const chunkLength = dv.getUint32(offset, true);
        const chunkType   = dv.getUint32(offset + 4, true);
        const chunkData   = buf.slice(offset + 8, offset + 8 + chunkLength);
        if (chunkType === 0x4E4F534A) jsonChunk = new TextDecoder('utf-8').decode(chunkData);
        else if (chunkType === 0x004E4942) binChunk = chunkData;
        offset += 8 + chunkLength;
      }
      if (!jsonChunk || !binChunk) throw new Error('missing JSON/BIN chunk');
      const gltf = JSON.parse(jsonChunk);

      function accessorData(idx) {
        const acc = gltf.accessors[idx];
        const bv  = gltf.bufferViews[acc.bufferView];
        const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const compCount = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4 }[acc.type];
        const n = acc.count * compCount;
        if (acc.componentType === 5126) return new Float32Array(binChunk, byteOffset, n);
        if (acc.componentType === 5125) return new Uint32Array(binChunk, byteOffset, n);
        if (acc.componentType === 5123) return new Uint16Array(binChunk, byteOffset, n);
        if (acc.componentType === 5121) return new Uint8Array(binChunk, byteOffset, n);
        throw new Error('unsupported component type ' + acc.componentType);
      }
      function imageBlob(imgIdx) {
        const bv = gltf.bufferViews[gltf.images[imgIdx].bufferView];
        const bytes = new Uint8Array(binChunk, bv.byteOffset, bv.byteLength);
        return new Blob([bytes], { type: gltf.images[imgIdx].mimeType || 'image/jpeg' });
      }

      const prim = gltf.meshes[0].primitives[0];
      return {
        positions: accessorData(prim.attributes.POSITION),
        normals:   accessorData(prim.attributes.NORMAL),
        uvs:       accessorData(prim.attributes.TEXCOORD_0),
        indices:   accessorData(prim.indices),
        imageBlob,
      };
    }

    function loadImage(blob) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
        img.src = url;
      });
    }

    function createTexture(img) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // glTF defines UV origin at top-left, matching the image's natural
      // row order — so unlike many other 3D formats, glTF textures should
      // NOT be flipped on upload. Flipping here was sampling every
      // triangle from a vertically mirrored texture row relative to its
      // real UV coordinate, scattering unrelated content across the
      // model. (Previously misdiagnosed as source-texture corruption —
      // it wasn't; this was the actual bug.)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }

    function makeBuffer(target, data) {
      const buf = gl.createBuffer();
      gl.bindBuffer(target, buf);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return buf;
    }

    // ── shaders ──
    const VS = `
      attribute vec3 a_pos; attribute vec3 a_normal; attribute vec2 a_uv;
      uniform mat4 u_model, u_view, u_proj; uniform mat3 u_normalMat;
      varying vec3 v_normal; varying vec2 v_uv; varying vec3 v_worldPos;
      void main(){
        vec4 worldPos = u_model * vec4(a_pos, 1.0);
        v_worldPos = worldPos.xyz;
        v_normal = u_normalMat * a_normal;
        v_uv = a_uv;
        gl_Position = u_proj * u_view * worldPos;
      }`;

    // Texture sampling was previously suspected broken — every UV island
    // looked like a fragment of unrelated content when the raw image was
    // inspected flat. That's actually normal for any baked PBR atlas
    // (islands are packed wherever the bake tool puts them, not adjacent
    // to their position on the body) and was a red herring. The real bug
    // was `UNPACK_FLIP_Y_WEBGL` being set true on upload: glTF defines UV
    // origin at top-left (matching raw image row order), so flipping on
    // upload sampled every triangle from a vertically mirrored row
    // relative to its real UV coordinate, scattering content
    // unpredictably across the model. With that corrected, the actual
    // baked textures are sampled directly below.
    const FS = `
      ${derivExt ? '#extension GL_OES_standard_derivatives : enable' : ''}
      precision highp float;
      varying vec3 v_normal; varying vec2 v_uv; varying vec3 v_worldPos;
      uniform sampler2D u_base, u_normalTex, u_emissive;
      uniform vec3 u_camPos, u_lightDir1, u_lightDir2;
      uniform float u_time, u_headY, u_headBlend;

      void main(){
        vec3 baseN = normalize(v_normal);
        float detailAmount = 0.0;

        #ifdef GL_OES_standard_derivatives
          // Screen-space tangent basis (no precomputed tangent attribute
          // on this mesh) — standard derivative-based TBN construction.
          vec3 dp1 = dFdx(v_worldPos), dp2 = dFdy(v_worldPos);
          vec2 duv1 = dFdx(v_uv), duv2 = dFdy(v_uv);
          vec3 dp2perp = cross(dp2, baseN);
          vec3 dp1perp = cross(baseN, dp1);
          vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
          vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
          float invmax = 1.0 / sqrt(max(dot(T,T), dot(B,B)) + 1e-8);
          T *= invmax; B *= invmax;
          vec3 nmRaw = texture2D(u_normalTex, v_uv).rgb * 2.0 - 1.0;
          detailAmount = clamp(length(nmRaw.xy) * 2.2, 0.0, 1.0);
          vec3 nmSample = nmRaw;
          nmSample.xy *= 0.85;
          vec3 N = normalize(nmSample.x * T + nmSample.y * B + nmSample.z * baseN);
        #else
          vec3 N = baseN;
        #endif

        vec3 V = normalize(u_camPos - v_worldPos);

        vec3 albedo = texture2D(u_base, v_uv).rgb;

        vec3 L1 = normalize(u_lightDir1);
        vec3 L2 = normalize(u_lightDir2);
        float diff1 = max(dot(N, L1), 0.0);
        float diff2 = max(dot(N, L2), 0.0);

        // Warm key light, cool fill — color temperature contrast reads
        // as "lit by something" rather than flat grey ambient.
        vec3 keyColor = vec3(1.1, 1.02, 0.92);
        vec3 fillColor = vec3(0.82, 0.9, 1.08);
        vec3 lit = albedo * (0.26
                              + diff1 * 0.95 * keyColor
                              + diff2 * 0.38 * fillColor);

        // Specular highlight so lit plating reads as a real surface
        // rather than flat-shaded — tighter + brighter for a shinier,
        // more polished/metallic look on the body's armor plating.
        // The head/face/hair isn't metal plating though, so the same
        // hard specular there reads as plastic — fade it out toward
        // the top of the model (skin/hair) while leaving the body's
        // shine untouched.
        float headMask = smoothstep(u_headY - u_headBlend, u_headY + u_headBlend, v_worldPos.y);
        float specStrength = mix(1.0, 0.12, headMask);

        vec3 H1 = normalize(L1 + V);
        vec3 H2 = normalize(L2 + V);
        float spec1 = pow(max(dot(N, H1), 0.0), 64.0) * 0.85 * specStrength;
        float spec2 = pow(max(dot(N, H2), 0.0), 64.0) * 0.4 * specStrength;
        lit += keyColor * spec1;
        lit += fillColor * spec2;

        vec3 color = lit;

        // Cyan rim light for cyberpunk aesthetic
        vec3 rimColor = vec3(0.13, 0.85, 0.95);
        float rim = pow(1.0 - max(dot(N, V), 0.0), 2.4);
        color += rimColor * rim * 0.35;

        // Emissive trim — sampled as real color now (not just a
        // luminance mask), since the texture itself should be correct
        // post-fix.
        vec3 emissiveSample = texture2D(u_emissive, v_uv).rgb;
        float pulse = 0.85 + 0.15 * sin(u_time * 2.0);
        color += emissiveSample * pulse * 1.4;

        gl_FragColor = vec4(color, 1.0);
      }`;

    // ── ship/dome shaders ──
    // The dome is a pre-baked, fully-lit 360 environment photo (its glTF
    // material has emissiveFactor=[1,1,1] and specular=[0,0,0] — the
    // asset is explicitly authored to be shown unlit). So this is a much
    // simpler pass: sample the one texture straight through, no PBR, no
    // normal mapping, no dynamic lights. Reuses the same vertex-shader
    // shape (still needs a_normal bound since the source mesh has it, it
    // just goes unused downstream).
    const VS_SHIP = VS;
    const FS_SHIP = `
      precision highp float;
      varying vec2 v_uv;
      uniform sampler2D u_base;
      void main(){
        gl_FragColor = vec4(texture2D(u_base, v_uv).rgb, 1.0);
      }`;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('shader compile error: ' + gl.getShaderInfoLog(s));
      }
      return s;
    }

    // ── matrix helpers (column-major, mirrors standard glTF/WebGL convention) ──
    function perspective(fovy, aspect, near, far) {
      const f = 1/Math.tan(fovy/2), nf = 1/(near-far);
      return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
    }
    function vecSub(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
    function cross(a,b){return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];}
    function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
    function normalize3(v){const l=Math.sqrt(dot(v,v))||1; return [v[0]/l,v[1]/l,v[2]/l];}
    function lookAt(eye, c, up) {
      const z = normalize3(vecSub(eye,c)), x = normalize3(cross(up,z)), y = cross(z,x);
      return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
    }
    function rotateY(rad) {
      const c=Math.cos(rad), s=Math.sin(rad);
      return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
    }
    // Rotation about X — used once, as a fixed axis-correction for the
    // dome/ship mesh (see the comment where it's applied): the source
    // asset's own glTF node hierarchy carries a Z-up→Y-up correction
    // (a matrix on the "Sketchfab_model" node) that our GLB parser never
    // reads, since it only pulls raw local vertex data straight off the
    // mesh primitive. Baking the same correction in here as a fixed
    // rotation on the model matrix reproduces exactly what that ignored
    // node transform would have done.
    function rotateX(rad) {
      const c=Math.cos(rad), s=Math.sin(rad);
      return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
    }
    // Rotates a direction vector around the Y axis — used to keep the
    // light rig oriented relative to the orbiting camera (see frame()),
    // since the model itself never rotates, only the camera orbits it.
    function rotateYVec(v, rad) {
      const c = Math.cos(rad), s = Math.sin(rad);
      return [v[0]*c + v[2]*s, v[1], -v[0]*s + v[2]*c];
    }
    function translate(v) {
      return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, v[0],v[1],v[2],1]);
    }
    function scaleUniform(s) {
      return new Float32Array([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]);
    }
    // curYaw's per-frame lerp toward targetYaw (see frame()) was written
    // as a flat per-frame factor, which makes it frame-rate dependent —
    // the orbit would visibly catch up to a drag/auto-spin target faster
    // in real time on a high-refresh display than on a 60Hz one. This
    // re-derives the per-frame factor for the current dt so the real-time
    // catch-up speed stays consistent; at exactly 60fps it's a no-op.
    function dtLerp(k, dt) { return 1 - Math.pow(1 - k, dt * 60); }
    function multiply(a,b) {
      const out = new Float32Array(16);
      for (let i=0;i<4;i++) for (let j=0;j<4;j++) {
        out[i*4+j] = a[0*4+j]*b[i*4+0] + a[1*4+j]*b[i*4+1] + a[2*4+j]*b[i*4+2] + a[3*4+j]*b[i*4+3];
      }
      return out;
    }

    // ── load + boot sequence ──
    function setBootProgress(pct, label) {
      if (bootFill) bootFill.style.width = clamp(pct, 0, 100) + '%';
      if (bootLabel && label) bootLabel.textContent = label;
    }

    // The model is loaded two possible ways, tried in order:
    //  1. fetch('./CyberSoldier.glb') — works when served over http(s),
    //     smaller on the wire (no base64 overhead) and skips the decode
    //     step below entirely.
    //  2. A base64 copy embedded inside a non-executing
    //     <script type="text/plain"> tag — the fallback for file://,
    //     where fetch() is blocked entirely by every browser's security
    //     model (there's no server to ask), and for any host where the
    //     .glb wasn't deployed alongside the page. Costs a larger HTML
    //     file and a decode step instead of a network transfer; decoding
    //     is chunked across frames below so it can still report
    //     incremental progress and never blocks the main thread for more
    //     than a few milliseconds at a time.
    function decodeBase64ToArrayBufferChunked(base64Str, onProgress) {
      return new Promise((resolve, reject) => {
        try {
          const CHUNK_CHARS = 1_000_000; // ~750KB of decoded bytes per slice
          const totalChars = base64Str.length;
          // Decoded byte length from a base64 string, accounting for
          // '=' padding on the final chunk only.
          const paddingMatch = base64Str.slice(-2).match(/=+$/);
          const padding = paddingMatch ? paddingMatch[0].length : 0;
          const totalBytes = Math.floor((totalChars * 3) / 4) - padding;
          const out = new Uint8Array(totalBytes);
          let charPos = 0;
          let bytePos = 0;

          function step() {
            try {
              const end = Math.min(charPos + CHUNK_CHARS, totalChars);
              // atob() requires each chunk's length to be a multiple of 4
              // (base64 quantum), except for the final chunk which may
              // carry padding. Align all but the last chunk down to a
              // multiple of 4 so partial quanta never get split.
              let sliceEnd = end;
              if (sliceEnd < totalChars) sliceEnd -= (sliceEnd - charPos) % 4;

              const chunkStr = base64Str.slice(charPos, sliceEnd);
              const binStr = atob(chunkStr);
              for (let i = 0; i < binStr.length; i++) {
                out[bytePos++] = binStr.charCodeAt(i);
              }
              charPos = sliceEnd;

              if (onProgress) onProgress(charPos / totalChars);

              if (charPos < totalChars) {
                setTimeout(step, 0);
              } else {
                resolve(out.buffer);
              }
            } catch (err) {
              reject(err);
            }
          }
          step();
        } catch (err) {
          reject(err);
        }
      });
    }

    // Prefer fetching the .glb directly when served over http(s) — it's
    // ~25% smaller on the wire than the base64 copy and skips the decode
    // step entirely. fetch() throws under file:// (no server to ask), so
    // that failure is the signal to fall back to the embedded copy below;
    // this also covers servers where the file was simply never deployed.
    async function loadFetchedGLB() {
      const res = await fetch('./CyberSoldier.glb');
      if (!res.ok || !res.body) throw new Error('GLB fetch failed: ' + res.status);

      const contentLength = +res.headers.get('Content-Length');
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (contentLength) {
          const frac = received / contentLength;
          setBootProgress(frac * 70, 'Fetching asset \u00b7 ' + Math.round(frac * 100) + '%');
        }
      }

      const buf = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
      return buf.buffer;
    }

    async function loadEmbeddedGLB() {
      // The base64 fallback can come from either source:
      //  - window.WARRIOR_GLB_BASE64, set by a separately-loaded
      //    fallback-data.js file (keeps UI.html itself small enough for
      //    normal git hosting limits)
      //  - the inline <script type="text/plain"> tag (older, single-file
      //    layout, kept for backward compatibility)
      let base64Str = window.WARRIOR_GLB_BASE64;
      if (!base64Str) {
        const dataEl = document.getElementById('warriorGLBData');
        if (!dataEl) throw new Error('embedded model data missing');
        base64Str = dataEl.textContent;
      }
      if (!base64Str || base64Str.length < 100) throw new Error('embedded model data empty');
      return await decodeBase64ToArrayBufferChunked(base64Str, frac => {
        setBootProgress(frac * 70, 'Decoding asset \u00b7 ' + Math.round(frac * 100) + '%');
      });
    }

    async function loadWarriorGLB() {
      try {
        return await loadFetchedGLB();
      } catch (err) {
        // Expected under file:// and on any host that hasn't deployed the
        // .glb alongside the page — silently fall back, no user-facing error.
        return await loadEmbeddedGLB();
      }
    }

    // The dome (WarriorShip.glb) is loaded via plain fetch only — no
    // base64 embed fallback, since it's a large (~2.8MB) purely-additive
    // background layer, not the critical-path asset. If it can't be
    // fetched (file://, or the file wasn't deployed alongside the page),
    // the scene just falls back to the flat background photo behind the
    // soldier, exactly like before — never blocks or fails the soldier
    // render itself.
    async function loadShipGLB() {
      const res = await fetch('./WarriorShip.glb');
      if (!res.ok) throw new Error('ship GLB fetch failed: ' + res.status);
      return await res.arrayBuffer();
    }

    let renderReady = false;
    let halfHeight = 1, centerY = 0, headWorldY = 0, headBlend = 0.1;
    let posBuf, normBuf, uvBuf, idxBuf, indexCount;
    let texBase, texNormal, texEmissive, prog;
    let locPos, locNorm, locUV;
    let uModel, uView, uProj, uNormalMat, uBase, uNormalTex, uEmissive, uCamPos, uLightDir1, uLightDir2, uTime, uHeadY, uHeadBlend;

    // ── dome/ship state ──
    // Sized relative to halfHeight (the soldier's own half-height, in
    // whatever local units CyberSoldier.glb uses) so the dome scales
    // correctly regardless of that model's arbitrary export scale.
    //
    // SHIP_RADIUS_FACTOR: dome radius, in soldier-half-heights. Must
    // comfortably exceed the camera-to-dome-center distance below with a
    // wide safety margin, or the camera can clip through the inner wall.
    // Pulled in tighter than before to match the close, intimate cockpit
    // scale of the reference screenshot (walls close around the camera,
    // not a large distant dome).
    //
    // DOME_Y_OFFSET_FACTOR: how far to raise the dome's center ABOVE the
    // camera's fixed orbit height (in half-heights). Kept small/near-zero
    // now — the reference screenshot shows an essentially centered,
    // symmetric interior (camera near the dome's true center), so this
    // is a light touch rather than the aggressive floor-grounding
    // attempt from before.
    //
    // Both of these are exactly the values worth nudging after seeing
    // the live render, since the geometry can't be visually previewed
    // from here. Raising DOME_Y_OFFSET_FACTOR brings the floor closer
    // but eats into the camera's clearance margin — if the dome wall
    // ever looks like it's clipping into the camera during the orbit,
    // lower this first before touching anything else.
    let shipReady = false;
    let posBufShip, normBufShip, uvBufShip, idxBufShip, indexCountShip;
    let texShipBase, progShip;
    let locPosShip, locNormShip, locUVShip;
    let uModelShip, uViewShip, uProjShip, uNormalMatShip, uBaseShip;
    const SHIP_RADIUS_FACTOR = 4.0;
    const DOME_Y_OFFSET_FACTOR = 0.5;
    // Fixed 90° rotation about X — reproduces the Z-up→Y-up correction
    // baked into the source file's "Sketchfab_model" node matrix, which
    // our GLB parser never reads (see rotateX()'s comment for the full
    // derivation). Computed once since it never changes.
    //
    // NOTE: this must be -90°, not +90°. The file's own matrix maps
    // local Y→world(0,0,-1) and local Z→world(0,1,0) — worked out by
    // hand from the raw column values in the node's `matrix` array.
    // +90° produces the mirror image of that (floor/ceiling swapped),
    // which is what caused the dome to render upside-down.
    const SHIP_AXIS_CORRECTION = rotateX(-Math.PI / 2);

    // ── camera framing ──
    // Pulled in close and aimed at chest/upper-torso height for a tight
    // hero-shot crop — the legs run out below the bottom of the frame by
    // design, keeping the character large and centered rather than a
    // small full-body figure floating in the middle of the dome.
    //
    // CAMERA_FOV widened from the original 36° to actually show a good
    // amount of the dome's surrounding structure (walls, ceiling arcs)
    // rather than a tight telephoto crop of just the wall directly
    // ahead — this is the main knob for "see more of the interior".
    // CAMERA_DIST_FACTOR was pulled in further to compensate, since a
    // wider lens alone would otherwise shrink the character.
    const CAMERA_FOV = Math.PI * (58 / 180); // was 36°
    const CAMERA_DIST_FACTOR = 1.5;    // was 2.0 — closer still, compensating for the wider FOV
    const CAMERA_EYE_Y_FACTOR = 0.5;   // was 0.15 — aimed up near chest/shoulder height
    const CAMERA_LOOKAT_Y_FACTOR = 0.4; // was 0.05

    // Turns the soldier's own body to face the gate/opening in the dome
    // rather than standing in profile. This is a genuine guess at both
    // direction and amount — I have no way to see which way is "right"
    // from here, so if he ends up facing the wrong way, the fix is a
    // one-line sign/value flip on this single constant:
    //   - wrong direction entirely → negate it (SOLDIER_YAW * -1)
    //   - right way, wrong amount → adjust the multiplier on Math.PI
    //   - facing directly away → add Math.PI (flip 180°) to this value
    const SOLDIER_YAW = Math.PI / 2; // 90°, turning him to his right

    (async function init() {
      try {
        setBootProgress(2, 'Initializing render target');
        const buf = await loadWarriorGLB();

        setBootProgress(72, 'Parsing geometry');
        const model = parseGLB(buf);
        indexCount = model.indices.length;

        // bounding box -> centering + camera framing
        let minY=Infinity, maxY=-Infinity;
        for (let i = 1; i < model.positions.length; i += 3) {
          const y = model.positions[i];
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        centerY = (minY + maxY) / 2;
        halfHeight = (maxY - minY) / 2;

        // Head/face/hair starts ~16% of total height down from the top
        // of the model. v_worldPos in the shader is local Y minus
        // centerY (see modelMat below), so convert into that space.
        headWorldY = (maxY - centerY) - 0.16 * (maxY - minY);
        headBlend = (maxY - minY) * 0.05;

        setBootProgress(78, 'Decoding textures');
        const [baseImg, , normalImg, emissiveImg] = await Promise.all([0,1,2,3].map(i => loadImage(model.imageBlob(i))));

        setBootProgress(92, 'Compiling shaders');
        const vs = compile(gl.VERTEX_SHADER, VS);
        const fs = compile(gl.FRAGMENT_SHADER, FS);
        prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          throw new Error('program link error: ' + gl.getProgramInfoLog(prog));
        }
        gl.useProgram(prog);

        texBase = createTexture(baseImg);
        texNormal = createTexture(normalImg);
        texEmissive = createTexture(emissiveImg);

        posBuf  = makeBuffer(gl.ARRAY_BUFFER, model.positions);
        normBuf = makeBuffer(gl.ARRAY_BUFFER, model.normals);
        uvBuf   = makeBuffer(gl.ARRAY_BUFFER, model.uvs);
        idxBuf  = makeBuffer(gl.ELEMENT_ARRAY_BUFFER, model.indices);

        locPos  = gl.getAttribLocation(prog, 'a_pos');
        locNorm = gl.getAttribLocation(prog, 'a_normal');
        locUV   = gl.getAttribLocation(prog, 'a_uv');

        uModel = gl.getUniformLocation(prog, 'u_model');
        uView  = gl.getUniformLocation(prog, 'u_view');
        uProj  = gl.getUniformLocation(prog, 'u_proj');
        uNormalMat = gl.getUniformLocation(prog, 'u_normalMat');
        uBase  = gl.getUniformLocation(prog, 'u_base');
        uNormalTex = gl.getUniformLocation(prog, 'u_normalTex');
        uEmissive = gl.getUniformLocation(prog, 'u_emissive');
        uCamPos = gl.getUniformLocation(prog, 'u_camPos');
        uLightDir1 = gl.getUniformLocation(prog, 'u_lightDir1');
        uLightDir2 = gl.getUniformLocation(prog, 'u_lightDir2');
        uTime = gl.getUniformLocation(prog, 'u_time');
        uHeadY = gl.getUniformLocation(prog, 'u_headY');
        uHeadBlend = gl.getUniformLocation(prog, 'u_headBlend');

        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.clearColor(0, 0, 0, 0);

        setBootProgress(100, 'Render online');
        renderReady = true;
        canvas.classList.add('ready');
        boot.classList.add('done');
        if (sub) sub.textContent = 'Press and hold to spin.';
      } catch (err) {
        fallbackToPoster(err && err.message ? err.message : err);
      }
    })();

    // ── dome/ship loading (fully independent of the soldier) ──
    // Never touches renderReady/fallbackToPoster: if this fails, the
    // scene simply falls back to the flat background photo behind the
    // soldier exactly as before, with a console warning for diagnosis.
    (async function initShip() {
      try {
        const buf = await loadShipGLB();
        const shipModel = parseGLB(buf);
        indexCountShip = shipModel.indices.length;

        const shipImg = await loadImage(shipModel.imageBlob(0));

        const vsShip = compile(gl.VERTEX_SHADER, VS_SHIP);
        const fsShip = compile(gl.FRAGMENT_SHADER, FS_SHIP);
        progShip = gl.createProgram();
        gl.attachShader(progShip, vsShip);
        gl.attachShader(progShip, fsShip);
        gl.linkProgram(progShip);
        if (!gl.getProgramParameter(progShip, gl.LINK_STATUS)) {
          throw new Error('ship program link error: ' + gl.getProgramInfoLog(progShip));
        }

        texShipBase = createTexture(shipImg);

        posBufShip  = makeBuffer(gl.ARRAY_BUFFER, shipModel.positions);
        normBufShip = makeBuffer(gl.ARRAY_BUFFER, shipModel.normals);
        uvBufShip   = makeBuffer(gl.ARRAY_BUFFER, shipModel.uvs);
        idxBufShip  = makeBuffer(gl.ELEMENT_ARRAY_BUFFER, shipModel.indices);

        locPosShip  = gl.getAttribLocation(progShip, 'a_pos');
        locNormShip = gl.getAttribLocation(progShip, 'a_normal');
        locUVShip   = gl.getAttribLocation(progShip, 'a_uv');

        uModelShip = gl.getUniformLocation(progShip, 'u_model');
        uViewShip  = gl.getUniformLocation(progShip, 'u_view');
        uProjShip  = gl.getUniformLocation(progShip, 'u_proj');
        uNormalMatShip = gl.getUniformLocation(progShip, 'u_normalMat');
        uBaseShip  = gl.getUniformLocation(progShip, 'u_base');

        shipReady = true;
      } catch (err) {
        console.warn('[warrior] dome/ship not loaded, falling back to flat background:', err && err.message ? err.message : err);
      }
    })();

    // ── visibility gating (mirrors Aether Drive tabs: stop the RAF loop
    // entirely when off-screen, not just skip the draw call) ──
    let sectionVisible = false;
    const warriorIO = new IntersectionObserver(entries => {
      sectionVisible = entries[0].isIntersecting;
      if (sectionVisible) ensureRunning();
    }, { threshold: 0 });
    warriorIO.observe(section);

    // ── press-and-hold drag -> manual spin (yaw only) ──
    // Replaces the old scroll-scrub + mouse-parallax orbit entirely: the
    // model now sits at a fixed angle until the user presses/touches and
    // holds on the stage and drags horizontally, which spins it. Letting
    // go simply stops the spin wherever it is — no scroll or hover input
    // drives the camera anymore.
    let targetYaw = 0, curYaw = 0;
    let dragging = false, dragStartX = 0, dragStartYaw = 0, activePointerId = null;

    function yawFromEvent(e) {
      const dx = e.clientX - dragStartX;
      // ~360px of drag = one full turn; feels natural for both mouse and touch.
      targetYaw = dragStartYaw + (dx / 360) * Math.PI * 2;
    }
    function onPointerDown(e) {
      dragging = true;
      activePointerId = e.pointerId;
      dragStartX = e.clientX;
      dragStartYaw = targetYaw;
      stage.classList.add('dragging');
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} }
      e.preventDefault();
    }
    function onPointerMove(e) {
      if (!dragging || e.pointerId !== activePointerId) return;
      yawFromEvent(e);
    }
    function onPointerUp(e) {
      if (e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;
      stage.classList.remove('dragging');
    }
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerUp, { passive: true });

    function resizeCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }

    let rafId = null;

    function ensureRunning() {
      if (rafId === null && !contextLost && renderReady) {
        rafId = requestAnimationFrame(frame);
      }
    }

    let lastFrameT = null;
    const autoSpinSpeed = 0.16; // rad/sec — slow continuous showcase spin

    function frame(t) {
      if (contextLost) { rafId = null; return; }
      if (!sectionVisible) { rafId = null; return; }

      const dt = lastFrameT !== null ? Math.min((t - lastFrameT) / 1000, 0.1) : 0;
      lastFrameT = t;

      // Auto-spin keeps the model slowly turning on its own so it never
      // just sits frozen — but it only drives targetYaw while the user
      // isn't actively dragging, so a press-and-hold always immediately
      // takes over control, and releasing lets it resume spinning from
      // wherever it was left.
      if (!dragging && !reduceMotion) targetYaw += autoSpinSpeed * dt;

      curYaw += (targetYaw - curYaw) * dtLerp(0.12, dt);

      resizeCanvas();

      const orbitAngle = curYaw;
      const aspect = canvas.width / canvas.height || 1;

      const dist = halfHeight * CAMERA_DIST_FACTOR;
      const eyeY = halfHeight * CAMERA_EYE_Y_FACTOR;
      const lookAtY = halfHeight * CAMERA_LOOKAT_Y_FACTOR;

      // Dome center sits ABOVE the camera's fixed orbit height by
      // DOME_Y_OFFSET_FACTOR half-heights — this is what actually brings
      // the dome's floor closer to the soldier's (unmoved) feet. See the
      // comment by the constants' declaration for why this replaced an
      // earlier "shift the soldier down" attempt that had no real effect.
      const domeYOffset = halfHeight * DOME_Y_OFFSET_FACTOR;
      const domeCenterY = eyeY + domeYOffset;

      const shipRadius = halfHeight * SHIP_RADIUS_FACTOR;
      // Camera-to-dome-center distance is constant through the whole
      // orbit (only x/z swing; both camera and dome-center Y are fixed),
      // so this margin check only needs doing once, right here — not
      // something that can drift into a clipping wall at some other
      // point in the rotation.
      const camToDomeCenter = Math.sqrt(dist * dist + domeYOffset * domeYOffset);
      const far = shipReady ? Math.max(20, (camToDomeCenter + shipRadius) * 1.3) : 20;
      const proj = perspective(CAMERA_FOV, aspect, 0.1, far);

      const eye = [
        Math.sin(orbitAngle) * dist,
        eyeY,
        Math.cos(orbitAngle) * dist,
      ];
      const view = lookAt(eye, [0, lookAtY, 0], [0, 1, 0]);

      // Body-facing rotation about his own vertical axis — independent
      // of the camera orbit, which never changes which way he faces on
      // its own. This is the actual "turn him to face the gate" knob.
      const modelMat = multiply(translate([0, -centerY, 0]), rotateY(SOLDIER_YAW));
      const normalMat = new Float32Array([
        modelMat[0], modelMat[1], modelMat[2],
        modelMat[4], modelMat[5], modelMat[6],
        modelMat[8], modelMat[9], modelMat[10],
      ]);

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // ── dome, drawn first ──
      // Backface culling is disabled just for this draw: the sphere is
      // viewed from inside, and rather than gamble on which winding
      // direction this particular export used, drawing both sides of
      // this one low-poly sphere is effectively free.
      if (shipReady) {
        gl.disable(gl.CULL_FACE);
        gl.useProgram(progShip);

        gl.bindBuffer(gl.ARRAY_BUFFER, posBufShip);
        gl.enableVertexAttribArray(locPosShip);
        gl.vertexAttribPointer(locPosShip, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, normBufShip);
        gl.enableVertexAttribArray(locNormShip);
        gl.vertexAttribPointer(locNormShip, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, uvBufShip);
        gl.enableVertexAttribArray(locUVShip);
        gl.vertexAttribPointer(locUVShip, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBufShip);

        // Scale the unit sphere, apply the axis correction the source
        // file's own (ignored) node hierarchy would have applied, then
        // move it to its world position — in that order: v' = T*(R*(S*v)).
        const shipScaleRot = multiply(SHIP_AXIS_CORRECTION, scaleUniform(shipRadius));
        const modelMatShip = multiply(translate([0, domeCenterY, 0]), shipScaleRot);
        const normalMatShip = new Float32Array([
          modelMatShip[0], modelMatShip[1], modelMatShip[2],
          modelMatShip[4], modelMatShip[5], modelMatShip[6],
          modelMatShip[8], modelMatShip[9], modelMatShip[10],
        ]);

        gl.uniformMatrix4fv(uModelShip, false, modelMatShip);
        gl.uniformMatrix4fv(uViewShip, false, view);
        gl.uniformMatrix4fv(uProjShip, false, proj);
        gl.uniformMatrix3fv(uNormalMatShip, false, normalMatShip);

        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texShipBase); gl.uniform1i(uBaseShip, 0);

        gl.drawElements(gl.TRIANGLES, indexCountShip, gl.UNSIGNED_INT, 0);

        gl.enable(gl.CULL_FACE);
        gl.useProgram(prog);
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(locPos);
      gl.vertexAttribPointer(locPos, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
      gl.enableVertexAttribArray(locNorm);
      gl.vertexAttribPointer(locNorm, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.enableVertexAttribArray(locUV);
      gl.vertexAttribPointer(locUV, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

      gl.uniformMatrix4fv(uModel, false, modelMat);
      gl.uniformMatrix4fv(uView, false, view);
      gl.uniformMatrix4fv(uProj, false, proj);
      gl.uniformMatrix3fv(uNormalMat, false, normalMat);
      gl.uniform3fv(uCamPos, eye);
      // The model itself is never rotated (only the camera orbits around
      // it, via `eye` above) — so without this, two world-space-fixed
      // lights would only ever illuminate whichever side faced them at
      // orbitAngle 0, leaving the model dark and flat from every other
      // viewing angle as the camera swings around. Rotating the lights
      // by the same orbit angle keeps them oriented relative to the
      // camera, like a rig that follows the viewer around the subject.
      const lit1 = rotateYVec([0.55, 0.75, 0.85], orbitAngle);
      const lit2 = rotateYVec([-0.85, -0.1, 0.35], orbitAngle);
      gl.uniform3fv(uLightDir1, normalize3(lit1));
      gl.uniform3fv(uLightDir2, normalize3(lit2));
      gl.uniform1f(uTime, t / 1000);
      gl.uniform1f(uHeadY, headWorldY);
      gl.uniform1f(uHeadBlend, headBlend);

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texBase); gl.uniform1i(uBase, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texNormal); gl.uniform1i(uNormalTex, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texEmissive); gl.uniform1i(uEmissive, 2);

      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);

      rafId = requestAnimationFrame(frame);
    }

    // The render-ready flag flips asynchronously once loading finishes;
    // poll briefly so the loop starts the moment it's actually possible
    // rather than only on the next scroll/resize/visibility event.
    (function waitForReady() {
      if (renderReady) { ensureRunning(); return; }
      if (contextLost) return;
      setTimeout(waitForReady, 100);
    })();
  })(); } catch (e) { console.error('[NYTHERION] setupWarriorSection failed:', e); }

})();
