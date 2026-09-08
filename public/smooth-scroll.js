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

  function initLenis(Lenis) {
    var lenis = new Lenis(LENIS_OPTIONS);
    var rafId;

    function raf(time) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }
    rafId = requestAnimationFrame(raf);

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
      cancelAnimationFrame(rafId);
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
      initNativeAnchorScroll();
      return;
    }

    import("https://cdn.jsdelivr.net/npm/lenis@1.3.23/+esm")
      .then(function (mod) {
        initLenis(mod.default);
      })
      .catch(function (err) {
        console.error("Lenis failed to load, falling back to native scroll.", err);
      });
  }

  init();
})();
