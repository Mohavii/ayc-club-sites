// prune-functions.js
//
// This repo deploys as MULTIPLE Vercel projects sharing one codebase —
// each with its own 12-serverless-function budget (Hobby plan). Vercel
// doesn't support per-project vercel.json/.vercelignore on a shared
// repo, so instead we delete every api/*.js route that doesn't belong
// to THIS deployment, right before the build, based on an env var set
// differently in each project's dashboard.
//
// Set DEPLOY_TARGET in each Vercel project (Settings -> Environment
// Variables) to one of the keys in TARGETS below. If unset (e.g. a
// local `npm run build`), nothing is pruned — every route stays.
//
// IMPORTANT: this deletes files from the build's ephemeral working
// copy only. It never touches git / GitHub — only what gets deployed
// as functions for that one build.
//
// ---------------------------------------------------------------------
// Portal projects are split by WHO calls the routes, not by feature —
// that boundary happens to also be the permission boundary, which
// keeps each project's own guard logic simpler:
//
//   portal-auth    : everyone, unauthenticated or just-authenticated.
//                    Google OAuth, sessions, onboarding, schools list.
//   portal-member  : any ACTIVE member, acting on their own behalf —
//                    own profile, own dashboard, own tasks/training,
//                    RSVPs, read-only report views.
//   portal-officer : gated to whoever holds a specific club role or
//                    capability grant — PV editing, meeting creation,
//                    report validation, acting on membership requests.
//   portal-admin   : national-admin only — assigning/revoking roles
//                    and capabilities, approving/rejecting membership
//                    requests, granting national-admin itself.
//
// A single logical "edge" Vercel project owns the real domain
// (internes.associationyouthclubs.org) and PROXIES to these via
// rewrites in ITS OWN vercel.json to each service project's
// <name>.vercel.app URL — see PORTAL-SETUP.md for that wiring. This
// file only controls which routes exist inside each service project's
// own deployment.
// ---------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const TARGET = process.env.DEPLOY_TARGET; // one of the TARGETS keys below, or undefined

const TARGETS = {
  bot: ["api/chat.js", "api/interactions.js", "api/submit-form.js", "api/session.js"],

  // The public-facing project for internes.associationyouthclubs.org.
  // Owns the domain, serves public/portal/**, and PROXIES /api/* to the
  // other portal-* service projects via rewrites in vercel.json. Keeps
  // zero api/ routes of its own — it's pure static + proxy.
  "portal-edge": [],

  "portal-auth": [
    "api/auth/google/callback.js",
    "api/auth/google/start.js",
    "api/auth/logout.js",
    "api/onboarding/check-username.js",
    "api/onboarding/me.js",
    "api/onboarding/submit.js",
    "api/onboarding/upload-photo.js",
    "api/schools.js",
  ],

  // Filled in as member-facing routes are built (own profile,
  // dashboard, tasks, training portfolio, RSVPs, read-only reports).
  "portal-member": [],

  // Filled in as officer-gated routes are built (PV editor, meeting
  // creation, report validation, membership-approval action).
  "portal-officer": [],

  // National-admin-only routes.
  "portal-admin": [
    "api/admin/members/decide.js",
    "api/admin/members/pending.js",
    "api/admin/members/set-admin.js",
    "api/admin/roles.js",
  ],
};

function allKnownRoutes() {
  return Object.values(TARGETS).flat();
}

function removeFiles(files) {
  for (const rel of files) {
    const full = path.join(__dirname, "..", rel);
    if (fs.existsSync(full)) {
      fs.rmSync(full);
      console.log(`prune-functions: removed ${rel} (not part of this deployment)`);
    }
  }
}

function removeEmptyDirs(startDirs) {
  const apiRoot = path.join(__dirname, "..", "api");
  for (const rel of startDirs) {
    let dir = path.join(__dirname, "..", rel);
    while (dir.startsWith(apiRoot)) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    }
  }
}

function main() {
  if (!TARGET) {
    console.log("prune-functions: DEPLOY_TARGET not set — keeping all routes (local/dev build).");
    return;
  }
  if (!TARGETS[TARGET]) {
    console.error(
      `prune-functions: unknown DEPLOY_TARGET "${TARGET}". Valid values: ${Object.keys(TARGETS).join(", ")}`
    );
    process.exit(1);
  }

  const keep = new Set(TARGETS[TARGET]);
  const toRemove = allKnownRoutes().filter((route) => !keep.has(route));

  removeFiles(toRemove);
  removeEmptyDirs(toRemove.map((f) => path.dirname(f)));
  console.log(`prune-functions: deploying "${TARGET}" routes only (${keep.size} function(s) kept).`);
}

main();
