// portal-common.js — shared across every /portal page: renders the topbar
// (same look as the public site, "Se connecter" swapped for the avatar +
// "Se déconnecter" once signed in) and exposes a couple of small helpers.

function renderTopbar(rootEl) {
  rootEl.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <img src="../assets/logo-primary-blue.png" alt="Association YOUTH CLUBs" class="brand-logo">
          <div class="brand-divider"></div>
          <div class="brand-tag">Association YOUTH CLUBs</div>
        </div>
        <nav style="display:flex; align-items:center; gap:22px;" aria-label="Navigation principale">
          <a href="../index.html" style="font-family:var(--font-body); font-weight:600; font-size:0.85rem; color:var(--ink-soft); text-decoration:none;">Actualité</a>
          <a href="../gouvernance.html" style="font-family:var(--font-body); font-weight:600; font-size:0.85rem; color:var(--ink-soft); text-decoration:none;">Gouvernance</a>
          <a href="../contact.html" style="font-family:var(--font-body); font-weight:600; font-size:0.85rem; color:var(--ink-soft); text-decoration:none;">Contact</a>
          <span id="auth-slot" class="auth-slot"></span>
        </nav>
      </div>
    </header>
  `;
}

async function fetchSession() {
  const res = await fetch("/api/session");
  if (!res.ok) return null;
  const data = await res.json();
  return data.member;
}

function renderAuthSlot(member) {
  const slot = document.getElementById("auth-slot");
  if (!slot) return;

  if (!member) {
    slot.innerHTML = `<a href="/api/auth/google/start" class="btn btn-primary" style="padding:9px 20px; font-size:0.85rem;">Se connecter</a>`;
    return;
  }

  slot.innerHTML = `
    ${
      member.profilePictureUrl
        ? `<img class="auth-avatar" src="${member.profilePictureUrl}" alt="${escapeHtml(member.displayName)}">`
        : `<span class="auth-avatar" aria-hidden="true"></span>`
    }
    <button type="button" class="btn-logout" id="logout-btn">Se déconnecter</button>
  `;

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/portal/login.html";
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// Runs on every portal page: paints the topbar immediately, then fills in
// the auth slot once we know who (if anyone) is signed in.
async function initPortalShell() {
  const topbarRoot = document.getElementById("topbar-root");
  if (topbarRoot) renderTopbar(topbarRoot);
  const member = await fetchSession().catch(() => null);
  renderAuthSlot(member);
  return member;
}

window.AYCPortal = { initPortalShell, fetchSession, escapeHtml };
