# SpecularButton integration notes

Your project is a plain HTML/CSS/JS static site — no React, no bundler — so
the React Bits `SpecularButton` component (which needs JSX + a build step)
was ported to a small vanilla-JS module instead. Same shader, same behavior,
zero build tooling required.

## New files
- `specular-button.js` — the effect itself. Loads `ogl` straight from
  jsDelivr as an ES module (`import ... from 'https://cdn.jsdelivr.net/npm/ogl@1.0.11/src/index.js'`),
  no npm install needed.
- `specular-button.css` — supporting styles (the WebGL canvas layer + a fix
  so the glow isn't clipped by the button's existing `overflow: hidden`).

## Where it's applied
Wired into every page that shares the site's `.btn` CTA system:
`index.html`, `a-propos.html`, `valeurs.html`, `strategie.html`,
`evenements.html`, `gouvernance.html`, `partenaires.html`, `rejoindre.html`,
`contact.html`, `404.html`.

On load, the script auto-attaches to **every `.btn` element** on the page —
hero CTAs, the contact band, the "Ouvrir un club dans mon école" modal
button, form submit buttons, etc. Non-CTA controls (the nav menu toggle,
carousel arrows, back-to-top) don't carry the `.btn` class, so they're
untouched.

`private.html` and the `/portal` app use their own separate design system
and already have their own button micro-interactions, so they were left
alone — say the word if you'd like the effect there too.

Colors default per variant using your existing palette:
- `.btn-primary` / `.btn-secondary` → gold highlight (`#FFC96B`) on a navy
  base, playing off the brand gradient.
- `.btn-third` → sky-blue highlight (`#3AB8EA`) on blue-1 (`#3976BB`).
- `.btn-ghost` → sky-blue highlight on ink-soft (`#5B6480`).

Buttons automatically get a full pill radius match (clamped to their own
height), so no manual radius tuning was needed per button.

## Tuning or opting out per button
No JS required — just add data attributes to any `.btn` element in the HTML:

```html
<!-- turn it off for one button -->
<a href="contact" class="btn btn-third" data-specular="off">Nous contacter</a>

<!-- tune one button -->
<button class="btn btn-primary"
        data-specular-line="#FFC96B"
        data-specular-intensity="1.3"
        data-specular-auto="true">
  Rejoindre
</button>
```

Full list of overrides: `data-specular-line`, `data-specular-base`,
`data-specular-intensity`, `data-specular-shine-size`,
`data-specular-shine-fade`, `data-specular-thickness`, `data-specular-speed`,
`data-specular-follow`, `data-specular-proximity`, `data-specular-auto`,
`data-specular-radius`.

## Safety nets
- Respects `prefers-reduced-motion: reduce` — the effect just doesn't load.
- If WebGL2 isn't available in the visitor's browser, it fails silently and
  the button stays a completely normal, fully clickable button.
- Non-invasive: the script only adds a decorative overlay span and wraps
  existing button content in a `<span>` — no href/onclick/submit behavior is
  touched.

## Adding it to a new page
```html
<link rel="stylesheet" href="specular-button.css">
...
<script type="module" src="specular-button.js"></script>
```
That's it — any `.btn` on that page picks it up automatically.
