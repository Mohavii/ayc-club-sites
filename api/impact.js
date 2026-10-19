// api/impact.js — Youth Impact dashboard backend, served by the Discord BOT project
// (the one that already has GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO).
//
// Called from the internes dashboard (public/portal/impact-admin.html) with a
// short-lived ticket — see api/_lib/impact-ticket.js. Authorization is a Bearer
// token (no cookies), so CORS "*" is safe here, same as chat.js / submit-form.js.
//
//   GET  /api/impact → { events, team, sha }
//   POST /api/impact → body { events, team, sha }  (logic: api/_lib/impact-admin.js)

const { memberFromTicket } = require("./_lib/impact-ticket");
const handle = require("./_lib/impact-admin");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const member = await memberFromTicket(req);
    if (!member) {
      res.status(401).json({ error: "Session expirée. Recharge la page." });
      return;
    }
    let body = {};
    if (req.method === "POST") {
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      } catch {
        res.status(400).json({ error: "Corps JSON invalide." });
        return;
      }
    }
    await handle(req, res, member, body);
  } catch (err) {
    console.error("api/impact error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
