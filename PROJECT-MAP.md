# Project map

Two systems live in this one repo, deployed as separate Vercel projects
(see `scripts/deployment-targets.js` + `vercel.mjs`):

1. **The Discord bot + club websites** — the original system. Club data
   lives in `data/clubs/*.json` (GitHub-as-database, via `api/_lib/store.js`).
   VPCs (local club officers) manage their club entirely from Discord.
2. **The member portal** — a separate, newer system with its own database
   (Neon/Postgres), its own auth (Google OAuth), and its own UI
   (`public/portal/*.html`). Shares almost nothing with #1 except one
   sync hook (`api/_lib/schools-sync.js`).

For full setup instructions, read `README.md` (bot + club sites) and
`PORTAL-SETUP.md` (member portal) — this file is a map of what's where,
not a setup guide.

---

## 1. Discord bot + club websites

### Entry point
- **`api/interactions.js`** — the ONE endpoint Discord calls for every
  slash command and button/modal click. Routes to everything below by
  `interaction.type` and `custom_id`/command name. Start here to trace
  any Discord interaction end to end.

### Slash commands vs. the button panel — two ways to do the same things
- **`/club ...` commands** (create, delete, event/bel/partner add/remove,
  set-stats, set-about, set-hero-image, set-logo, form add-field, etc.)
  are defined inline in `api/interactions.js` (search for `cmd*` functions,
  e.g. `cmdEventAdd`, `cmdDelete`). Registered with Discord via
  `scripts/register-commands.js` — re-run that script any time a command's
  shape changes.
- **The button-driven control panel** (`/panel`, posted once per club in
  its `#control-room-<slug>` channel) is the friendlier alternative —
  same actions, no slash-command syntax. Lives in
  **`api/_lib/control-panel.js`**. This is where the "Ajouter" buttons for
  Événements/BEL/Partenaires live, including the post-submit
  "add an image via Google Drive link" follow-up step.
- **The `/form` form-builder panel** (lets a VPC build/edit each club's
  4 application forms via buttons + modals instead of
  `/club form add-field`) lives in **`api/_lib/form-control-room.js`**.

### Core `_lib` modules (Discord bot side)
| File | What it does |
|---|---|
| `api/_lib/store.js` | Reads/writes `data/clubs/*.json` and `data/pending/*` via the GitHub API. Every write = a git commit = auto site rebuild. `deleteClub()` also triggers Discord deprovisioning + portal cleanup. |
| `api/_lib/edits.js` | The "submit for review" pipeline: `submitEdit()` saves a pending edit, `postToReviewChannel()`/`updateReviewMessage()` post/edit the approve-reject message in the admin review channel, `buildReviewMessage()` renders it (including image previews). |
| `api/_lib/apply-edit.js` | What actually runs once an admin clicks **Approve** on a pending edit — writes the change into the club's live JSON (and provisions Discord resources on `create`, or deletes them on `delete-club`). |
| `api/_lib/discord-provisioning.js` | Creates (on approval) and tears down (on deletion) a club's Discord role, private category, channels, and webhooks. `provisionClubDiscordResources()` / `deprovisionClubDiscordResources()`. |
| `api/_lib/permissions.js` | Who can edit a club: national admin (Discord role), the club's own VPC role, or the legacy per-club `officers` list. `checkClubEditPermission()`. |
| `api/_lib/images.js` | Uploads Discord image *attachments* to Cloudinary (used by the `/club ... photo:`/`logo:` slash-command options), and `normalizeDriveImageLink()` for the Google-Drive-link flow used by the panel's "add image" step. |
| `api/_lib/slug.js` | Turns a club/school name into its URL slug. |
| `api/_lib/schools-sync.js` | The ONE bridge to the member portal's database — keeps `portal_schools` in sync whenever a club is saved/deleted, and hard-deletes portal member accounts on club deletion. |

### Public-facing (non-Discord) endpoint
- **`api/submit-form.js`** — public endpoint the generated club websites
  POST to when someone fills out a join/team-application form. Delivers
  to the club's Discord webhook if configured, always saves a durable
  copy under `data/submissions/`.

### Site generation
- **`scripts/build.js`** — reads every `data/clubs/*.json`, renders each
  "live" club's page + form pages into `public/clubs/<slug>/`. Run
  automatically by `.github/workflows/build-and-deploy.yml` on every
  data change.
- **`scripts/render-club.js`** — the actual HTML templates: club page,
  school card, and `renderFormPage()`/`renderFormField()` for the public
  application forms (this is where `checkbox_group`/`drive_link`/etc.
  field types are rendered).

### Data
- `data/clubs/*.json` — one file per live/draft club (the actual "database").
- `data/pending/<slug>/*.json` — pending edits awaiting admin approval.
- `data/submissions/<slug>/<formId>/*.json` — durable copy of every form
  submission (independent of whether Discord delivery succeeded).
- `examples/sample-club.json` — reference shape for a club record.

### Static site output
- `public/*.html` — the hand-written marketing/info pages (home, à-propos,
  gouvernance, événements, partenaires, valeurs, stratégie, contact,
  rejoindre, 404).
- `public/theme.css`, `public/home.css` — shared styling (form field
  styles, including the checkbox-group markup, live in `home.css`).
- `public/chat-widget.js`/`.css` — front-end for the AI chat widget
  (backed by `api/chat.js` + `api/_lib/knowledge-base.js`).
- `public/clubs/<slug>/` — generated by `scripts/build.js`; not committed
  by hand.

---

## 2. Member portal (separate system)

Full setup/architecture doc: **`PORTAL-SETUP.md`**.

### Entry points
- **`api/portal.js`** — the big consolidated portal API (dashboard,
  meetings, projects, reports, training, tasks, treasury, etc.), branches
  on `req.query.action`/`body.action`. This is the single largest file in
  the repo — use the function-name table below to jump to a section
  instead of scrolling.
- **`api/session.js`** — `GET /api/session`, tells static portal pages
  who's logged in.
- **`api/auth/google/start.js`** / **`api/auth/google/callback.js`** /
  **`api/auth/logout.js`** — Google OAuth login flow.
- **`api/onboarding/*.js`** — post-login, pre-membership flow: `me.js`
  (pre-fill from Google identity), `check-username.js`, `submit.js`
  (creates the member record), `upload-photo.js`.
- **`api/admin/*.js`** — national-admin-only actions: `members.js` +
  `members/decide.js` + `members/pending.js` (approve/reject membership
  requests), `members/set-admin.js`, `roles.js`.
- **`api/schools.js`** — public list of schools/clubs for the onboarding
  form's dropdown.
- **`api/chat.js`** — public AI chat widget endpoint (Gemini + knowledge
  base), used on the marketing site, not the portal itself.

### Core `_lib` modules (portal side)
| File | What it does |
|---|---|
| `api/_lib/db.js` | The portal's only data store — Neon serverless Postgres driver. |
| `api/_lib/members-store.js` | Reads/writes `portal_members`/`portal_schools`. |
| `api/_lib/roles.js` | Reads/writes the three role tables (`portal_club_display_roles`, etc.) — see `db/schema.sql` for the full rationale. |
| `api/_lib/sessions.js` | DB-backed sessions (not JWTs) so an admin decision takes effect on the member's very next request. |
| `api/_lib/signup-tokens.js` | Bridges Google-login-confirmed-but-no-account-yet to the onboarding form. |
| `api/_lib/oauth-state.js` | CSRF `state` param handling for the Google OAuth flow. |
| `api/_lib/google-oauth.js` | Builds the Google auth URL, exchanges the code, verifies the ID token. |
| `api/_lib/tokens.js` | Random token generation + hashing helpers shared by sessions/oauth-state/signup-tokens. |
| `api/_lib/cookies.js` | Minimal cookie parse/serialize (no dependency). |
| `api/_lib/mailer.js` | Transactional email via Resend. |
| `api/_lib/ag-template.js` | Fixed data template for National AG (Assemblée Générale) motions/workflow — NOT used for local AL/PV workflows. |
| `api/_lib/knowledge-base.js` | Reference text fed to the AI chat widget on every request. |

### Portal front-end
- `public/portal/*.html` — one file per portal page/role view (home,
  login, onboarding, pending/rejected states, meetings, assemblies,
  projects, reports, tasks, training, tresorerie, responsibilities,
  supervision, secretariat, president, admin-review, admin-roles,
  pv-editor, profile).
- `public/portal/portal-common.js` — shared client-side helpers
  (`AYCPortal.*`: API calls, escaping, formatting, empty states) used by
  every page above.
- `public/portal/portal.css` — portal-only styling.

### Database
- `db/schema.sql` — full portal schema (`create table if not exists`
  throughout — safe to re-run).
- `db/seed-schools.sql` — historical one-time snapshot; **not** the
  source of truth anymore (that's the live sync in `schools-sync.js`).
- `scripts/run-schema.js` — applies `schema.sql` against `DATABASE_URL`.
- `scripts/seed-local-test.js` — fast local testing, bypasses Google
  OAuth entirely.

---

## Cross-cutting / deployment plumbing

| File | What it does |
|---|---|
| `middleware.js` | Vercel Edge Middleware, runs before routing on every request; shared across all the Vercel projects this repo deploys as. |
| `vercel.mjs` | Allowlists which `api/*.js` files get packaged as functions per Vercel project (`DEPLOY_TARGET` env var), to stay under Hobby's 12-function cap. |
| `scripts/deployment-targets.js` | The authoritative list of deploy targets and which routes belong to each. |
| `scripts/prune-functions.js` | Local-only helper for inspecting one deployment target; not part of the production build. |
| `.github/workflows/build-and-deploy.yml` | Runs `scripts/build.js` and deploys whenever `data/` changes. |
| `package.json` | Dependencies: `@octokit/rest` (GitHub-as-DB), `discord-interactions` (signature verification), `@vercel/functions` (`waitUntil`), `@vercel/blob` (portal file uploads), `@neondatabase/serverless` + `pg` (portal DB), `google-auth-library` (portal OAuth). |

---

## "I want to change X — where do I go?"

- **A slash command's behavior** → `api/interactions.js` (find the `cmd*`
  function), or its registration shape in `scripts/register-commands.js`.
- **The button panel (Ajouter/Retirer buttons in #control-room)** →
  `api/_lib/control-panel.js`.
- **The `/form` builder panel** → `api/_lib/form-control-room.js`.
- **What happens when a club is approved/deleted** → `api/_lib/apply-edit.js`
  (dispatch) + `api/_lib/discord-provisioning.js` (actual Discord
  create/teardown) + `api/_lib/store.js` (`saveClub`/`deleteClub`).
- **Who's allowed to edit a club** → `api/_lib/permissions.js`.
- **How a club's public page/form looks** → `scripts/render-club.js`
  (HTML) + `public/theme.css`/`public/home.css` (styling).
- **A public form's field types** (short_text/date/checkbox/checkbox_group/
  drive_link) → defined in three places that must stay in sync:
  `scripts/render-club.js` (`renderFormField`, rendering),
  `api/submit-form.js` (validation + Discord display),
  `api/_lib/form-control-room.js` / `api/interactions.js`
  (`FIELD_TYPE_LABELS`, builder UI).
- **Anything member-portal-related** → see the "Member portal" section
  above, starting from `api/portal.js`.
- **Env vars** → `README.md` (bot) and `PORTAL-SETUP.md` (portal) list
  every required variable; don't guess from code alone.
