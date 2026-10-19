/* ==========================================================================
   Smooth anchor scrolling with a real cubic-bezier easing curve.

   Native `scroll-behavior:smooth` (used previously in theme.css) is animated
   by the browser itself, and most browsers use a roughly linear/ease-out
   curve that can't be customized — it always feels a bit mechanical.

   This replaces it with a rAF-driven scroll that eases with the same
   cubic-bezier curve already used for the site's other motion
   (--ease: cubic-bezier(.22,1,.36,1)), so anchor-link scrolling feels
   consistent with the rest of the UI: a quick start and a soft, gradual
   settle at the end instead of a constant speed.
   ========================================================================== */
(function(){
  // Respect reduced-motion preference — jump instantly, no animation.
  var prefersReducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Disable the browser's native smooth scroll so it doesn't fight with ours.
  document.documentElement.style.scrollBehavior = 'auto';

  // cubic-bezier(.22,1,.36,1) — same curve as --ease in theme.css.
  function cubicBezier(p1x, p1y, p2x, p2y){
    function a(a1,a2){ return 1.0 - 3.0*a2 + 3.0*a1; }
    function b(a1,a2){ return 3.0*a2 - 6.0*a1; }
    function c(a1){ return 3.0*a1; }

    function calcBezier(t, a1, a2){
      return ((a(a1,a2)*t + b(a1,a2))*t + c(a1))*t;
    }
    function calcSlope(t, a1, a2){
      return 3.0*a(a1,a2)*t*t + 2.0*b(a1,a2)*t + c(a1);
    }
    function getTForX(x){
      var t = x;
      for (var i = 0; i < 8; i++){
        var slope = calcSlope(t, p1x, p2x);
        if (Math.abs(slope) < 1e-6) break;
        var xEst = calcBezier(t, p1x, p2x) - x;
        t -= xEst / slope;
      }
      return t;
    }
    return function(x){
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return calcBezier(getTForX(x), p1y, p2y);
    };
  }

  var ease = cubicBezier(0.22, 1, 0.36, 1);

  function getScrollPaddingTop(){
    var val = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    return val;
  }

  function smoothScrollTo(targetY, duration){
    duration = duration || 700;
    var startY = window.pageYOffset;
    var distance = targetY - startY;
    var startTime = null;

    if (prefersReducedMotion){
      window.scrollTo(0, targetY);
      return;
    }

    function step(timestamp){
      if (startTime === null) startTime = timestamp;
      var elapsed = timestamp - startTime;
      var progress = Math.min(elapsed / duration, 1);
      var eased = ease(progress);
      window.scrollTo(0, startY + distance * eased);
      if (progress < 1){
        requestAnimationFrame(step);
      }
    }
    requestAnimationFrame(step);
  }

  function resolveTargetY(hash){
    if (!hash || hash === '#') return 0;
    var el;
    try {
      el = document.getElementById(decodeURIComponent(hash.slice(1)));
    } catch(e) {
      el = document.getElementById(hash.slice(1));
    }
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    var absoluteY = rect.top + window.pageYOffset;
    var scrollMarginTop = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    var offset = scrollMarginTop || getScrollPaddingTop();
    return absoluteY - offset;
  }

  document.addEventListener('click', function(e){
    var link = e.target.closest && e.target.closest('a[href*="#"]');
    if (!link) return;

    var url;
    try { url = new URL(link.href, window.location.href); }
    catch(e) { return; }

    // Only handle same-page anchor links.
    if (url.pathname !== window.location.pathname || url.origin !== window.location.origin) return;
    if (!url.hash) return;

    var targetY = resolveTargetY(url.hash);
    if (targetY === null) return; // target not found on this page — let default happen

    e.preventDefault();
    smoothScrollTo(Math.max(targetY, 0));
    if (history.pushState){
      history.pushState(null, '', url.hash);
    }
  }, false);

  // Handle direct loads / refresh with a hash already in the URL.
  if (window.location.hash){
    window.addEventListener('load', function(){
      var targetY = resolveTargetY(window.location.hash);
      if (targetY !== null){
        // Jump instantly on load (matches prior native behavior), then
        // future clicks use the eased animation.
        window.scrollTo(0, Math.max(targetY, 0));
      }
    });
  }
})();
