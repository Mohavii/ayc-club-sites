// api/admin/impact.js
// GET  /api/admin/impact → { events, sha }
// POST /api/admin/impact → body { events, sha } — saves data/impact-events.json
//
// National admins only. A save is one git commit, which makes the GitHub
// Action rebuild the public Youth Impact page (≈1–2 min). `sha` is the version
// the dashboard loaded: if someone else saved in between, GitHub refuses and
// we ask the admin to reload instead of overwriting their work.
//
// Needs GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH on the
// Vercel project that serves /api/admin (same values as the bot project).

const { requireNationalAdmin } = require("../_lib/sessions");
const { readJsonFile, writeJsonFile } = require("../_lib/store");
const { clean } = require("../_lib/impact");

const FILE = "data/impact-events.json";

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const admin = await requireNationalAdmin(req, res);
  if (!admin) return;

  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
    res.status(500).json({ error: "GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO manquent sur ce projet Vercel." });
    return;
  }

  try {
    if (req.method === "GET") {
      const { data, sha } = await readJsonFile(FILE);
      res.status(200).json({ events: data?.events || [], sha });
      return;
    }

    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      res.status(400).json({ error: "Corps JSON invalide." });
      return;
    }

    let cleaned;
    try {
      cleaned = clean(body);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }

    await writeJsonFile(FILE, cleaned, `Youth Impact : événements mis à jour par ${admin.username}`, body.sha);
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err.status === 409 || err.status === 422) {
      res.status(409).json({ error: "Quelqu'un a modifié les événements entre-temps. Recharge la page puis réessaie." });
      return;
    }
    console.error("admin/impact error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
