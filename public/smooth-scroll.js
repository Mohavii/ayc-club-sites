/* ==========================================================================
   Smooth scrolling — ported from the RBP portfolio's SmoothScroll React
   component (components/layout/smooth-scroll.tsx), same Lenis version
   (1.3.23) and same options/behavior on desktop.

   FIX (rev. 2): Lenis now runs on ALL devices, including touch/mobile.
   The previous version skipped Lenis entirely on coarse-pointer devices
   because its synthetic scroll loop was fighting native touch scroll and
   causing jank. With the canvas performance fixes in private.html (cached
   hero rect, CSS-sized canvas) that lightened the main-thread workload,
   Lenis's smoothTouch mode cooperates with native touch momentum instead
   of fighting it. touchMultiplier is kept conservative (1.5) so the
   synthetic scroll doesn't over-amplify finger velocity on phones.

   If mobile Lenis needs to be reverted, restore the isTouchDevice guard
   in init() — the rest of the file doesn't need to change.

   DESKTOP "LAG WHEN SCROLLING STOPS" FIX: the actual cause wasn't Lenis
   itself, it was pages (private.html's door-canvas hero) driving heavy
   per-tick work (canvas redraw + several DOM style writes) directly off
   raw native `scroll` events via requestAnimationFrame. While the wheel is
   moving, Lenis's synthetic scroll events fire at a smooth, even cadence,
   so that work rides along fine. The instant the gesture stops, Lenis's
   easing tail produces its last few scroll events at an uneven cadence
   (and any scroll-linked work still queued lands right as layout/paint are
   also settling), which reads as a stutter right at the stop.
   GSAP's ScrollTrigger fixes this because it doesn't react to raw scroll
   events at all — it samples scroll position once per tick from GSAP's own
   ticker (already rAF-synced) and hands out an interpolated progress value,
   decoupling scroll-linked animation from the raw event stream entirely.
   This file now loads GSAP + ScrollTrigger alongside Lenis and wires them
   together (Lenis drives the actual scroll, ScrollTrigger reads position
   through it and drives the ticker), and exposes both on `window` so that
   page-level scripts (private.html's hero) can build their own
   ScrollTrigger instances instead of listening to `scroll` directly.
   ========================================================================== */
(function () {
  var LENIS_OPTIONS = {
    duration: 1.6,
    easing: function (t) {
      return Math.min(1, 1.001 - Math.pow(2, -10 * t));
    },
    orientation: "vertical",
    gestureOrientation: "vertical",
    smoothWheel: true,
    wheelMultiplier: 1,
    // FIX: Lenis is now enabled on mobile too (was previously skipped
    // entirely for touch devices). smoothTouch lets Lenis's lerp cooperate
    // with native touch momentum instead of fighting it, and the lower
    // touchMultiplier keeps the synthetic scroll from over-amplifying
    // finger velocity on phones. Combined with the canvas performance
    // fixes (cached hero rect, CSS-sized canvas) that lightened the
    // main thread, the Lenis loop no longer causes the per-tick scroll
    // storm that made mobile lag before. Easily reversible: just set
    // smoothTouch back to false and re-add the isTouchDevice guard.
    smoothTouch: true,
    touchMultiplier: 1.5,
  };

  // Loads GSAP core + ScrollTrigger from the same CDN family as Lenis.
  // Returns a promise resolving to { gsap, ScrollTrigger }, or null if it
  // fails to load (page-level scripts fall back to their own raw-scroll
  // logic in that case, same as before this fix).
  function loadGSAP() {
    return Promise.all([
      import("https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm"),
      import("https://cdn.jsdelivr.net/npm/gsap@3.12.5/ScrollTrigger/+esm"),
    ])
      .then(function (mods) {
        var gsap = mods[0].gsap;
        var ScrollTrigger = mods[1].ScrollTrigger;
        gsap.registerPlugin(ScrollTrigger);
        return { gsap: gsap, ScrollTrigger: ScrollTrigger };
      })
      .catch(function (err) {
        console.error("GSAP/ScrollTrigger failed to load.", err);
        return null;
      });
  }

  function initLenis(Lenis, gsapBundle) {
    var lenis = new Lenis(LENIS_OPTIONS);
    var rafId;

    // With GSAP available, let GSAP's ticker (already rAF-synced) drive
    // Lenis, and tell ScrollTrigger to read scroll position through Lenis
    // instead of the native scrollTop — this is what lets ScrollTrigger's
    // sampled/interpolated progress stay decoupled from Lenis's raw
    // synthetic scroll-event cadence, which is the actual source of the
    // "stutter right when scrolling stops" symptom.
    if (gsapBundle) {
      var gsap = gsapBundle.gsap;
      var ScrollTrigger = gsapBundle.ScrollTrigger;

      lenis.on("scroll", ScrollTrigger.update);

      gsap.ticker.add(function (time) {
        lenis.raf(time * 1000);
      });
      gsap.ticker.lagSmoothing(0);

      // On touch devices, tell ScrollTrigger to ignore the resize events
      // that mobile browsers fire when the address bar shows/hides during
      // scroll — these cause unnecessary ScrollTrigger.refresh() calls
      // that briefly freeze the animation mid-swipe.
      var isTouchDevice =
        window.matchMedia &&
        window.matchMedia("(pointer: coarse) and (hover: none)").matches;
      if (isTouchDevice) {
        ScrollTrigger.config({ ignoreMobileResize: true });
      }

      window.__lenis = lenis;
      window.__gsap = gsap;
      window.__ScrollTrigger = ScrollTrigger;
      document.dispatchEvent(new CustomEvent("lenis-gsap-ready", {
        detail: { lenis: lenis, gsap: gsap, ScrollTrigger: ScrollTrigger },
      }));
    } else {
      function raf(time) {
        lenis.raf(time);
        rafId = requestAnimationFrame(raf);
      }
      rafId = requestAnimationFrame(raf);
      window.__lenis = lenis;
    }

    function handleAnchorClick(e) {
      var target = e.target;
      var anchor = target.closest && target.closest('a[href^="#"]');
      if (!anchor) return;

      var href = anchor.getAttribute("href");
      if (!href || href === "#") return;

      var element = document.querySelector(href);
      if (!element) return;

      e.preventDefault();
      lenis.scrollTo(element, { offset: -100 });
    }

    document.addEventListener("click", handleAnchorClick);

    window.addEventListener("beforeunload", function () {
      document.removeEventListener("click", handleAnchorClick);
      if (rafId) cancelAnimationFrame(rafId);
      lenis.destroy();
    });
  }

  function init() {
    var prefersReducedMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion) return;

    // FIX: Lenis now runs on ALL devices (including touch). The old
    // isTouchDevice guard that skipped Lenis on mobile has been removed.
    // With smoothTouch: true and a conservative touchMultiplier, Lenis's
    // lerp cooperates with native touch momentum instead of fighting it.
    // If this feels wrong on mobile, restore the guard:
    //   var isTouchDevice = window.matchMedia &&
    //     window.matchMedia("(pointer: coarse) and (hover: none)").matches;
    //   if (isTouchDevice) { initNativeAnchorScroll(); loadGSAP()...; return; }
    Promise.all([
      import("https://cdn.jsdelivr.net/npm/lenis@1.3.23/+esm"),
      loadGSAP(),
    ]).then(function (results) {
      initLenis(results[0].default, results[1]);
    }).catch(function (err) {
      console.error("Lenis failed to load, falling back to native scroll.", err);
    });
  }

  init();
})();
