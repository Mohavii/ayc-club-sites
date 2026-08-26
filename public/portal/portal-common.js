(() => {
  const NAV = [
    ["home.html", "⌂", "Accueil"],
    ["profile.html", "◉", "Mon profil"],
    ["meetings.html", "▣", "Réunions"],
    ["reports.html", "✓", "Rapports"],
    ["training.html", "↗", "Cursus"],
    ["tasks.html", "☷", "Mes tâches"],
  ];

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function renderShell(member) {
    const current = location.pathname.split("/").pop() || "home.html";
    const initials = member?.displayName
      ? member.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()
      : "";
    const avatar = member?.profilePictureUrl
      ? `<img src="${escapeHtml(member.profilePictureUrl)}" alt="${escapeHtml(member.displayName)}" class="auth-avatar">`
      : `<span class="auth-avatar auth-initials">${escapeHtml(initials)}</span>`;

    const topbar = document.getElementById("topbar-root");
    if (topbar) {
      topbar.innerHTML = `
        <header class="topbar">
          <a class="brand" href="home.html" aria-label="Accueil du portail">
            <img src="../assets/logo-primary-blue.png" alt="Association YOUTH CLUBs" class="brand-logo">
            <span class="brand-divider"></span>
            <span class="brand-tag">Association YOUTH CLUBs</span>
          </a>
          <nav class="public-nav" aria-label="Navigation principale">
            <a href="../index.html">Actualité</a>
            <a href="../gouvernance.html">Gouvernance</a>
            <a href="../contact.html">Contact</a>
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
          <div class="sidebar-mark">Y</div>
          <div class="sidebar-links">
            ${NAV.map(([href, icon, label]) => `<a class="sidebar-link ${current === href ? "active" : ""}" href="${href}" title="${label}"><span class="sidebar-icon">${icon}</span><span>${label}</span></a>`).join("")}
          </div>
          <a class="sidebar-link sidebar-settings" href="profile.html#settings" title="Paramètres"><span class="sidebar-icon">⚙</span><span>Paramètres</span></a>
        </aside>`;
    }

    const navAdmin = document.getElementById("admin-links");
    if (navAdmin && member?.isNationalAdmin) {
      navAdmin.innerHTML = `<a href="admin-review.html">Demandes d'adhésion</a><a href="admin-roles.html">Rôles et permissions</a>`;
    }

    const logout = document.getElementById("logout-btn");
    if (logout) logout.addEventListener("click", async () => {
      logout.disabled = true;
      await fetch("/api/auth/logout", { method: "POST" });
      location.href = "login.html";
    });
  }

  async function fetchSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    if (!res.ok) return null;
    const data = await res.json();
    return data.member || null;
  }

  async function initPortalShell({ requireActive = false } = {}) {
    document.body.classList.add("portal-page");
    const member = await fetchSession().catch(() => null);
    renderShell(member);
    if (requireActive && !member) {
      location.href = `login.html?next=${encodeURIComponent(location.pathname.split("/").pop())}`;
      return null;
    }
    if (requireActive && member.status === "pending") { location.href = "pending.html"; return null; }
    if (requireActive && member.status === "rejected") { location.href = "rejected.html"; return null; }
    return member;
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

  window.AYCPortal = { initPortalShell, fetchSession, api, escapeHtml, formatDate, statusLabel, renderError, renderEmpty };
})();
