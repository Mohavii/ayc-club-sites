/* ==========================================================================
   Smooth scrolling — ported from the RBP portfolio's SmoothScroll React
   component (components/layout/smooth-scroll.tsx), same Lenis version
   (1.3.23) and same options/behavior on desktop.

   MOBILE FIX: Lenis's synthetic scroll loop was fighting the device's
   native touch scroll — every Lenis-driven scroll tick re-triggered the
   page's heavy scroll-linked canvas animation, so touch scrolling ended up
   both janky AND not actually smooth (touch momentum and Lenis's own lerp
   were fighting each other instead of cooperating). On a coarse-pointer /
   touch device we now skip creating the Lenis instance entirely and let
   the browser's native (already smooth, GPU-composited) touch scrolling
   handle it, with `scroll-behavior: smooth` for anchor jumps instead.
   Desktop (fine pointer / mouse+wheel) is completely untouched.

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
    touchMultiplier: 2,
  };

  // Coarse pointer (touch) + no hover = phones/tablets. Desktop trackpads
  // and mice match "fine" + "hover", so this only ever routes real touch
  // devices down the native-scroll path; PC behavior is unaffected.
  var isTouchDevice =
    window.matchMedia &&
    window.matchMedia("(pointer: coarse) and (hover: none)").matches;

  function initNativeAnchorScroll() {
    // Same anchor-jump behavior as the Lenis path (href^="#", -100 offset),
    // just driven by the browser's own smooth-scroll instead of Lenis, so
    // link clicks still ease nicely without Lenis re-processing every
    // native touch scroll event on the way there.
    document.documentElement.style.scrollBehavior = "smooth";

    function handleAnchorClick(e) {
      var target = e.target;
      var anchor = target.closest && target.closest('a[href^="#"]');
      if (!anchor) return;

      var href = anchor.getAttribute("href");
      if (!href || href === "#") return;

      var element = document.querySelector(href);
      if (!element) return;

      e.preventDefault();
      var top =
        element.getBoundingClientRect().top + window.scrollY - 100;
      window.scrollTo({ top: top, behavior: "smooth" });
    }

    document.addEventListener("click", handleAnchorClick);
  }

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

    if (isTouchDevice) {
      // No Lenis on touch devices: native scroll is already smooth there
      // and avoids the scroll-event storm that was causing the lag.
      // Still load GSAP/ScrollTrigger so pages like private.html can use
      // ScrollTrigger's own scrub (decoupled from raw touch scroll events
      // the same way) instead of a manual scroll listener.
      initNativeAnchorScroll();
      loadGSAP().then(function (gsapBundle) {
        if (!gsapBundle) return;
        gsapBundle.ScrollTrigger.config({ ignoreMobileResize: true });
        window.__gsap = gsapBundle.gsap;
        window.__ScrollTrigger = gsapBundle.ScrollTrigger;
        document.dispatchEvent(new CustomEvent("lenis-gsap-ready", {
          detail: { lenis: null, gsap: gsapBundle.gsap, ScrollTrigger: gsapBundle.ScrollTrigger },
        }));
      });
      return;
    }

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
