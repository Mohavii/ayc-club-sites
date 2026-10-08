(() => {
  'use strict';

  // ---- Frame geometry (in pixels of frame.png, which is 1254 x 1254) ----
  // The photo is clipped to a circle that is a little larger than the opening of
  // the ring, so its edges tuck neatly underneath the frame artwork.
  // If you swap in a different frame, adjust these numbers.
  const FRAME_SIZE = 1254;
  const CIRCLE = { x: 616.5, y: 593.5, r: 525 };

  const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 Mo
  const MAX_ZOOM = 4;                      // 400 %

  // At 100 % zoom the photo already fills the whole ring (like CSS "cover").
  // Everything outside the ring (the corners of the square) is a blurred,
  // enlarged copy of the same photo.
  const BLUR_PX = 38;
  const SUPPORTS_FILTER = typeof CanvasRenderingContext2D !== 'undefined' &&
    'filter' in CanvasRenderingContext2D.prototype;

  // In-app browsers (Facebook, Instagram, TikTok...) often ignore file downloads,
  // so there we hand the image to the system share sheet instead.
  const IN_APP_BROWSER = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|TikTok|Snapchat|; wv\)/i
    .test(navigator.userAgent);
  const IS_TOUCH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  const FONT = 'Outfit, system-ui, "Segoe UI", Arial, sans-serif';

  const TEXT = {
    hintEmpty: 'Appuie sur l’aperçu ou dépose une photo dessus pour commencer.',
    hintLoaded: IS_TOUCH
      ? 'Pince avec deux doigts pour zoomer, glisse pour placer ta photo dans le cadre.'
      : 'Zoome avec le curseur ou la molette, puis fais glisser ta photo pour la placer dans le cadre.',
    hintDone: 'Téléchargement lancé. Retrouve ton image dans tes téléchargements ou ta galerie.',
    notImage: 'Ce fichier n’est pas une image. Choisis un PNG, JPG, WEBP ou GIF.',
    tooBig: 'Cette image dépasse 15 Mo. Choisis-en une plus légère.',
    unreadable: 'Impossible de lire cette image. Essaie un autre fichier.',
    frameError: 'Impossible de charger le cadre. Recharge la page.',
    blobError: 'Impossible de créer le fichier. Essaie avec une image plus petite.',
    blocked: 'Ton navigateur a bloqué le téléchargement. Ouvre cette page dans Chrome ou Safari.',
    placeholderTitle: 'Choisis ta photo',
    placeholderSub: 'Appuie ici ou dépose un fichier',
    shareTitle: 'Mon cadre Youth Impact',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    file: $('file'),
    dropzone: $('dropzone'),
    canvas: $('canvas'),
    hint: $('hint'),
    error: $('error'),
    panel: $('panel'),
    zoom: $('zoom'),
    zoomOut: $('zoom-out'),
    recenter: $('recenter'),
    pick: $('pick'),
    download: $('download'),
    change: $('change'),
  };

  els.canvas.width = FRAME_SIZE;
  els.canvas.height = FRAME_SIZE;
  const ctx = els.canvas.getContext('2d');

  // The frame (frame.png) sits next to this script and is served from the same
  // origin as the page, so the canvas can be exported. Resolving it from the
  // script's own URL keeps it working wherever the site is hosted.
  const SCRIPT_URL = document.currentScript ? document.currentScript.src : '';
  const frame = new Image();
  let frameReady = false;
  frame.onload = () => { frameReady = true; render(); };
  frame.onerror = () => showError(TEXT.frameError);
  frame.src = SCRIPT_URL ? new URL('frame.png', SCRIPT_URL).href : 'cadre-assets/frame.png';

  let image = null;
  let background = null; // pre-blurred copy of the photo, built once per upload
  let baseName = 'profile';
  let zoom = 1;
  let offX = 0;
  let offY = 0;

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = !message;
  }

  // ---- Loading a photo ----
  function loadFile(file) {
    showError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showError(TEXT.notImage);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showError(TEXT.tooBig);
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      image = img;
      background = makeBackground(img);
      baseName = file.name.replace(/\.[^.]+$/, '') || 'profile';
      setZoom(1);
      offX = 0;
      offY = 0;
      setLoadedState(true);
      render();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showError(TEXT.unreadable);
    };
    img.src = url;
  }

  function setLoadedState(loaded) {
    els.dropzone.classList.toggle('has-image', loaded);
    els.panel.classList.toggle('is-empty', !loaded);
    els.zoom.disabled = !loaded;
    els.recenter.disabled = !loaded;
    els.pick.hidden = loaded;
    els.download.hidden = !loaded;
    els.change.hidden = !loaded;
    els.hint.textContent = loaded ? TEXT.hintLoaded : TEXT.hintEmpty;
    document.body.dataset.step = loaded ? '2' : '1';
  }

  function setZoom(value) {
    zoom = clamp(value, 1, MAX_ZOOM);
    const pct = Math.round(zoom * 100);
    els.zoom.value = String(pct);
    els.zoomOut.textContent = `${pct} %`;
  }

  // ---- Drawing ----
  // A blurred, enlarged copy of the photo that covers the WHOLE square canvas, so
  // everything outside the ring is blurred. Rendered once per upload so dragging
  // and zooming stay smooth.
  function makeBackground(img) {
    const c = document.createElement('canvas');
    c.width = FRAME_SIZE;
    c.height = FRAME_SIZE;
    const g = c.getContext('2d');

    // "Cover" the canvas, with extra margin so the blur never fades out at the edges.
    const side = FRAME_SIZE * 1.25;
    const s = side / Math.min(img.naturalWidth, img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    const x = (FRAME_SIZE - w) / 2;
    const y = (FRAME_SIZE - h) / 2;

    g.imageSmoothingQuality = 'high';
    if (SUPPORTS_FILTER) {
      g.filter = `blur(${BLUR_PX}px)`;
      g.drawImage(img, x, y, w, h);
      g.filter = 'none';
    } else {
      // Fallback for browsers without canvas filters: shrink, then stretch back up.
      const small = document.createElement('canvas');
      const k = 40 / FRAME_SIZE;
      small.width = 40;
      small.height = 40;
      const sg = small.getContext('2d');
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(img, x * k, y * k, w * k, h * k);
      g.drawImage(small, 0, 0, FRAME_SIZE, FRAME_SIZE);
    }
    return c;
  }

  // Where the sharp photo is drawn. At 100 % it covers the whole ring circle
  // (no empty space); zooming in makes it bigger from there.
  function photoRect() {
    const side = CIRCLE.r * 2;
    const base = side / Math.min(image.naturalWidth, image.naturalHeight);
    const scale = base * zoom;
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;

    // Keep the photo from being dragged off the circle.
    const maxX = Math.max(0, (w - side) / 2);
    const maxY = Math.max(0, (h - side) / 2);
    offX = clamp(offX, -maxX, maxX);
    offY = clamp(offY, -maxY, maxY);

    return { x: CIRCLE.x + offX - w / 2, y: CIRCLE.y + offY - h / 2, w, h };
  }

  function drawPlaceholder() {
    const cx = CIRCLE.x;
    const cy = CIRCLE.y;
    ctx.fillStyle = '#e8effb';
    ctx.fillRect(0, 0, FRAME_SIZE, FRAME_SIZE);

    // Yellow "+" badge
    ctx.fillStyle = '#ffd21f';
    ctx.beginPath();
    ctx.arc(cx, cy - 110, 78, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0a2a8a';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 30, cy - 110);
    ctx.lineTo(cx + 30, cy - 110);
    ctx.moveTo(cx, cy - 140);
    ctx.lineTo(cx, cy - 80);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0a2a8a';
    ctx.font = `700 64px ${FONT}`;
    ctx.fillText(TEXT.placeholderTitle, cx, cy + 40);
    ctx.fillStyle = '#4a5f8f';
    ctx.font = `400 38px ${FONT}`;
    ctx.fillText(TEXT.placeholderSub, cx, cy + 105);
  }

  function render() {
    ctx.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);

    if (image) {
      // 1. Blurred photo over the whole square (this is what shows outside the ring).
      ctx.drawImage(background, 0, 0);

      // 2. Sharp photo, clipped to the ring opening.
      ctx.save();
      ctx.beginPath();
      ctx.arc(CIRCLE.x, CIRCLE.y, CIRCLE.r, 0, Math.PI * 2);
      ctx.clip();
      const r = photoRect();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, r.x, r.y, r.w, r.h);
      ctx.restore();
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.arc(CIRCLE.x, CIRCLE.y, CIRCLE.r, 0, Math.PI * 2);
      ctx.clip();
      drawPlaceholder();
      ctx.restore();
    }

    // 3. The frame goes on top of everything.
    if (frameReady) ctx.drawImage(frame, 0, 0, FRAME_SIZE, FRAME_SIZE);
  }

  // Canvas text needs the font to be loaded before it is drawn.
  if (document.fonts && document.fonts.load) {
    Promise.all([
      document.fonts.load(`700 64px ${FONT}`),
      document.fonts.load(`400 38px ${FONT}`),
    ]).then(render).catch(() => {});
  }

  // ---- Download ----
  function markDone() {
    document.body.dataset.step = '3';
    els.hint.textContent = TEXT.hintDone;
  }

  function download() {
    if (!image) return;
    try {
      els.canvas.toBlob(async (blob) => {
        if (!blob) {
          showError(TEXT.blobError);
          return;
        }
        const filename = `${baseName}-youth-impact.png`;

        if (IN_APP_BROWSER && navigator.canShare) {
          const file = new File([blob], filename, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            try {
              await navigator.share({ files: [file], title: TEXT.shareTitle });
              markDone();
              return;
            } catch (err) {
              if (err && err.name === 'AbortError') return; // closed the share sheet
              // anything else: fall back to a normal download below
            }
          }
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        markDone();
      }, 'image/png');
    } catch (err) {
      showError(TEXT.blocked);
    }
  }

  // ---- Events: picking and dropping a file ----
  const openPicker = () => els.file.click();
  els.pick.addEventListener('click', openPicker);
  els.change.addEventListener('click', openPicker);

  els.file.addEventListener('change', () => {
    const file = els.file.files[0];
    els.file.value = ''; // lets the same file be chosen again later
    loadFile(file);
  });

  // Once a photo is loaded, tapping the preview should not reopen the picker.
  els.dropzone.addEventListener('click', (e) => {
    if (image) e.preventDefault();
  });
  els.dropzone.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !image) {
      e.preventDefault();
      openPicker();
    }
  });

  ['dragenter', 'dragover'].forEach((type) =>
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove('dragover');
    })
  );
  els.dropzone.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

  // ---- Events: moving the photo (one finger / mouse) and pinching (two fingers) ----
  const pointers = new Map();
  let gesture = null;

  function startGesture() {
    const pts = Array.from(pointers.values());
    if (pts.length === 1) {
      gesture = { type: 'drag', x: pts[0].x, y: pts[0].y, offX, offY };
    } else if (pts.length >= 2) {
      gesture = {
        type: 'pinch',
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        zoom,
      };
    } else {
      gesture = null;
    }
  }

  els.canvas.addEventListener('pointerdown', (e) => {
    if (!image) return;
    els.canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
    els.canvas.classList.add('dragging');
  });

  els.canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.type === 'drag') {
      // Convert screen pixels to canvas pixels (the preview is scaled by CSS).
      const k = FRAME_SIZE / els.canvas.getBoundingClientRect().width;
      offX = gesture.offX + (e.clientX - gesture.x) * k;
      offY = gesture.offY + (e.clientY - gesture.y) * k;
    } else {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      setZoom(gesture.zoom * (dist / gesture.dist));
    }
    render();
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    startGesture();
    if (!pointers.size) els.canvas.classList.remove('dragging');
  };
  els.canvas.addEventListener('pointerup', endPointer);
  els.canvas.addEventListener('pointercancel', endPointer);

  els.canvas.addEventListener('wheel', (e) => {
    if (!image) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
    render();
  }, { passive: false });

  // ---- Events: controls ----
  els.zoom.addEventListener('input', () => {
    setZoom(Number(els.zoom.value) / 100);
    render();
  });
  els.recenter.addEventListener('click', () => {
    setZoom(1);
    offX = 0;
    offY = 0;
    render();
  });
  els.download.addEventListener('click', download);

  setLoadedState(false);
  render();
})();
