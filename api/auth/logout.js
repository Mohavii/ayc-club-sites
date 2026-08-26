// api/auth/logout.js
// POST /api/auth/logout

const { destroySession } = require("../_lib/sessions");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    await destroySession(req, res);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("logout error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
