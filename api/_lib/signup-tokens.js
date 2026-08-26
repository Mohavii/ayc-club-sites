// signup-tokens.js
//
// After Google confirms someone's identity but before they've chosen a
// username/display name/school, we don't yet have a member record for
// them. This token (held in a cookie, hashed in the DB) is the only thing
// proving "this browser really did just complete Google sign-in as
// google_id X" across the redirect to the onboarding page.

const { sql } = require("./db");
const { randomToken, hashToken } = require("./tokens");
const { parseCookies, appendSetCookie, serializeCookie, clearCookie } = require("./cookies");

const SIGNUP_COOKIE = "ayc_portal_signup";
const SIGNUP_TTL_MINUTES = 30;

async function createSignupToken(res, identity) {
  const rawToken = randomToken(32);
  const tokenHash = hashToken(rawToken);
  const db = sql();
  await db`
    insert into portal_signup_tokens (token_hash, google_id, email, google_name, google_picture, expires_at)
    values (
      ${tokenHash}, ${identity.googleId}, ${identity.email},
      ${identity.name || null}, ${identity.picture || null},
      now() + (${SIGNUP_TTL_MINUTES} || ' minutes')::interval
    )
  `;
  appendSetCookie(
    res,
    serializeCookie(SIGNUP_COOKIE, rawToken, { maxAgeSeconds: SIGNUP_TTL_MINUTES * 60 })
  );
}

async function getSignupIdentity(req) {
  const cookies = parseCookies(req);
  const rawToken = cookies[SIGNUP_COOKIE];
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const db = sql();
  const rows = await db`
    select * from portal_signup_tokens
    where token_hash = ${tokenHash} and expires_at > now()
  `;
  if (rows.length === 0) return null;
  return { ...rows[0], _tokenHash: tokenHash };
}

async function consumeSignupToken(res, tokenHash) {
  const db = sql();
  await db`delete from portal_signup_tokens where token_hash = ${tokenHash}`;
  appendSetCookie(res, clearCookie(SIGNUP_COOKIE));
}

module.exports = { createSignupToken, getSignupIdentity, consumeSignupToken };
