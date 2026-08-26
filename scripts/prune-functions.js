// prune-functions.js
//
// The bot and the member portal live in one repo but must deploy as TWO
// separate Vercel projects — together their api/*.js route files add up
// to more than Hobby's 12-serverless-function cap. Vercel doesn't support
// per-project vercel.json/.vercelignore on a shared repo, so instead we
// delete whichever half doesn't belong to this deployment, right before
// the build, based on an env var set differently in each project.
//
// Set in each Vercel project's dashboard (Settings -> Environment Variables):
//   Bot project:     DEPLOY_TARGET = bot
//   Portal project:  DEPLOY_TARGET = portal
//
// If DEPLOY_TARGET isn't set at all (e.g. local `npm run build`), nothing
// is pruned — all routes stay, matching the old single-project behavior.
//
// IMPORTANT: this deletes files from the build's working copy only. It
// runs inside Vercel's ephemeral build container, so it never touches
// anything in git — your repo on GitHub is untouched, this only affects
// what actually gets deployed as functions for that one build.

const fs = require("fs");
const path = require("path");

const TARGET = process.env.DEPLOY_TARGET; // "bot" | "portal" | undefined

// Routes that belong to the Discord bot / public club-sites system.
const BOT_ROUTES = ["api/chat.js", "api/interactions.js", "api/submit-form.js", "api/session.js"];

// Routes that belong to the member portal.
const PORTAL_ROUTES = [
  "api/admin/members/decide.js",
  "api/admin/members/pending.js",
  "api/admin/members/set-admin.js",
  "api/auth/google/callback.js",
  "api/auth/google/start.js",
  "api/auth/logout.js",
  "api/onboarding/check-username.js",
  "api/onboarding/me.js",
  "api/onboarding/submit.js",
  "api/onboarding/upload-photo.js",
  "api/schools.js",
];

function removeFiles(files) {
  for (const rel of files) {
    const full = path.join(__dirname, "..", rel);
    if (fs.existsSync(full)) {
      fs.rmSync(full);
      console.log(`prune-functions: removed ${rel} (not part of this deployment)`);
    }
  }
}

// Also remove now-empty directories so Vercel doesn't get confused by
// stray empty folders under api/.
function removeEmptyDirs(startDirs) {
  for (const rel of startDirs) {
    const full = path.join(__dirname, "..", rel);
    let dir = full;
    while (dir.startsWith(path.join(__dirname, "..", "api"))) {
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
  if (TARGET === "bot") {
    removeFiles(PORTAL_ROUTES);
    removeEmptyDirs(PORTAL_ROUTES.map((f) => path.dirname(f)));
    console.log("prune-functions: deploying BOT routes only.");
  } else if (TARGET === "portal") {
    removeFiles(BOT_ROUTES);
    removeEmptyDirs(BOT_ROUTES.map((f) => path.dirname(f)));
    console.log("prune-functions: deploying PORTAL routes only.");
  } else {
    console.log("prune-functions: DEPLOY_TARGET not set — keeping all routes (local/dev build).");
  }
}

main();
