# Youth Impact — merge + internes dashboard

This archive is your `ayc-club-sites` repo with the **Youth Impact redesign merged in**
and a small **events dashboard** on the internes domain. Nothing was deleted: the old
site is still there under new names.

---

## 1. What changed

### The page that loads
`https://associationyouthclubs.org/` now serves the **Youth Impact** page (`public/index.html`).

### The old site, renamed (links rewritten everywhere)

| Before | Now |
|---|---|
| `index.html` | `legacy-index.html` |
| `a-propos.html` | `legacy-a-propos.html` |
| `valeurs.html` | `legacy-valeurs.html` |
| `strategie.html` | `legacy-strategie.html` |
| `gouvernance.html` | `legacy-gouvernance.html` |
| `evenements.html` | `legacy-evenements.html` |
| `partenaires.html` | `legacy-partenaires.html` |
| `contact.html` | `legacy-contact.html` |
| `rejoindre.html` | `legacy-rejoindre.html` |
| `404.html` | **unchanged** (GitHub Pages only accepts this exact name); its links point to the legacy pages |

References updated to match: the nav of every legacy page, `scripts/build.js`
(it fills the club list into `legacy-rejoindre.html`), the "Site national AYCs" link on
generated club pages (→ `/legacy-index`), and the Actualité / Stratégie / Contact links
in the portal header (`portal/portal-common.js`).

The Youth Impact footer has two new links: **Association YOUTH CLUBs** (→ `legacy-index`)
and **Espace membres** (→ internes portal), so the old site stays reachable.

### Files from the add-on, where they went

| Add-on | Now |
|---|---|
| `index.html` | `public/index.html` |
| `css/styles.css` | `public/css/impact.css` |
| `js/main.js` | `public/js/impact.js` |
| `assets/{fonts,img,logos,patterns}` | `public/assets/{fonts,img,logos,patterns}` (no name clashes) |
| `favicon.svg` | `public/favicon.svg` |
| `README.md` | `docs/youth-impact-addon-README.md` |

---

## 2. The dashboard

**URL:** `https://internes.associationyouthclubs.org/portal/impact-admin`
(also in the portal sidebar under **Site public** and on the portal home, for national admins only).

What you can do on it, per event: show/hide, lycée, name, category, icon, date, place,
price, responsible person, status (to confirm / registrations open / full / over),
investment goal, Instagram link, ticket link, short description. The six existing events
stay as they are: the dashboard edits them, it cannot add or delete any (the server refuses it).
Empty field = "À confirmer" on the site. A ticket link turns the disabled
"Billetterie bientôt disponible" button into a real **Réserver ma place** button.

**How it works (the whole thing):**

```
dashboard  →  POST /api/admin/impact  →  commit to data/impact-events.json
          →  GitHub Action runs `npm run build`  →  scripts/build.js
          →  rewrites the tickets in public/index.html  →  site updated (≈1–2 min)
```

- Access: national admins only (same check as the rest of the portal).
- Every save is a git commit named "Youth Impact : événements mis à jour par <username>",
  so GitHub history is your audit log and your undo.
- If two admins save at the same time, the second gets "reload the page" instead of
  overwriting the first.
- No new database table, no new Vercel project. One new API route
  (`api/admin/impact.js`), added to the `portal-admin` and `local` targets in
  `scripts/deployment-targets.js` (portal-admin goes from 4 to 5 functions; the Hobby cap is 12).
- To add or remove an event one day, edit `data/impact-events.json` by hand on GitHub (copy an entry, give it a new `id`); the same build picks it up.

### One thing to configure
The function runs on the Vercel project that serves `/api/admin/*` (`ayc-portal-admin`).
That project needs the same GitHub variables the bot project already has:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | the token already used by the bot (scope `repo`) |
| `GITHUB_OWNER` | your GitHub username/org |
| `GITHUB_REPO` | `ayc-club-sites` |
| `GITHUB_BRANCH` | `main` |

(`DATABASE_URL` is already there.) Redeploy that project after adding them. Until then the
dashboard shows a clear error naming the missing variables.

---

## 3. Deploy

1. Unzip over your local clone of the repo (this zip has no `.git` folder, so your history is untouched).
2. `git add -A && git commit -m "Merge Youth Impact, add internes dashboard" && git push`
   (git will show the legacy files as renames).
3. Add the 4 variables above to `ayc-portal-admin` and redeploy it.
4. Sign in to the portal as a national admin and open the dashboard.

Nothing else changes: same GitHub Pages workflow, same Vercel projects, same DNS.

---

## 4. One change you didn't ask for: `middleware.js`

The file's own comments say the internes domain must only serve `/portal`, `/api` and
`/assets`, but the code only locked the `portal-auth` project, not `portal-edge` (the one
that owns the domain). Since `/` is now the public Youth Impact page, internes would have
served it too. So the lock now applies to `portal-edge` as well, and `/theme.css` was added to
the allow-list because the portal pages load it. I simulated the middleware for the portal's
paths and the public paths; but please open the portal once after deploying. If anything looks
unstyled, revert `middleware.js` only.

---

## 5. Before you announce the new homepage

- **`noindex`**: `public/index.html` still has `<meta name="robots" content="noindex, nofollow">`
  (kept from the add-on). Remove that line when you want Google to index the new home.
- **Media kit**: the "Consulter le media kit" link points to `assets/youth-impact-media-kit.pdf`,
  which isn't in either archive. Add the file or remove the link.
- **Photos**: the add-on's note still applies — check consent for the photos in `assets/img/`.
- **Domain spelling**: your message wrote `associationyuthclubs.org`; the repo (middleware,
  Google OAuth, mailer) uses `associationyouthclubs.org`, so I used that one. If the
  real domain differs, change the two footer links in `public/index.html` and
  `public/portal/portal-common.js`.
- The AI chat widget is only on the legacy pages (as before: "national pages only").
  Add the two `chat-widget` lines from `legacy-index.html` to `index.html` if you want it on the new home.
- The contact form on the new page still validates only, sending nothing (add-on behaviour).

---

## 6. Test it locally

```
npm install
npm run build                # fills tickets from data/impact-events.json, builds club pages
python3 -m http.server 8000 -d public
```

Open http://localhost:8000. (The dashboard itself needs the portal login + database, so
test that one on Vercel.) Note that `npm run build` rewrites `public/index.html` (tickets)
and `public/legacy-rejoindre.html` (club list) in place, as it did before for the latter.

---

## 7. New and changed files

**New:** `SETUP-YOUTH-IMPACT.md`, `data/impact-events.json`, `api/_lib/impact.js`,
`api/admin/impact.js`, `public/portal/impact-admin.html`, `public/index.html` (Youth Impact),
`public/css/impact.css`, `public/js/impact.js`, `public/favicon.svg`,
`public/assets/{img,logos,patterns}/`, the Funnel/Unbounded fonts in `public/assets/fonts/`,
`docs/youth-impact-addon-README.md`.

**Changed:** the 9 renamed pages + `404.html` (links), `scripts/build.js`,
`scripts/render-club.js` (2 links), `scripts/deployment-targets.js`, `middleware.js`,
`public/portal/portal-common.js`, `PROJECT-MAP.md`.
