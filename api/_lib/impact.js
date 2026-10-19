// api/_lib/impact.js
//
// Everything the Youth Impact page needs to know about its events, in ONE
// place, shared by:
//   - api/admin/impact.js   (dashboard API → clean() before saving)
//   - scripts/build.js      (render*() when building the public page)
//
// Data lives in data/impact-events.json (one commit per dashboard save).

const ICONS = {
  "movie-night": "Cinéma",
  "soiree-musicale": "Soirée musicale",
  tournoi: "Tournoi / trophée",
  football: "Football",
  micro: "Micro / opéra",
  guitare: "Guitare / concert",
};

const STATUSES = {
  "a-confirmer": "Statut à confirmer",
  ouvert: "Inscriptions ouvertes",
  complet: "Complet",
  termine: "Terminé",
};

// key → max length. Order = order of the form in the dashboard.
const TEXT_FIELDS = {
  school: 80,
  event: 80,
  category: 60,
  desc: 400,
  date: 80,
  place: 120,
  price: 60,
  lead: 80,
  objective: 120,
};
const URL_FIELDS = ["instagram", "ticketUrl"];
const MAX_EVENTS = 24;

const slugify = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

// Validates + normalises whatever the dashboard sends. Throws Error(message)
// with a French message that is safe to show to the admin.
function clean(input) {
  const list = Array.isArray(input?.events) ? input.events : null;
  if (!list) throw new Error("Données invalides.");
  if (list.length > MAX_EVENTS) throw new Error(`Maximum ${MAX_EVENTS} événements.`);

  const seen = new Set();
  const events = list.map((raw, i) => {
    const e = { id: "", visible: raw?.visible !== false };
    for (const [key, max] of Object.entries(TEXT_FIELDS)) {
      e[key] = String(raw?.[key] ?? "").trim().slice(0, max);
    }
    if (!e.school || !e.event) throw new Error(`Événement ${i + 1} : le lycée et le nom sont obligatoires.`);

    e.icon = ICONS[raw?.icon] ? raw.icon : "movie-night";
    e.status = STATUSES[raw?.status] ? raw.status : "a-confirmer";

    for (const key of URL_FIELDS) {
      const v = String(raw?.[key] ?? "").trim();
      if (v && !/^https:\/\/[^\s"'<>]{1,300}$/.test(v)) {
        throw new Error(`« ${e.event} » : le lien ${key === "ticketUrl" ? "d'inscription" : "Instagram"} doit commencer par https://`);
      }
      e[key] = v;
    }

    let id = slugify(raw?.id) || slugify(e.school) || `evenement-${i + 1}`;
    while (seen.has(id)) id += "-2";
    seen.add(id);
    e.id = id;
    return e;
  });
  return { events };
}

// ---------- public-page rendering (used at build time) ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function renderTicket(e, i) {
  const tone = i % 2 === 0 ? "nuit" : "impact";
  const data = {
    club: e.id, school: e.school, event: e.event, category: e.category, icon: e.icon, desc: e.desc,
    date: e.date, place: e.place, price: e.price, lead: e.lead, objective: e.objective,
    status: STATUSES[e.status] || STATUSES["a-confirmer"], instagram: e.instagram, ticket: e.ticketUrl,
  };
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
  return `        <article class="ticket ticket--${tone}" ${attrs}>
          <div class="ticket__top">
            <p class="ticket__cat">${esc(e.category)}</p>
            <svg class="ticket__icon" aria-hidden="true"><use href="#i-${esc(e.icon)}"/></svg>
            <h3 class="ticket__event">${esc(e.event)}</h3>
          </div>
          <div class="ticket__perf" aria-hidden="true"></div>
          <div class="ticket__body">
            <div class="lockup"><img src="assets/logos/youthimpact-logomark-clair.svg" alt="" width="34" height="44"><span class="lockup__rule"></span><p class="lockup__text"><strong>Club Youth</strong><span>${esc(e.school)}</span></p></div>
            <p class="ticket__desc">${esc(e.desc)}</p>
            <button class="ticket__link" type="button" aria-haspopup="dialog">Découvrir le projet<span class="sr-only"> : ${esc(e.school)}</span></button>
          </div>
        </article>`;
}

const WORDS = ["Zéro", "Un", "Deux", "Trois", "Quatre", "Cinq", "Six", "Sept", "Huit", "Neuf", "Dix", "Onze", "Douze"];

function renderTitle(n) {
  if (n === 0) return "Nos clubs. Nos projets. Une même ambition.";
  const w = WORDS[n] || String(n);
  const [club, projet] = n === 1 ? ["club", "projet"] : ["clubs", "projets"];
  return `${w} ${club}. ${w} ${projet}. Une même ambition.`;
}

module.exports = { ICONS, STATUSES, TEXT_FIELDS, URL_FIELDS, clean, renderTicket, renderTitle };
