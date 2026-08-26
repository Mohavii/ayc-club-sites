// sessions.js
//
// DB-backed sessions (not stateless JWTs). Rationale: this app's whole
// point in this phase is "a national admin's decision changes what a
// member can do" — approval, rejection, and (later) role grants all need
// to take effect on the member's very next request. A JWT would keep
// asserting stale claims until it expires. A session row we can check
// (and delete) on every request doesn't have that problem, at the cost of
// one indexed DB lookup per request — a fine trade at this scale.

const { sql } = require("./db");
const { randomToken, hashToken } = require("./tokens");
const { parseCookies, appendSetCookie, serializeCookie, clearCookie } = require("./cookies");

const SESSION_COOKIE = "ayc_portal_session";
const SESSION_TTL_DAYS = 30;

async function createSession(res, memberId, userAgent) {
  const rawToken = randomToken(32);
  const tokenHash = hashToken(rawToken);
  const db = sql();
  await db`
    insert into portal_sessions (member_id, token_hash, expires_at, user_agent)
    values (${memberId}, ${tokenHash}, now() + (${SESSION_TTL_DAYS} || ' days')::interval, ${userAgent || null})
  `;
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE, rawToken, { maxAgeSeconds: SESSION_TTL_DAYS * 24 * 60 * 60 })
  );
}

// Returns the current member row (or null). Also transparently drops
// expired sessions it happens to find.
async function getSessionMember(req) {
  const cookies = parseCookies(req);
  const rawToken = cookies[SESSION_COOKIE];
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const db = sql();
  const rows = await db`
    select m.*, s.expires_at as session_expires_at
    from portal_sessions s
    join portal_members m on m.id = s.member_id
    where s.token_hash = ${tokenHash}
  `;
  if (rows.length === 0) return null;

  const { session_expires_at, ...member } = rows[0];
  if (new Date(session_expires_at) < new Date()) {
    await db`delete from portal_sessions where token_hash = ${tokenHash}`;
    return null;
  }

  return member;
}

async function destroySession(req, res) {
  const cookies = parseCookies(req);
  const rawToken = cookies[SESSION_COOKIE];
  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    const db = sql();
    await db`delete from portal_sessions where token_hash = ${tokenHash}`;
  }
  appendSetCookie(res, clearCookie(SESSION_COOKIE));
}

// ---- API route guards -------------------------------------------------

// Any signed-in member, regardless of status (pending/active/rejected).
// Used by endpoints like "am I still pending?" that a pending member must
// be able to call.
async function requireMember(req, res) {
  const member = await getSessionMember(req);
  if (!member) {
    res.status(401).json({ error: "Non connecté." });
    return null;
  }
  return member;
}

// Only a fully active member.
async function requireActiveMember(req, res) {
  const member = await requireMember(req, res);
  if (!member) return null;
  if (member.status !== "active") {
    res.status(403).json({ error: "Compte pas encore actif." });
    return null;
  }
  return member;
}

async function requireNationalAdmin(req, res) {
  const member = await requireActiveMember(req, res);
  if (!member) return null;
  if (!member.is_national_admin) {
    res.status(403).json({ error: "Réservé aux admins nationaux." });
    return null;
  }
  return member;
}

module.exports = {
  SESSION_COOKIE,
  createSession,
  getSessionMember,
  destroySession,
  requireMember,
  requireActiveMember,
  requireNationalAdmin,
};
