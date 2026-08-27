# YOUTHCLUBber member portal — setup

This is a new, self-contained feature living alongside the existing
Discord-driven club sites in this same repo. It shares no auth and no
user-facing code paths with the Discord bot / GitHub-as-database system
— everything it needs is new files under `api/_lib/`, `api/auth/`,
`api/onboarding/`, `api/admin/`, `public/portal/`, and `db/`.

One deliberate exception: `portal_schools` (which club/school a member
can pick at signup) is live-synced from `data/clubs/*.json` via
`api/_lib/schools-sync.js`, hooked into `store.saveClub` /
`store.deleteClub`. See that file for the exact rules — in short,
publishing a club makes it selectable, un-publishing hides it, and
deleting a club deletes every member account tied to it.

## Deployment topology — READ THIS FIRST

This repo's `api/*.js` route count is well past Vercel Hobby's
12-serverless-function-per-deployment cap once you count the bot's
routes AND the portal's. Since Hobby doesn't offer per-project repo
filtering, this repo deploys as **multiple separate Vercel projects**,
each importing the exact same GitHub repo, each kept under 12 functions
by `vercel.cjs` allowlisting only that project's API entrypoints before
Vercel packages functions (controlled by the `DEPLOY_TARGET` env var — see
`scripts/deployment-targets.js` for the authoritative list). The old
`prune-functions.js` remains only as a local inspection helper and is not
part of the production build command.

Portal projects are split **by who calls the routes** (this was a
deliberate choice over splitting by feature — see the file's own
comments for why):

| Vercel project | `DEPLOY_TARGET` | What it serves |
|---|---|---|
| (existing bot project) | `bot` | Discord bot's own API routes |
| `ayc-portal-edge` | `portal-edge` | **Owns the real domain.** Static `public/portal/**` files + proxies `/api/*` to the service projects below via `vercel.cjs` rewrites. Zero API routes of its own. |
| `ayc-portal-auth` | `portal-auth` | Google OAuth, sessions, onboarding, schools list |
| `ayc-portal-admin` | `portal-admin` | National-admin-only: membership decide/pending, role/capability assignment |
| *(future)* `ayc-portal-member` | `portal-member` | Active-member self-service routes, once built |
| *(future)* `ayc-portal-officer` | `portal-officer` | Role/capability-gated routes (PV editor, report validation, etc.), once built |

**Why a proxy instead of just pointing the domain at each project
directly:** the browser only ever talks to one origin
(`internes.associationyouthclubs.org`), so cookies/sessions work
exactly like a normal single-origin app. The `portal-edge` project's
`vercel.cjs` rewrites forward `/api/auth/*`, `/api/onboarding/*`,
`/api/schools`, `/api/admin/*` etc. to each service project's real
`*.vercel.app` URL server-side — the browser never sees the other
origins.

### One-time setup for this topology

1. Create each Vercel project listed above by importing this same
   GitHub repo again for each row (Add New → Project → same repo,
   different project name each time).
2. Set `DEPLOY_TARGET` in each project's env vars to match the table. The
variable name is case-sensitive; `deploy_target` is also accepted for
backward compatibility, but new projects should use the uppercase spelling.
3. Deploy `ayc-portal-auth` and `ayc-portal-admin` FIRST, note down
   their real `*.vercel.app` URLs once deployed.
4. Edit the `edgeRewrites` destinations in `vercel.cjs` at the repo root,
   replacing the `REPLACE-portal-auth.vercel.app` /
   `REPLACE-portal-admin.vercel.app` placeholders with those real URLs.
   Commit and push — this triggers all connected projects to redeploy,
   including `portal-edge` picking up the corrected rewrite targets.
5. Add the `internes.associationyouthclubs.org` domain to the
   `ayc-portal-edge` project ONLY (Settings → Domains), with the
   matching CNAME at your DNS registrar.
6. As new service projects are added later (`portal-member`,
   `portal-officer`), repeat steps 1–2 for them, add their routes to
   `scripts/deployment-targets.js`, add a rewrite line to the
   `edgeRewrites` array in `vercel.cjs` pointing at their URL, and push.

**`DATABASE_URL` must be identical across EVERY project above**,
including the bot project — the schools-sync feature and all portal
data reads/writes depend on every project pointing at the same Neon
database. A mismatch here silently breaks things rather than erroring
loudly, so double-check it after adding any new project.

Scope of this build so far: **Google sign-in, account creation
(username, display name, photo, school), national-admin approval/
rejection, and the granular per-club role & capability system**
(display roles like Président/Secrétaire, stackable backend
capabilities like report-validator, and separate national-scope
titles). Dashboard, meetings/PVs, report tracking, and training cursus
are not built yet.

## 1. Database (Neon Postgres, free tier)

1. Create a free project at https://neon.tech.
2. Copy the connection string it gives you (starts `postgresql://...`).
   Set it as `DATABASE_URL` in **every** Vercel project listed in the
   topology table above (bot included).
3. Run the schema once:
   ```
   psql "$DATABASE_URL" -f db/schema.sql
   psql "$DATABASE_URL" -f db/seed-schools.sql   # optional, see below
   ```
   `portal_schools` is **live-synced** with `data/clubs/*.json` —
   `api/_lib/store.js` calls `api/_lib/schools-sync.js` on every club
   save/delete from the Discord bot, so schools appear/disappear/rename
   automatically as clubs go live, get edited, or get deleted. You don't
   need to maintain this table by hand. `seed-schools.sql` is now just an
   optional bootstrap for testing against a brand-new empty database
   before any real club save has happened.

   The schema also defines `portal_club_display_roles`,
   `portal_capability_grants`, and `portal_national_roles` — see the
   large comment block above them in `db/schema.sql` for the full
   reasoning on why these are three separate tables rather than one.

## 2. Google OAuth

1. In Google Cloud Console, create an OAuth 2.0 Client ID (Web
   application).
2. Authorized redirect URI:
   `https://internes.associationyouthclubs.org/api/auth/google/callback`
   (the real domain — this hits `portal-edge`, which proxies it to
   `portal-auth`; Google never needs to know about the service URLs).
3. Set these in `ayc-portal-auth`'s Vercel env vars:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` — must exactly match what you registered above.

## 3. Vercel Blob (profile pictures)

1. In the `ayc-portal-auth` project → Storage → create a Blob store,
   and connect it to this project (this is where
   `api/onboarding/upload-photo.js` runs).
2. That's it for code running on Vercel — connected stores authenticate
   via OIDC automatically (no token to copy/paste).

## 4. Email (Resend, free tier — 3,000/month)

1. Create a free account at https://resend.com and verify a sending
   domain (or use their shared test domain while developing).
2. Set in `ayc-portal-admin`'s Vercel env vars (that's where the
   approve/reject emails are sent from):
   - `RESEND_API_KEY`
   - `PORTAL_FROM_EMAIL` — the single config value the spec asked for.
     Currently `no-reply@associationyouthclubs.org`; change this one
     variable (nothing else) when you switch to `no-reply@ayc.tn`.

## 5. Bootstrapping the first national admin(s)

Approval authority can't be self-granted through the app (by design), so
there has to be a bootstrap path for the very first admin:

- Set `PORTAL_BOOTSTRAP_ADMIN_EMAILS` on `ayc-portal-auth` (where
  onboarding submission happens) to a comma-separated list of Google
  account emails, e.g. `PORTAL_BOOTSTRAP_ADMIN_EMAILS=admin@example.com`.
- Anyone signing in with one of those emails is activated immediately
  (skips the pending/approval step) and flagged as a national admin.
- Once at least one admin exists, they can promote others via
  `POST /api/admin/members/set-admin`, and assign granular club roles
  via `POST /api/admin/roles` — you don't need to keep editing this env
  var after the first admin is in.

## 6. Install and deploy

```
npm install   # picks up @neondatabase/serverless, google-auth-library, @vercel/blob
```

Then follow the "Deployment topology" section above — each project
deploys
from the same push, and `vercel.cjs` selects the function allowlist before
Vercel packages the deployment based on its `DEPLOY_TARGET`.

## Entry point

Point people at `https://internes.associationyouthclubs.org/` — the
`portal-edge` project's `vercel.json` rewrites `/` to
`/portal/login`. Everything else in the flow (onboarding, pending
status, admin review) is reached from there.

## What's deliberately NOT built yet

- The personal dashboard, meetings/PV editor, report tracking, training
  cursus, and app shell sidebar from the original brief — `home` is
  a placeholder landing page for now. These will land as their own
  `portal-member` / `portal-officer` service projects per the topology
  table above.
- Per-club membership-approval delegation (spec's "approver(s)"
  concept) — right now, *any* national admin can approve/reject *any*
  pending request, regardless of club. The `membership_approver`
  capability exists in the schema and role system for this, but no
  route currently checks it instead of `requireNationalAdmin` — that's
  part of the officer-facing work still to come.
