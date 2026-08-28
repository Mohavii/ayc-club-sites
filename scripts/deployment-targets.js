// deployment-targets.js
//
// The same repository is imported by several Vercel projects. Each project
// selects one allowlist in vercel.mjs before Vercel packages functions.

const TARGETS = {
  // Local development: serve every API route from one localhost origin so the
  // whole portal can be tested without the production multi-project proxy split.
  local: [
    "api/chat.js",
    "api/interactions.js",
    "api/submit-form.js",
    "api/session.js",
    "api/portal.js",
    "api/schools.js",
    "api/auth/google/callback.js",
    "api/auth/google/start.js",
    "api/auth/logout.js",
    "api/onboarding/check-username.js",
    "api/onboarding/me.js",
    "api/onboarding/submit.js",
    "api/onboarding/upload-photo.js",
    "api/admin/members.js",
    "api/admin/members/decide.js",
    "api/admin/members/pending.js",
    "api/admin/members/set-admin.js",
    "api/admin/roles.js",
  ],

  bot: ["api/chat.js", "api/interactions.js", "api/submit-form.js", "api/session.js"],

  // Public-facing project: static public/portal/** plus proxy rewrites.
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
    "api/session.js",
    "api/portal.js",
    "api/admin/members.js",
    "api/admin/roles.js",
  ],

  // Filled in as member-facing routes are built.
  "portal-member": [],

  // Filled in as officer-gated routes are built.
  "portal-officer": [],

  "portal-admin": [
    "api/admin/members/decide.js",
    "api/admin/members/pending.js",
    "api/admin/members/set-admin.js",
    "api/admin/roles.js",
  ],
};

function getDeployTarget(env = process.env) {
  // DEPLOY_TARGET is the documented spelling. The lowercase alias keeps
  // existing Vercel projects configured as deploy_target working.
  const raw = env.DEPLOY_TARGET ?? env.deploy_target;
  return raw?.trim() || undefined;
}

module.exports = { TARGETS, getDeployTarget };
