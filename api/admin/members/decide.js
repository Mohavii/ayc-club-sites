// api/admin/members/decide.js
// POST /api/admin/members/decide
// Body: { memberId, decision: "approve" | "reject", rejectionNote? }
// National admins only.

const { requireNationalAdmin } = require("../../_lib/sessions");
const { decideMembership, findMemberById } = require("../../_lib/members-store");
const { sendApprovalEmail, sendRejectionEmail } = require("../../_lib/mailer");

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

  const { memberId, decision, rejectionNote } = body || {};
  if (!memberId || !["approve", "reject"].includes(decision)) {
    res.status(400).json({ error: "Paramètres invalides." });
    return;
  }

  try {
    const target = await findMemberById(memberId);
    if (!target || target.status !== "pending") {
      res.status(404).json({ error: "Demande introuvable ou déjà traitée." });
      return;
    }

    const updated = await decideMembership({
      memberId,
      decision,
      decidedBy: admin.id,
      rejectionNote,
    });

    if (decision === "approve") {
      await sendApprovalEmail(updated);
    } else {
      await sendRejectionEmail(updated);
    }

    res.status(200).json({ ok: true, status: updated.status });
  } catch (err) {
    console.error("admin/members/decide error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
