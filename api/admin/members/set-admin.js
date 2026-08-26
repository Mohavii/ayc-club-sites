// api/admin/members/set-admin.js
// POST /api/admin/members/set-admin
// Body: { memberId, isAdmin: boolean }
// National admins only. This is deliberately the ONLY role-management
// capability this phase ships — enough for the bootstrap admin(s) to grow
// the admin set without editing the database by hand. The full per-club,
// per-capability role system (Président/Secrétaire/report-validator/etc.)
// is a separate, later phase.

const { requireNationalAdmin } = require("../../_lib/sessions");
const { setNationalAdmin, findMemberById } = require("../../_lib/members-store");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const admin = await requireNationalAdmin(req, res);
  if (!admin) return;

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ error: "Corps JSON invalide." });
    return;
  }

  const { memberId, isAdmin } = body || {};
  if (!memberId || typeof isAdmin !== "boolean") {
    res.status(400).json({ error: "Paramètres invalides." });
    return;
  }

  try {
    const target = await findMemberById(memberId);
    if (!target || target.status !== "active") {
      res.status(404).json({ error: "Membre introuvable ou pas encore actif." });
      return;
    }

    const updated = await setNationalAdmin(memberId, isAdmin);
    res.status(200).json({ ok: true, isNationalAdmin: updated.is_national_admin });
  } catch (err) {
    console.error("admin/members/set-admin error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
