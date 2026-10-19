// api/_lib/impact-admin.js
//
// Dashboard backend for the Youth Impact events + team (data/impact-events.json).
// Runs on the Discord BOT Vercel project (see api/impact.js), because that
// project already holds the GitHub credentials.
//
//   GET  → { events, team, sha }
//   POST → body { events, team, sha } saves the file
//
// National admins only. A save is one git commit, which makes the GitHub Action
// rebuild the public page (≈1–2 min). `sha` is the version the dashboard loaded:
// if someone else saved in between, GitHub refuses and we ask the admin to reload.
// Edit-only: existing events / team members can be changed, not added or removed.
//
// Needs GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO (/ GITHUB_BRANCH) — already set on the bot project.

const { readJsonFile, writeJsonFile } = require("./store");
const { clean } = require("./impact");

const FILE = "data/impact-events.json";

module.exports = async function impactAdmin(req, res, member, body) {
  if (!member.is_national_admin) {
    res.status(403).json({ error: "Réservé aux admins nationaux." });
    return;
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
    res.status(500).json({ error: "GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO manquent sur le projet Vercel du bot." });
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    if (req.method === "GET") {
      const { data, sha } = await readJsonFile(FILE);
      res.status(200).json({ events: data?.events || [], team: data?.team || [], sha });
      return;
    }

    let cleaned;
    try {
      cleaned = clean(body);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }

    const { data: current } = await readJsonFile(FILE);
    const ids = (list) => (list || []).map((x) => x.id).join();
    if (ids(current?.events) !== ids(cleaned.events) || (current?.team && ids(current.team) !== ids(cleaned.team))) {
      res.status(400).json({ error: "Ajouter ou supprimer un événement ou un membre n'est pas possible depuis le tableau de bord." });
      return;
    }

    await writeJsonFile(FILE, cleaned, `Youth Impact : mise à jour par ${member.username}`, body.sha);
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err.status === 409 || err.status === 422) {
      res.status(409).json({ error: "Quelqu'un a modifié les données entre-temps. Recharge la page puis réessaie." });
      return;
    }
    console.error("impact-admin error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
