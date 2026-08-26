// google-oauth.js
//
// Standard Google OAuth 2.0 authorization-code flow. Uses google-auth-library
// only for verifying the ID token (signature, issuer, audience, expiry
// against Google's rotating certs) — reinventing that check by hand is a
// common source of auth bugs, so we lean on the maintained library instead.
//
// Env vars required:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REDIRECT_URI   — must exactly match a redirect URI registered
//                           in the Google Cloud OAuth client, e.g.
//                           https://portal.associationyouthclubs.org/api/auth/google/callback

const { OAuth2Client } = require("google-auth-library");

function client() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Where we send the browser to start sign-in. `state` must be a random,
// single-use value the caller has already stored server-side (see
// oauth-state.js) so the callback can confirm this redirect wasn't forged.
function buildAuthUrl(state) {
  return client().generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
}

// Exchanges the one-time `code` Google sent back for tokens, verifies the
// ID token, and returns the identity fields we care about.
async function exchangeCodeForIdentity(code) {
  const oauth2 = client();
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.id_token) {
    throw new Error("Google did not return an id_token.");
  }

  const ticket = await oauth2.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();

  if (!payload || !payload.sub) {
    throw new Error("Could not verify Google identity token.");
  }
  if (payload.email_verified === false) {
    throw new Error("Google account email is not verified.");
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || "",
    picture: payload.picture || null,
  };
}

module.exports = { buildAuthUrl, exchangeCodeForIdentity };
