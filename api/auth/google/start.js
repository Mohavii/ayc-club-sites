// api/auth/google/start.js
// GET /api/auth/google/start — the "Se connecter" button points here.

const { buildAuthUrl } = require("../../_lib/google-oauth");
const { createState } = require("../../_lib/oauth-state");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const state = await createState();
    const url = buildAuthUrl(state);
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    console.error("google/start error:", err);
    res.status(500).send("Impossible de démarrer la connexion Google.");
  }
};
