// api/_lib/impact-ticket.js
//
// The dashboard page lives on the internes domain (session cookie), but the code
// that writes to GitHub lives on the Discord bot's Vercel project (which already
// has GITHUB_TOKEN). The two don't share cookies, so we hand the browser a
// short-lived "ticket" instead:
//
//   1. portal project  POST /api/portal?action=impact_ticket   (cookie session, admin only)
//        → inserts a 15-minute row in portal_sessions, returns the raw token
//   2. bot project     /api/impact  with  Authorization: Bearer <token>
//        → looks the token up in the SAME database (DATABASE_URL is shared by every project)
//
// No new secret, no new table. A ticket only works on /api/impact.

const { sql } = require("./db");
const { randomToken, hashToken } = require("./tokens");

const TICKET_AGENT = "impact-ticket";
const TICKET_MINUTES = 15;

// Portal side: called from api/portal.js (member is already a verified active member).
async function issueTicket(res, member) {
  if (!member.is_national_admin) {
    res.status(403).json({ error: "Réservé aux admins nationaux." });
    return;
  }
  const db = sql();
  await db`delete from portal_sessions where user_agent = ${TICKET_AGENT} and expires_at < now()`;
  const token = randomToken(32);
  await db`
    insert into portal_sessions (member_id, token_hash, expires_at, user_agent)
    values (${member.id}, ${hashToken(token)}, now() + (${TICKET_MINUTES} || ' minutes')::interval, ${TICKET_AGENT})
  `;
  res.status(200).json({ token, minutes: TICKET_MINUTES });
}

// Bot side: returns the active national admin behind the Bearer ticket, or null.
async function memberFromTicket(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers?.authorization || "");
  if (!m) return null;
  const rows = await sql()`
    select m.* from portal_sessions s
    join portal_members m on m.id = s.member_id
    where s.token_hash = ${hashToken(m[1])} and s.user_agent = ${TICKET_AGENT}
      and s.expires_at > now() and m.status = 'active' and m.is_national_admin = true
  `;
  return rows[0] || null;
}

module.exports = { issueTicket, memberFromTicket };
