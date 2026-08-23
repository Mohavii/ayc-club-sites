/* chat-widget.js
   Floating chat widget for the AYCs national site. Include this file's
   CSS and JS on any page you want the widget to appear on — currently
   the national pages only (index.html, a-propos.html, etc.), NOT the
   individual club pages.

   Add this near the end of <body>, right before the closing </body> tag:
     <link rel="stylesheet" href="chat-widget.css">
     <script src="chat-widget.js" defer></script>

   Uses the site's own CSS variables (--navy-1, --blue-2, etc. from
   theme.css) so it always matches the site's look with zero extra config.
*/

(function () {
  "use strict";

  // Point this at your deployed bot's Vercel URL + /api/chat.
  // Matches the same pattern as the join-form widget in render-club.js.
  const API_URL = "https://ayc-club-sites.vercel.app/api/chat";

  const STORAGE_KEY = "ayc_chat_history";
  const MAX_STORED_TURNS = 20;

  let history = [];
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) history = JSON.parse(saved);
  } catch (e) {
    history = [];
  }

  function saveHistory() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_STORED_TURNS)));
    } catch (e) {
      /* sessionStorage unavailable (private mode etc.) — fail silently, chat still works within the session */
    }
  }

  // ---------- build the widget DOM ----------

  const root = document.createElement("div");
  root.className = "ayc-chat-root";
  root.innerHTML = `
    <button type="button" class="ayc-chat-toggle" aria-label="Ouvrir le chat" aria-expanded="false">
      <svg class="ayc-chat-icon-open" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      <svg class="ayc-chat-icon-close" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <div class="ayc-chat-panel" role="dialog" aria-label="Assistant AYC" aria-hidden="true">
      <div class="ayc-chat-header">
        <span class="ayc-chat-header-title">Assistant AYC</span>
        <span class="ayc-chat-header-sub">Pose une question sur l'association</span>
      </div>
      <div class="ayc-chat-messages" aria-live="polite"></div>
      <form class="ayc-chat-form">
        <input type="text" class="ayc-chat-input" placeholder="Écris ta question..." autocomplete="off" maxlength="2000">
        <button type="submit" class="ayc-chat-send" aria-label="Envoyer">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>
        </button>
      </form>
    </div>
  `;
  document.body.appendChild(root);

  const toggleBtn = root.querySelector(".ayc-chat-toggle");
  const panel = root.querySelector(".ayc-chat-panel");
  const messagesEl = root.querySelector(".ayc-chat-messages");
  const form = root.querySelector(".ayc-chat-form");
  const input = root.querySelector(".ayc-chat-input");

  let isOpen = false;

  function openPanel() {
    isOpen = true;
    root.classList.add("is-open");
    toggleBtn.setAttribute("aria-expanded", "true");
    panel.setAttribute("aria-hidden", "false");
    input.focus();
    if (messagesEl.children.length === 0) {
      renderMessage("model", "Bonjour ! Je suis l'assistant de l'Association YOUTH CLUBs. Pose-moi une question sur l'association, son fonctionnement, ou ses clubs.");
    }
  }
  function closePanel() {
    isOpen = false;
    root.classList.remove("is-open");
    toggleBtn.setAttribute("aria-expanded", "false");
    panel.setAttribute("aria-hidden", "true");
  }
  toggleBtn.addEventListener("click", function () {
    isOpen ? closePanel() : openPanel();
  });

  function renderMessage(role, text) {
    const bubble = document.createElement("div");
    bubble.className = "ayc-chat-bubble ayc-chat-bubble-" + (role === "user" ? "user" : "model");
    bubble.textContent = text;
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function renderTyping() {
    const bubble = document.createElement("div");
    bubble.className = "ayc-chat-bubble ayc-chat-bubble-model ayc-chat-typing";
    bubble.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    renderMessage("user", text);
    history.push({ role: "user", text });
    saveHistory();
    input.value = "";
    input.disabled = true;

    const typingBubble = renderTyping();

    fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history: history.slice(0, -1) }),
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok, json: json };
        });
      })
      .then(function (result) {
        typingBubble.remove();
        if (!result.ok) throw new Error((result.json && result.json.error) || "Erreur");
        renderMessage("model", result.json.reply);
        history.push({ role: "model", text: result.json.reply });
        saveHistory();
      })
      .catch(function () {
        typingBubble.remove();
        renderMessage("model", "Désolé, une erreur est survenue. Réessaie dans un instant.");
      })
      .finally(function () {
        input.disabled = false;
        input.focus();
      });
  });
})();
