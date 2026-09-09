/* ==========================================================================
   Smooth scrolling — ported 1:1 from the RBP portfolio's SmoothScroll
   React component (components/layout/smooth-scroll.tsx), same Lenis
   version (1.3.23) and same options/behavior, adapted for a plain
   static HTML site (no bundler, so Lenis is loaded from a CDN as an
   ES module instead of `import Lenis from "lenis"`).
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

  function init(Lenis) {
    var prefersReducedMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion) return;

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

  import("https://cdn.jsdelivr.net/npm/lenis@1.3.23/+esm")
    .then(function (mod) {
      init(mod.default);
    })
    .catch(function (err) {
      console.error("Lenis failed to load, falling back to native scroll.", err);
    });
})();
