(() => {
  const NAV_GROUPS = (member) => {
    const access = member?.access || {};
    const groups = [
      {
        label: "Mon espace",
        items: [
          ["home", "⌂", "Accueil"],
          ["profile", "◉", "Mon profil"],
          ["meetings", "▣", "Réunions"],
          ["projects", "◆", "Projets"],
          ["training", "↗", "Cursus"],
          ["tasks", "☷", "Mes tâches"],
        ],
      },
    ];
    if (access.canViewClubWork || access.canAccessSecretariat || member?.isNationalAdmin) {
      const clubItems = [["reports", "✓", "Rapports & projets"]];
      if (access.canAccessSecretariat || access.canViewClubWork || member?.isNationalAdmin) {
        clubItems.push(["secretariat", "📋", "Secrétariat"]);
      }
      if (access.canAccessTreasury || access.canViewClubWork || member?.isNationalAdmin) {
        clubItems.push(["tresorerie", "💰", "Trésorerie"]);
      }
      groups.push({
        label: "Vie du club",
        items: clubItems,
      });
    }
    if (access.canReviewSupervision || member?.isNationalAdmin) {
      groups.push({ label: "Gouvernance", items: [["supervision", "⚖", "Supervision"]] });
    }
    return groups;
  };

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function renderShell(member) {
    const current = location.pathname.split("/").pop() || "home";
    const currentWithHash = current + (location.hash || "");
    const initials = member?.displayName
      ? member.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()
      : "";
    const avatar = member?.profilePictureUrl
      ? `<img src="${escapeHtml(member.profilePictureUrl)}" alt="${escapeHtml(member.displayName)}" class="auth-avatar">`
      : `<span class="auth-avatar auth-initials">${escapeHtml(initials)}</span>`;
    const groups = NAV_GROUPS(member);

    const topbar = document.getElementById("topbar-root");
    if (topbar) {
      topbar.innerHTML = `
        <header class="topbar">
          <a class="brand" href="home" aria-label="Accueil du portail">
            <img src="../assets/logo-primary-blue.png" alt="Association YOUTH CLUBs" class="brand-logo">
            <span class="brand-divider"></span>
            <span class="brand-tag">Association YOUTH CLUBs</span>
          </a>
          <nav class="public-nav" aria-label="Navigation principale">
            <a href="../index">Actualité</a>
            <a href="https://associationyouthclubs.org/strategie">Stratégie</a>
            <a href="../contact">Contact</a>
          </nav>
          <div class="account-slot">
            ${member ? `${avatar}<span class="account-name">${escapeHtml(member.displayName || member.username)}</span><button class="btn-logout" id="logout-btn" type="button">Se déconnecter</button>` : `<a class="btn btn-primary" href="/api/auth/google/start">Se connecter</a>`}
          </div>
        </header>`;
    }

    const sidebar = document.getElementById("sidebar-root");
    if (sidebar) {
      sidebar.innerHTML = `
        <aside class="icon-sidebar" aria-label="Espace membre">
          <div class="sidebar-mark"><img src="../assets/logo-secondary-white.png" alt="Association YOUTH CLUBs" class="sidebar-mark-logo"></div>
          <nav class="sidebar-nav">
            ${groups.map(group => `<section class="sidebar-group"><h2 class="sidebar-group-label">${escapeHtml(group.label)}</h2><div class="sidebar-links">${group.items.map(([href, icon, label]) => `<a class="sidebar-link ${(current === href || currentWithHash === href) ? "active" : ""}" href="${href}" title="${escapeHtml(label)}"><span class="sidebar-icon" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span></a>`).join("")}</div></section>`).join("")}
          </nav>
          <a class="sidebar-link sidebar-settings" href="profile#settings" title="Paramètres"><span class="sidebar-icon" aria-hidden="true">⚙</span><span>Paramètres</span></a>
        </aside>`;
    }

    const navAdmin = document.getElementById("admin-links");
    if (navAdmin && (member?.isNationalAdmin || member?.canReviewMembership)) {
      navAdmin.innerHTML = `<a class="list-item" href="admin-review"><span class="list-item-title">Demandes d’adhésion</span><span class="list-item-meta">${member?.isNationalAdmin ? "Vue nationale" : "Demandes de ton club"}</span></a>${member?.isNationalAdmin ? `<a class="list-item" href="admin-roles"><span class="list-item-title">Rôles et permissions</span><span class="list-item-meta">Administration nationale</span></a>` : ""}`;
    }

    const logout = document.getElementById("logout-btn");
    if (logout) logout.addEventListener("click", async () => {
      logout.disabled = true;
      await fetch("/api/auth/logout", { method: "POST" });
      location.href = "login";
    });
  }

  function installPortalMotion() {
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const selector = [
      ".portal-heading",
      ".portal-card",
      ".stat-card",
      ".list-item",
      ".portal-table tbody tr",
      ".empty-state",
      ".profile-cover",
      ".status-banner",
    ].join(",");

    let observer;
    const mark = (root) => {
      if (!root || root.nodeType !== 1) return;
      const elements = root.matches?.(selector)
        ? [root]
        : Array.from(root.querySelectorAll?.(selector) || []);
      elements.forEach((element, index) => {
        if (element.dataset.motionReady) return;
        element.dataset.motionReady = "true";
        element.classList.add("portal-reveal");
        element.style.setProperty("--motion-delay", reduceMotion ? "0ms" : `${Math.min(index, 7) * 55}ms`);
        if (reduceMotion) element.classList.add("is-visible");
        else observer?.observe(element);
      });
    };

    observer = reduceMotion
      ? null
      : new IntersectionObserver((entries, io) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          });
        }, { threshold: 0.04, rootMargin: "0px 0px 64px 0px" });

    mark(document.body);
    const mutations = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach(mark));
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    document.body.classList.add("motion-ready");
  }

  async function fetchSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    if (!res.ok) return null;
    const data = await res.json();
    return data.member || null;
  }

  function showLoadingScreen() {
    document.body.classList.add("portal-loading");
    if (document.getElementById("portal-loading-screen")) return;
    const overlay = document.createElement("div");
    overlay.id = "portal-loading-screen";
    overlay.className = "portal-loading-screen";
    overlay.innerHTML = `
      <div class="portal-loading-inner">
        <img src="../assets/logo-primary-blue.png" alt="Association YOUTH CLUBs" class="portal-loading-mark">
        <div class="portal-loading-ring"></div>
        <span class="portal-loading-text">Chargement…</span>
      </div>`;
    document.body.appendChild(overlay);
  }

  function hideLoadingScreen() {
    document.body.classList.remove("portal-loading");
    const overlay = document.getElementById("portal-loading-screen");
    if (!overlay) return;
    overlay.classList.add("is-hidden");
    setTimeout(() => overlay.remove(), 550);
  }

  async function initPortalShell({ requireActive = false } = {}) {
    document.body.classList.add("portal-page");
    showLoadingScreen();
    try {
      const member = await fetchSession().catch(() => null);
      renderShell(member);
      installPortalMotion();
      if (requireActive && !member) {
        location.href = `login?next=${encodeURIComponent(location.pathname.split("/").pop())}`;
        return null;
      }
      if (requireActive && member.status === "pending") { location.href = "pending"; return null; }
      if (requireActive && member.status === "rejected") { location.href = "rejected"; return null; }
      return member;
    } finally {
      hideLoadingScreen();
    }
  }

  async function api(action, options = {}) {
    const method = options.method || "GET";
    const url = `/api/portal?action=${encodeURIComponent(action)}${options.query ? `&${new URLSearchParams(options.query)}` : ""}`;
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? undefined : { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(options.body || {}),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || "Une erreur est survenue.");
    return data;
  }

  function formatDate(value, withTime = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("fr-FR", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(date);
  }

  function statusLabel(status) {
    const labels = { draft: "Brouillon", submitted: "Soumis", validated: "Validé", invalidated: "À corriger", in_progress: "En cours", completed: "Terminé", a_faire: "À faire", soumis: "Soumis", executee: "Exécutée", hors_delai: "Hors délai" };
    return labels[status] || status || "—";
  }

  function renderError(target, error) { target.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message || error)}</div>`; }
  function renderEmpty(text) { return `<div class="empty-state"><strong>${escapeHtml(text)}</strong><span>Les éléments apparaîtront ici dès qu'ils seront créés.</span></div>`; }

  window.AYCPortal = { initPortalShell, fetchSession, api, escapeHtml, formatDate, statusLabel, renderError, renderEmpty, installPortalMotion, showLoadingScreen, hideLoadingScreen };
})();
