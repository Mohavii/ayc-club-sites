// api/admin/members/decide.js
// POST /api/admin/members/decide
// Body: { memberId, decision: "approve" | "reject", rejectionNote? }
// National admins or the target club's membership_approver.

const { sql } = require("../../_lib/db");
const { requireActiveMember } = require("../../_lib/sessions");
const { hasCapability } = require("../../_lib/roles");
const { decideMembership } = require("../../_lib/members-store");
const { sendApprovalEmail, sendRejectionEmail } = require("../../_lib/mailer");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const approver = await requireActiveMember(req, res);
  if (!approver) return;
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { return res.status(400).json({ error: "Corps JSON invalide." }); }
  const { memberId, decision, rejectionNote } = body;
  if (!memberId || !["approve", "reject"].includes(decision)) return res.status(400).json({ error: "Paramètres invalides." });
  try {
    const db = sql();
    const rows = await db`select m.*, s.name as school_name from portal_members m left join portal_schools s on s.id=m.school_id where m.id=${memberId} and m.status='pending'`;
    const target = rows[0];
    if (!target) return res.status(404).json({ error: "Demande introuvable ou déjà traitée." });
    if (!approver.is_national_admin && !(await hasCapability(approver.id, target.school_id, "membership_approver"))) return res.status(403).json({ error: "Vous n'êtes pas approbateur·rice de ce club." });
    const updated = await decideMembership({ memberId, decision, decidedBy: approver.id, rejectionNote });
    if (!updated) return res.status(409).json({ error: "Cette demande a déjà été traitée." });
    if (decision === "approve") await sendApprovalEmail(updated);
    else await sendRejectionEmail(updated);
    return res.status(200).json({ ok: true, status: updated.status });
  } catch (err) {
    console.error("admin/members/decide error:", err);
    return res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
