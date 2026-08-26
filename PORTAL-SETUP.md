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

Scope of this build: **Google sign-in, account creation (username,
display name, photo, school), and national-admin approval/rejection.**
Nothing else (dashboard, meetings, reports, training, granular per-club
roles) is built yet — that's later, separate work.

## 1. Database (Neon Postgres, free tier)

1. Create a free project at https://neon.tech.
2. Copy the connection string it gives you (starts `postgresql://...`).
   Set it as `DATABASE_URL` in Vercel's project environment variables.
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

## 2. Google OAuth

1. In Google Cloud Console, create an OAuth 2.0 Client ID (Web
   application).
2. Authorized redirect URI: `https://<your-domain>/api/auth/google/callback`
3. Set these in Vercel:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` — must exactly match what you registered above.

## 3. Vercel Blob (profile pictures)

1. In your Vercel project → Storage → create a Blob store, and connect it
   to this project.
2. That's it for code running on Vercel — connected stores authenticate
   via OIDC automatically (no token to copy/paste). If you ever need to
   run the upload code from outside Vercel, use the `BLOB_READ_WRITE_TOKEN`
   Vercel also adds as a fallback.

## 4. Email (Resend, free tier — 3,000/month)

1. Create a free account at https://resend.com and verify a sending
   domain (or use their shared test domain while developing).
2. Set in Vercel:
   - `RESEND_API_KEY`
   - `PORTAL_FROM_EMAIL` — the single config value the spec asked for.
     Currently `no-reply@associationyouthclubs.org`; change this one
     variable (nothing else) when you switch to `no-reply@ayc.tn`.

## 5. Bootstrapping the first national admin(s)

Approval authority can't be self-granted through the app (by design), so
there has to be a bootstrap path for the very first admin:

- Set `PORTAL_BOOTSTRAP_ADMIN_EMAILS` to a comma-separated list of Google
  account emails, e.g. `PORTAL_BOOTSTRAP_ADMIN_EMAILS=admin@example.com`.
- Anyone signing in with one of those emails is activated immediately
  (skips the pending/approval step) and flagged as a national admin.
- Once at least one admin exists, they can promote others from
  `public/portal/admin-review.html`-adjacent tooling via
  `POST /api/admin/members/set-admin` — you don't need to keep editing
  this env var after the first admin is in.
- You can remove/shrink this env var once you have admins you trust
  bootstrapped in the database; it's only a bootstrap mechanism, not a
  permanent backdoor (matching emails are simply admins from then on
  until someone changes the flag).

## 6. Install and deploy

```
npm install   # picks up @neondatabase/serverless, google-auth-library, @vercel/blob
```

Then deploy as usual (this repo already deploys to Vercel for the
Discord bot's API routes — the new `/api/...` routes and
`/public/portal/...` pages deploy the same way, no separate project
needed).

## Entry point

Point people at `/portal/login.html`. That's the only new thing users
need to know about; everything else in the flow (onboarding, pending
status, admin review) is reached from there.

## What's deliberately NOT built yet

- The full per-club, per-capability role system (Président, Secrétaire,
  report validators, membership approvers *per club*) — this phase only
  has one role, "national admin," which gates validation. Building the
  granular system is a separate task.
- The personal dashboard, meetings/PV editor, report tracking, training
  cursus, and app shell sidebar from the original brief — `home.html` is
  a placeholder landing page for now.
- Per-club membership-approval delegation (spec's "approver(s)" concept)
  — right now, *any* national admin can approve/reject *any* pending
  request, regardless of club. Scoping that down is part of the later
  roles work.
