(function(){
  "use strict";
  var menuRoot = document.querySelector('[data-menu]');
  if (!menuRoot) return;
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
})();
