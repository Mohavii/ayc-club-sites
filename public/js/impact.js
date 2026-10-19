/* Youth Impact — comportements : menu mobile, section active, fiche événement, formulaire. Aucune dépendance. */
(function () {
  'use strict';
  var root = document.documentElement;

  /* ---- Menu mobile ---- */
  var btn = document.querySelector('.menu-btn');
  var nav = document.getElementById('nav');
  function setMenu(open) {
    root.classList.toggle('menu-open', open);
    root.classList.toggle('is-locked', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
  }
  btn.addEventListener('click', function () { setMenu(!root.classList.contains('menu-open')); });
  nav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && root.classList.contains('menu-open')) { setMenu(false); btn.focus(); } });
  window.matchMedia('(min-width:1121px)').addEventListener('change', function (m) { if (m.matches) setMenu(false); });

  /* ---- Section active dans la navigation ---- */
  var links = Array.prototype.slice.call(document.querySelectorAll('[data-spy]'));
  var targets = links.map(function (a) { return document.getElementById(a.dataset.spy); }).filter(Boolean);
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      var hit = entries.find(function (en) { return en.isIntersecting; });
      if (!hit) return;
      links.forEach(function (a) {
        if (a.dataset.spy === hit.target.id) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    targets.forEach(function (t) { io.observe(t); });
  }

  /* ---- Fiche événement ---- */
  var dlg = document.getElementById('club-dialog');
  var opener = null;
  function slot(name) { return dlg.querySelector('[data-slot="' + name + '"]'); }
  // Valeurs par défaut affichées quand le tableau de bord n'a rien renseigné.
  var DEFAULTS = { date: 'À confirmer', place: 'À confirmer', price: 'À confirmer', lead: 'À renseigner', objective: 'À renseigner avec le club', status: 'Statut à confirmer' };
  function openClub(card) {
    var d = card.dataset;
    ['school', 'category', 'event', 'desc'].forEach(function (k) { slot(k).textContent = d[k]; });
    Object.keys(DEFAULTS).forEach(function (k) { slot(k).textContent = d[k] || DEFAULTS[k]; });
    slot('icon').setAttribute('href', '#i-' + d.icon);
    // Billetterie : lien actif seulement si le tableau de bord en fournit un.
    var ticket = slot('ticket');
    ticket.hidden = !d.ticket;
    if (d.ticket) ticket.href = d.ticket;
    slot('noticket').hidden = !!d.ticket;
    // Instagram
    var note = slot('note');
    note.textContent = '';
    if (d.instagram) {
      var a = document.createElement('a');
      a.href = d.instagram; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Suivre le club sur Instagram';
      note.appendChild(a);
    } else {
      note.textContent = 'Instagram et lien d’inscription à ajouter.';
    }
    dlg.scrollTop = 0;
    root.classList.add('is-locked');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  document.querySelectorAll('.ticket').forEach(function (card) {
    card.querySelector('.ticket__link').addEventListener('click', function (e) { opener = e.currentTarget; openClub(card); });
  });
  function closeDlg() { if (dlg.open) dlg.close(); }
  dlg.querySelector('.event__close').addEventListener('click', closeDlg);
  dlg.querySelector('.event__back').addEventListener('click', closeDlg);
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeDlg(); });
  dlg.addEventListener('close', function () {
    if (!root.classList.contains('menu-open')) root.classList.remove('is-locked');
    if (opener) opener.focus();
  });

  /* ---- Formulaire (aperçu : l'envoi sera branché plus tard) ---- */
  var form = document.getElementById('contact-form');
  var err = document.getElementById('form-error');
  var ok = document.getElementById('form-ready');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var valid = form.checkValidity();
    err.hidden = valid; ok.hidden = !valid;
    if (!valid) form.reportValidity();
  });
})();
