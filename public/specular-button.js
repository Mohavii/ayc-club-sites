/*!
 * SpecularButton — vanilla JS / WebGL port of the React Bits "SpecularButton"
 * component, adapted for a plain HTML/CSS/JS site with no build step.
 *
 * The visual/shader logic is a 1:1 port of the original React component;
 * only the React lifecycle (hooks/props) has been replaced with a small
 * DOM-based controller.
 *
 * Setup (already wired into every page of this site):
 *   <link rel="stylesheet" href="specular-button.css">
 *   <script type="module" src="specular-button.js"></script>
 *
 * Behaviour:
 *   - Auto-attaches to every `.btn` element on the page (the site's shared
 *     CTA button class) once the DOM is ready.
 *   - Skips entirely if the visitor has "prefers-reduced-motion: reduce" set,
 *     or if WebGL2 isn't available — buttons just fall back to their normal
 *     look, nothing breaks.
 *   - Colors default per button variant (.btn-primary / .btn-secondary /
 *     .btn-third / .btn-ghost) using the site's palette, but can be tuned
 *     (or turned off) per button straight from HTML — see below.
 *
 * Per-button HTML overrides (all optional):
 *   data-specular="off"            opt this button out entirely
 *   data-specular-line="#hex"      moving highlight color
 *   data-specular-base="#hex"      static edge stroke color
 *   data-specular-intensity="1"    highlight brightness
 *   data-specular-shine-size="10"  streak size in degrees
 *   data-specular-shine-fade="40"  streak fade in degrees
 *   data-specular-thickness="1"    highlight line width (px)
 *   data-specular-speed="0.35"     idle sweep speed
 *   data-specular-follow="true"    point highlight at the cursor
 *   data-specular-proximity="260"  px radius the glow fades in within
 *   data-specular-auto="false"     keep the sweep always on
 *   data-specular-radius="999"     corner radius in px (999 = auto pill)
 *
 * Programmatic use (e.g. for a dynamically-inserted button):
 *   import { createSpecularButton } from './specular-button.js';
 *   const fx = createSpecularButton(document.querySelector('#my-btn'));
 *   // fx.destroy() to remove it later
 */

import { Renderer, Program, Mesh, Triangle, Color } from 'https://cdn.jsdelivr.net/npm/ogl@1.0.11/src/index.js';

const PAD = 20;

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uCenter;
uniform vec2 uHalfSize;
uniform float uRadius;
uniform float uAngle;
uniform float uPx;
uniform vec3 uLineColor;
uniform vec3 uBaseColor;
uniform float uIntensity;
uniform float uShineSize;
uniform float uShineFade;
uniform float uThickness;
uniform float uBaseWidth;

out vec4 fragColor;

float sdRoundedRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float shapeSDF(vec2 p) { return sdRoundedRect(p, uHalfSize, uRadius); }

float gaussianLine(float d, float sigma) {
  float x = d / (sigma + 1e-6);
  float k = mix(1.0, 1.6, smoothstep(0.0, 1.5, x));
  return exp(-k * x * x);
}

void main() {
  vec2 p = gl_FragCoord.xy - uCenter;
  float d = shapeSDF(p);
  vec2 L = vec2(cos(uAngle), sin(uAngle));

  // Dark base stroke hugging the edge for a sense of thickness
  float base = (1.0 - smoothstep(0.0, uBaseWidth, abs(d))) * 0.45;

  // Symmetric specular: the edges facing toward/away from the light both
  // catch a streak. The angular window (size + fade) is measured with an
  // elliptical normal so it varies continuously along straight edges.
  vec2 nEll = normalize(p / (uHalfSize * uHalfSize) + 1e-6);
  float phi = acos(clamp(abs(dot(nEll, L)), 0.0, 1.0));
  float rim = 1.0 - smoothstep(uShineSize - uShineFade, uShineSize + uShineFade + 1e-4, phi);
  float line = gaussianLine(d, uThickness);
  float edgeClamp = 1.0 - smoothstep(0.5 * uPx, 3.0 * uPx, abs(d));
  float hi = line * rim * edgeClamp * uIntensity;

  vec3 col = uBaseColor * base + uLineColor * hi;
  float a = clamp(base + hi, 0.0, 1.0);
  fragColor = vec4(col, a);
}
`;

// Default line/base colors per the site's existing .btn variants
// (theme.css / home.css palette: navy/blue brand gradient + gold accent).
const VARIANT_DEFAULTS = {
  primary: { lineColor: '#FFC96B', baseColor: '#1C2038' },
  secondary: { lineColor: '#FFC96B', baseColor: '#1C2038' },
  third: { lineColor: '#3AB8EA', baseColor: '#3976BB' },
  ghost: { lineColor: '#3AB8EA', baseColor: '#5B6480' }
};

function variantFor(el) {
  if (el.classList.contains('btn-primary')) return 'primary';
  if (el.classList.contains('btn-secondary')) return 'secondary';
  if (el.classList.contains('btn-third')) return 'third';
  if (el.classList.contains('btn-ghost')) return 'ghost';
  return 'primary';
}

function num(el, key, fallback) {
  const v = el.dataset[key];
  return v === undefined || v === '' ? fallback : parseFloat(v);
}
function str(el, key, fallback) {
  const v = el.dataset[key];
  return v === undefined || v === '' ? fallback : v;
}
function bool(el, key, fallback) {
  const v = el.dataset[key];
  return v === undefined ? fallback : v !== 'false';
}

/**
 * Attach the specular WebGL effect to a single element (button or link).
 * Returns a controller with `.destroy()`, or `null` if WebGL2 isn't
 * available (the element is left untouched in that case).
 */
export function createSpecularButton(el, userOptions = {}) {
  if (!el || el.__specularButton) return el ? el.__specularButton : null;

  const d = VARIANT_DEFAULTS[variantFor(el)];
  const base = {
    radius: 999,
    lineColor: d.lineColor,
    baseColor: d.baseColor,
    intensity: 1,
    shineSize: 10,
    shineFade: 40,
    thickness: 1,
    speed: 0.35,
    followMouse: true,
    proximity: 260,
    autoAnimate: false,
    ...userOptions
  };

  const opts = {
    radius: num(el, 'specularRadius', base.radius),
    lineColor: str(el, 'specularLine', base.lineColor),
    baseColor: str(el, 'specularBase', base.baseColor),
    intensity: num(el, 'specularIntensity', base.intensity),
    shineSize: num(el, 'specularShineSize', base.shineSize),
    shineFade: num(el, 'specularShineFade', base.shineFade),
    thickness: num(el, 'specularThickness', base.thickness),
    speed: num(el, 'specularSpeed', base.speed),
    followMouse: bool(el, 'specularFollow', base.followMouse),
    proximity: num(el, 'specularProximity', base.proximity),
    autoAnimate: bool(el, 'specularAuto', base.autoAnimate)
  };

  // Wrap existing content so it stays above the fx canvas (z-index layering
  // mirrors the original component's <span class="specular-button__label">).
  if (!el.querySelector(':scope > .specular-button__label')) {
    const label = document.createElement('span');
    label.className = 'specular-button__label';
    while (el.firstChild) label.appendChild(el.firstChild);
    el.appendChild(label);
  }

  const fx = document.createElement('span');
  fx.className = 'specular-button__fx';
  fx.setAttribute('aria-hidden', 'true');
  el.insertBefore(fx, el.firstChild);
  el.classList.add('specular-enhanced');

  let renderer;
  let program;
  let mesh;
  let ro;
  let raf = 0;
  let removePointerListener = () => {};
  let destroyed = false;

  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: true, dpr });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const geometry = new Triangle(gl);
    if (geometry.attributes.uv) delete geometry.attributes.uv;

    program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uCenter: { value: [0, 0] },
        uHalfSize: { value: [1, 1] },
        uRadius: { value: 0 },
        uAngle: { value: 2.4 },
        uPx: { value: dpr },
        uLineColor: { value: [1, 1, 1] },
        uBaseColor: { value: [0.32, 0.32, 0.32] },
        uIntensity: { value: 1 },
        uShineSize: { value: 0.17 },
        uShineFade: { value: 0.7 },
        uThickness: { value: 1 },
        uBaseWidth: { value: dpr }
      }
    });

    mesh = new Mesh(gl, { geometry, program });
    fx.appendChild(gl.canvas);

    const size = { w: 1, h: 1 };
    const resize = () => {
      const rect = el.getBoundingClientRect();
      size.w = rect.width;
      size.h = rect.height;
      renderer.setSize(rect.width + PAD * 2, rect.height + PAD * 2);
      program.uniforms.uCenter.value = [(PAD + rect.width / 2) * dpr, (PAD + rect.height / 2) * dpr];
      program.uniforms.uHalfSize.value = [(rect.width / 2) * dpr, (rect.height / 2) * dpr];
    };
    ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let pointerAngle = null;
    let proximityT = 0;
    const onPointerMove = e => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = Math.max(rect.left - e.clientX, 0, e.clientX - rect.right);
      const dy = Math.max(rect.top - e.clientY, 0, e.clientY - rect.bottom);
      const dist = Math.hypot(dx, dy);
      if (dist === 0) {
        const nx = (e.clientX - cx) / (rect.width / 2);
        const ny = (cy - e.clientY) / (rect.height / 2);
        pointerAngle = Math.atan2(2 / rect.height, -2 / rect.width) + nx * 0.3 + ny * 0.15;
      } else {
        pointerAngle = Math.atan2(cy - e.clientY, e.clientX - cx);
      }
      const t = Math.max(0, 1 - dist / Math.max(opts.proximity, 1));
      proximityT = t * t * (3 - 2 * t);
    };
    window.addEventListener('pointermove', onPointerMove);
    removePointerListener = () => window.removeEventListener('pointermove', onPointerMove);

    let angle = 2.4;
    let idleAngle = 2.4;
    let bright = 0;
    let last = performance.now();
    const lineC = new Color();
    const baseC = new Color();

    const update = now => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      idleAngle += opts.speed * dt;
      const steer = opts.followMouse && pointerAngle != null && (!opts.autoAnimate || proximityT > 0);
      const target = steer ? pointerAngle : idleAngle;
      const diff = ((target - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      angle += diff * (1 - Math.exp(-dt * 7));

      const brightTarget = opts.autoAnimate ? 1 : proximityT;
      bright += (brightTarget - bright) * (1 - Math.exp(-dt * 8));

      lineC.set(opts.lineColor);
      baseC.set(opts.baseColor);
      program.uniforms.uAngle.value = angle;
      program.uniforms.uRadius.value = Math.min(opts.radius, Math.min(size.w, size.h) / 2) * dpr;
      program.uniforms.uLineColor.value = [lineC.r, lineC.g, lineC.b];
      program.uniforms.uBaseColor.value = [baseC.r, baseC.g, baseC.b];
      program.uniforms.uIntensity.value = opts.intensity * bright;
      program.uniforms.uShineSize.value = (opts.shineSize * Math.PI) / 180;
      program.uniforms.uShineFade.value = (opts.shineFade * Math.PI) / 180;
      program.uniforms.uThickness.value = opts.thickness * dpr;
      renderer.render({ scene: mesh });
    };
    raf = requestAnimationFrame(update);
  } catch (err) {
    // No WebGL2 (or something else went wrong) — leave the button as a
    // normal, fully-functional button with no visual effect.
    console.warn('SpecularButton: skipping effect (WebGL2 unavailable?)', err);
    fx.remove();
    el.classList.remove('specular-enhanced');
    return null;
  }

  const controller = {
    el,
    options: opts,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      removePointerListener();
      const gl = renderer.gl;
      if (gl.canvas.parentNode === fx) fx.removeChild(gl.canvas);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      fx.remove();
      el.classList.remove('specular-enhanced');
      el.__specularButton = null;
    }
  };
  el.__specularButton = controller;
  return controller;
}

/**
 * Attach the effect to every element matching `selector` (default: every
 * `.btn` on the page — the site's shared CTA button class). Respects
 * `prefers-reduced-motion` and `data-specular="off"`.
 */
export function initSpecularButtons(selector = '.btn', options = {}) {
  const reduceMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return [];

  const controllers = [];
  document.querySelectorAll(selector).forEach(el => {
    if (el.dataset.specular === 'off') return;
    const c = createSpecularButton(el, options);
    if (c) controllers.push(c);
  });
  return controllers;
}

if (typeof document !== 'undefined') {
  const boot = () => initSpecularButtons();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
