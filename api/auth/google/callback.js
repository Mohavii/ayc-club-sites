// api/auth/google/callback.js
// GET /api/auth/google/callback?code=...&state=...

const { exchangeCodeForIdentity } = require("../../_lib/google-oauth");
const { consumeState } = require("../../_lib/oauth-state");
const { findMemberByGoogleId } = require("../../_lib/members-store");
const { createSession } = require("../../_lib/sessions");
const { createSignupToken } = require("../../_lib/signup-tokens");

function redirect(res, path) {
  res.writeHead(302, { Location: path });
  res.end();
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { code, state, error } = req.query || {};

  if (error) {
    redirect(res, "/portal/login.html?error=google_denied");
    return;
  }

  try {
    const stateOk = await consumeState(state);
    if (!stateOk) {
      redirect(res, "/portal/login.html?error=bad_state");
      return;
    }

    const identity = await exchangeCodeForIdentity(code);
    const existing = await findMemberByGoogleId(identity.googleId);

    if (!existing) {
      await createSignupToken(res, identity);
      redirect(res, "/portal/onboarding.html");
      return;
    }

    await createSession(res, existing.id, req.headers["user-agent"]);

    if (existing.status === "active") {
      redirect(res, "/portal/home.html");
    } else if (existing.status === "pending") {
      redirect(res, "/portal/pending.html");
    } else {
      redirect(res, "/portal/rejected.html");
    }
  } catch (err) {
    console.error("google/callback error:", err);
    redirect(res, "/portal/login.html?error=auth_failed");
  }
};
