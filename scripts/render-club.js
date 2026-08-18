// render-club.js
// Turns one club's JSON data into the club's public HTML page, using the
// exact same markup/classes as club-exemple.html so the design never drifts.
//
// This file is intentionally plain, heavily-commented JS — no framework —
// so it's easy to open and understand later even without a dev background.

const AXIS_ICONS = {
  "Citoyenneté": "citoyennete.png",
  "Santé": "sante.png",
  "Scolarité": "scolarite.png",
  "Éducation formelle": "education-formelle.png",
  "Vie active": "vie-active.png",
};

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDateBadge(isoDate) {
  // "2026-03-14" -> { day: "14", month: "MARS" }
  if (!isoDate) return { day: "--", month: "---" };
  const months = ["JANV", "FÉVR", "MARS", "AVR", "MAI", "JUIN", "JUIL", "AOÛT", "SEPT", "OCT", "NOV", "DÉC"];
  const d = new Date(isoDate + "T00:00:00");
  if (isNaN(d.getTime())) return { day: "--", month: "---" };
  return { day: String(d.getDate()).padStart(2, "0"), month: months[d.getMonth()] };
}

function renderEventCard(evt) {
  const badge = evt.date ? formatDateBadge(evt.date) : null;
  const photoBlock = evt.image
    ? `<img src="${escapeHtml(evt.image)}" alt="${escapeHtml(evt.title)}" class="event-media-img">`
    : `<div class="event-media-ph">
         <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
         <span>Photo à venir</span>
       </div>`;

  return `
          <article class="event-card rail-card">
            <div class="event-media">
              ${photoBlock}
              ${badge ? `<div class="event-date-badge"><b>${escapeHtml(badge.day)}</b><span>${escapeHtml(badge.month)}</span></div>` : ""}
            </div>
            <div class="event-body">
              <span class="event-axis">${escapeHtml(evt.axis || "")}</span>
              <h3>${escapeHtml(evt.title)}</h3>
              <p>${escapeHtml(evt.description || "")}</p>
              <div class="event-meta">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                ${escapeHtml(evt.location || "")}
              </div>
            </div>
          </article>`;
}

function renderTeamCard(member) {
  const photoBlock = member.photo
    ? `<div class="team-photo">
         <img src="${escapeHtml(member.photo)}" alt="${escapeHtml(member.name)}" class="team-photo-img">
       </div>`
    : `<div class="team-photo" role="img" aria-label="Photo à venir — ${escapeHtml(member.role)}">
         <svg class="team-photo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>
         <span class="team-photo-label">Photo à venir</span>
       </div>`;

  return `
          <div class="team-card rail-card">
            ${photoBlock}
            <div class="team-role">${escapeHtml(member.role)}</div>
            <h3>${escapeHtml(member.name)}</h3>
            <p>${escapeHtml(member.description || "")}</p>
          </div>`;
}

function renderPartnerCard(partner) {
  return `
      <div class="gov-card">
        <span class="gov-tag">Partenaire local</span>
        <h3>${escapeHtml(partner.name)}</h3>
        <p>${escapeHtml(partner.description || "")}</p>
      </div>`;
}

function renderHistoryItem(item) {
  return `
      <div class="h-item">
        <div class="h-year">${escapeHtml(item.period)}</div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.text)}</p>
      </div>`;
}

function renderClubPage(club) {
  const name = club.name || "[Nom de l'établissement]";
  const events = club.events || [];
  const bel = club.bel || [];
  const partners = club.partners || [];
  const history = club.history || [];

  const heroImageStyle = club.heroImage
    ? ` style="background-image:url('${escapeHtml(club.heroImage)}')"`
    : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YOUTH CLUB · ${escapeHtml(name)}</title>
<meta name="description" content="Le YOUTH CLUB de ${escapeHtml(name)} : événements locaux, Bureau Exécutif Local et partenaires du club.">
<link rel="icon" type="image/png" href="../../assets/favicon-32.png" sizes="32x32">
<link rel="icon" type="image/png" href="../../assets/favicon-16.png" sizes="16x16">
<link rel="icon" type="image/png" href="../../assets/favicon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="../../assets/apple-touch-icon.png">
<link rel="shortcut icon" href="../../assets/favicon.ico">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Association YOUTH CLUBs">
<meta property="og:title" content="YOUTH CLUB · ${escapeHtml(name)}">
<meta property="og:description" content="Le YOUTH CLUB de ${escapeHtml(name)} : événements locaux, Bureau Exécutif Local et partenaires du club.">
<meta property="og:image" content="../../assets/og-image.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="fr_FR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="YOUTH CLUB · ${escapeHtml(name)}">
<meta name="twitter:description" content="Le YOUTH CLUB de ${escapeHtml(name)}.">
<meta name="twitter:image" content="../../assets/og-image.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fjalla+One&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../../theme.css">
<link rel="stylesheet" href="../../home.css">
</head>
<body>

<div class="pattern-veil"></div>

<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <img src="../../assets/logo-primary-blue.png" alt="Association YOUTH CLUBs" class="brand-logo">
      <div class="brand-divider"></div>
      <div class="brand-tag">YOUTH CLUB · ${escapeHtml(name)}</div>
    </div>
    <div class="menu" data-menu>
      <button type="button" class="menu-btn" data-menu-btn aria-haspopup="true" aria-expanded="false">
        <span class="menu-btn-label">Ce club</span>
        <span class="menu-btn-icon">
          <svg class="icon-open" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
          <svg class="icon-close" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </span>
      </button>
      <nav class="menu-panel" data-menu-panel aria-label="Navigation du club">
      <a href="#evenements">Événements</a>
      <a href="#bel">Bureau Exécutif Local</a>
      <a href="#partenaires-locaux">Partenaires du club</a>
      <a href="../../index.html">Site national AYCs</a>
      </nav>
    </div>
  </div>
</header>

<main class="stage">

  <!-- ===================== HERO ===================== -->
  <section class="hero hero-simple"${heroImageStyle}>
    <div class="hero-copy">
      <h1 class="hero-title">YOUTH CLUB <span>${escapeHtml(name)}</span></h1>
      <p class="hero-sub">Le club de ${escapeHtml(name)}, membre du réseau national de l'Association YOUTH CLUBs. Retrouve ici les événements du club, son Bureau Exécutif Local et ses partenaires.</p>
      <div class="hero-stats">
        <div class="hero-stat"><b>${escapeHtml(club.founded || "[AAAA]")}</b><span>Année de fondation</span></div>
        <div class="hero-stat"><b>${escapeHtml(club.memberCount ?? "[N]")}</b><span>Membres actifs</span></div>
        <div class="hero-stat"><b>${escapeHtml(club.city || "[Ville]")}</b><span>Localisation</span></div>
      </div>
    </div>
  </section>

  ${history.length ? `
  <!-- ===================== HISTOIRE DU CLUB ===================== -->
  <section class="section" id="about">
    <div class="section-head">
      <div class="section-head-copy">
        <h2>L'histoire du club</h2>
        <p>${escapeHtml(club.about || "")}</p>
      </div>
    </div>
    <div class="history-timeline">${history.map(renderHistoryItem).join("")}
    </div>
  </section>` : (club.about ? `
  <!-- ===================== À PROPOS DU CLUB ===================== -->
  <section class="section" id="about">
    <div class="section-head">
      <div class="section-head-copy">
        <h2>À propos du club</h2>
        <p>${escapeHtml(club.about)}</p>
      </div>
    </div>
  </section>` : "")}

  <!-- ===================== ÉVÉNEMENTS DU CLUB ===================== -->
  <section class="section" id="evenements">
    <div class="section-head">
      <div class="section-head-copy">
        <h2>Événements du club</h2>
        <p>Les prochaines activités organisées par le YOUTH CLUB ${escapeHtml(name)}.</p>
      </div>
    </div>

    ${events.length ? `
    <div class="rail-wrap" data-carousel>
      <div class="rail-viewport" data-rail-viewport tabindex="0" aria-label="Événements du club, défilement horizontal">
        <div class="rail-track" data-rail-track>${events.map(renderEventCard).join("")}
        </div>
      </div>
      <div class="rail-controls">
        <div class="rail-arrows">
          <button type="button" class="rail-arrow" data-rail-prev aria-label="Événement précédent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <button type="button" class="rail-arrow" data-rail-next aria-label="Événement suivant">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
        <div class="rail-progress"><div class="rail-progress-bar" data-rail-progress></div></div>
        <div class="rail-count"><b data-rail-current>1</b>&nbsp;/&nbsp;<span data-rail-total>${events.length}</span></div>
      </div>
    </div>` : `<p class="team-note">Aucun événement publié pour le moment.</p>`}
  </section>

  <!-- ===================== BUREAU EXÉCUTIF LOCAL ===================== -->
  <section class="section" id="bel">
    <div class="section-head">
      <div class="section-head-copy">
        <h2>Le Bureau Exécutif Local</h2>
        <p>L'équipe qui coordonne le YOUTH CLUB ${escapeHtml(name)} au quotidien, organisée en miroir du Bureau Exécutif National.</p>
      </div>
    </div>

    ${bel.length ? `
    <div class="rail-wrap" data-carousel>
      <div class="rail-viewport" data-rail-viewport tabindex="0" aria-label="Membres du Bureau Exécutif Local, défilement horizontal">
        <div class="rail-track" data-rail-track>${bel.map(renderTeamCard).join("")}
        </div>
      </div>
      <div class="rail-controls">
        <div class="rail-arrows">
          <button type="button" class="rail-arrow" data-rail-prev aria-label="Membre précédent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <button type="button" class="rail-arrow" data-rail-next aria-label="Membre suivant">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
        <div class="rail-progress"><div class="rail-progress-bar" data-rail-progress></div></div>
        <div class="rail-count"><b data-rail-current>1</b>&nbsp;/&nbsp;<span data-rail-total>${bel.length}</span></div>
      </div>
    </div>` : `<p class="team-note">Le Bureau Exécutif Local n'a pas encore été renseigné.</p>`}
    <p class="team-note">Le Bureau Exécutif Local coordonne les activités du club et rend compte au Bureau Exécutif National.</p>
  </section>

  <!-- ===================== PARTENAIRES LOCAUX ===================== -->
  <section class="section" id="partenaires-locaux">
    <div class="section-head">
      <div class="section-head-copy">
        <h2>Partenaires du club</h2>
        <p>Les acteurs locaux qui soutiennent les activités du YOUTH CLUB ${escapeHtml(name)}.</p>
      </div>
    </div>
    ${partners.length ? `<div class="gov-grid">${partners.map(renderPartnerCard).join("")}
    </div>` : `<p class="team-note">Aucun partenaire publié pour le moment.</p>`}
  </section>

  <!-- ===================== CTA ===================== -->
  <section class="section">
    <div class="cta-band">
      <div class="cta-band-tint"></div>
      <div class="cta-band-content">
        <h2>Envie de rejoindre ce club ?</h2>
        <p>Contacte le Bureau Exécutif Local pour savoir comment devenir membre du YOUTH CLUB ${escapeHtml(name)}.</p>
        <a href="mailto:contact@youthclubs.tn" class="btn btn-primary">Contacter le club <span aria-hidden="true">→</span></a>
      </div>
    </div>
  </section>

</main>

<footer class="page-footer">
  <div class="footer-affiliation">
    <span class="footer-affiliation-label">Association</span>
    <img src="../../assets/logo-secondary-color.png" alt="Association YOUTH CLUBs" class="footer-logo">
  </div>
  <span class="footer-meta">YOUTH CLUB ${escapeHtml(name)} · Membre du réseau national Association YOUTH CLUBs</span>
</footer>

<script>
(function(){
  "use strict";

  /* ---------- Header menu (button + dropdown panel) ---------- */
  var menuRoot = document.querySelector('[data-menu]');
  if (menuRoot){
    var menuBtn = menuRoot.querySelector('[data-menu-btn]');
    var menuPanel = menuRoot.querySelector('[data-menu-panel]');

    function closeMenu(){
      menuRoot.classList.remove('is-open');
      menuBtn.setAttribute('aria-expanded', 'false');
    }
    function openMenu(){
      menuRoot.classList.add('is-open');
      menuBtn.setAttribute('aria-expanded', 'true');
    }
    function toggleMenu(){
      if (menuRoot.classList.contains('is-open')) closeMenu(); else openMenu();
    }

    menuBtn.addEventListener('click', function(e){
      e.stopPropagation();
      toggleMenu();
    });
    document.addEventListener('click', function(e){
      if (!menuRoot.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape') closeMenu();
    });
    menuPanel.querySelectorAll('a').forEach(function(a){
      a.addEventListener('click', closeMenu);
    });
  }

  /* ---------- Scroll reveal ---------- */
  var revealTargets = document.querySelectorAll('.section-head, .gov-card, .cta-band');
  revealTargets.forEach(function(el){ el.classList.add('reveal-on-scroll'); });
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if (entry.isIntersecting){ entry.target.classList.add('is-visible'); io.unobserve(entry.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
  document.querySelectorAll('.reveal-on-scroll').forEach(function(el){ io.observe(el); });

  var railWraps = document.querySelectorAll('.rail-wrap');
  var railIo = new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if (entry.isIntersecting){ entry.target.classList.add('is-visible'); railIo.unobserve(entry.target); }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
  railWraps.forEach(function(el){ railIo.observe(el); });

  /* ---------- Carousels ---------- */
  var carousels = document.querySelectorAll('[data-carousel]');
  carousels.forEach(function(root){
    var viewport = root.querySelector('[data-rail-viewport]');
    var track = root.querySelector('[data-rail-track]');
    var prevBtn = root.querySelector('[data-rail-prev]');
    var nextBtn = root.querySelector('[data-rail-next]');
    var progressBar = root.querySelector('[data-rail-progress]');
    var currentEl = root.querySelector('[data-rail-current]');
    var totalEl = root.querySelector('[data-rail-total]');
    var cards = Array.prototype.slice.call(track.children);
    if (totalEl) totalEl.textContent = cards.length;
    cards.forEach(function(card, i){ card.style.setProperty('--card-i', i); });

    function cardStep(){
      if (!cards.length) return 0;
      var style = window.getComputedStyle(track);
      var gap = parseFloat(style.columnGap || style.gap || 0) || 0;
      return cards[0].getBoundingClientRect().width + gap;
    }
    function activeIndex(){
      var step = cardStep();
      if (!step) return 0;
      return Math.round(viewport.scrollLeft / step);
    }
    function updateUI(){
      var idx = Math.min(cards.length - 1, Math.max(0, activeIndex()));
      var maxScroll = track.scrollWidth - viewport.clientWidth;
      if (currentEl) currentEl.textContent = idx + 1;
      if (progressBar){
        var pct = maxScroll > 0 ? (viewport.scrollLeft / maxScroll) * 100 : 100;
        pct = Math.max(6, Math.min(100, pct));
        progressBar.style.width = pct + '%';
      }
      if (prevBtn) prevBtn.disabled = viewport.scrollLeft <= 2;
      if (nextBtn) nextBtn.disabled = viewport.scrollLeft >= maxScroll - 2;
    }
    function goTo(index){
      var step = cardStep();
      index = Math.min(cards.length - 1, Math.max(0, index));
      viewport.scrollTo({ left: index * step, behavior: 'smooth' });
    }
    if (prevBtn) prevBtn.addEventListener('click', function(){ goTo(activeIndex() - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function(){ goTo(activeIndex() + 1); });

    var scrollTimer = null;
    viewport.addEventListener('scroll', function(){
      if (scrollTimer) window.cancelAnimationFrame(scrollTimer);
      scrollTimer = window.requestAnimationFrame(updateUI);
    }, { passive: true });
    window.addEventListener('resize', updateUI);

    var isDown = false, startX = 0, startScroll = 0, moved = false;
    viewport.addEventListener('mousedown', function(e){
      isDown = true; moved = false;
      viewport.classList.add('is-dragging');
      startX = e.pageX;
      startScroll = viewport.scrollLeft;
    });
    window.addEventListener('mouseup', function(){
      if (!isDown) return;
      isDown = false;
      viewport.classList.remove('is-dragging');
      updateUI();
    });
    window.addEventListener('mousemove', function(e){
      if (!isDown) return;
      var dx = e.pageX - startX;
      if (Math.abs(dx) > 4) moved = true;
      viewport.scrollLeft = startScroll - dx;
    });
    viewport.addEventListener('click', function(e){
      if (moved){ e.preventDefault(); e.stopPropagation(); }
    }, true);
    viewport.addEventListener('keydown', function(e){
      if (e.key === 'ArrowRight'){ e.preventDefault(); goTo(activeIndex() + 1); }
      if (e.key === 'ArrowLeft'){ e.preventDefault(); goTo(activeIndex() - 1); }
    });
    updateUI();
  });
})();
</script>

</body>
</html>
`;
}

function renderSchoolCard(club) {
  return `      <a href="clubs/${escapeHtml(club.slug)}/" class="school-card">
        <div class="school-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="M6 10v6c0 1.5 2.7 3 6 3s6-1.5 6-3v-6"/></svg>
        </div>
        <h3>${escapeHtml(club.name)}</h3>
        <p>${escapeHtml(club.city)}</p>
      </a>`;
}

module.exports = { renderClubPage, renderSchoolCard };
